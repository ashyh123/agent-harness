/** Paired blog-loop experiment; production tools/reviewer, frozen sources and real isolated vaults. */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PythonBridge, ROOT, loadLocalEnv, redact } from './bridge.js';
import { BlogAgent } from './blog_agent.js';
import { ObsidianKnowledge } from './obsidian_knowledge.js';
import { runOmpBlog } from './omp_blog_runner.js';
import { SKILLS_ROOT } from './skills.js';

loadLocalEnv();
(globalThis as any).AI_SDK_LOG_WARNINGS = false;
const input = process.argv[2];
if (!input) throw new Error('用法：tsx verify_omp_blog.ts /absolute/path/to/manifest.json [--pilot]');
const manifest = JSON.parse(await readFile(input, 'utf8'));
const config = { ...manifest.config, temperature: 0 };
const directory = await mkdtemp(join(await mkdir(join(ROOT, 'reports/omp-blog'), { recursive: true }).then(() => join(ROOT, 'reports/omp-blog')), 'paired-'));
const vaultRoot = process.env.MINIMAL_AGENT_OBSIDIAN_VAULT ?? join(process.env.HOME!, 'Documents/Obsidian/Agent 博客阅读');
const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
const vaultBase = join(vaultRoot, 'OMP对照', date, directory.split('/').at(-1)!);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const pilot = process.argv.includes('--pilot');
const rows: any[] = [];
await writeFile(join(directory, 'manifest.json'), JSON.stringify({ ...manifest, repeats: pilot ? 1 : 2, pilot,
  config, vault_base: vaultBase, original_manifest: input, omp_version: '18.9.2',
  controls: 'OMP native loop vs original BlogAgent/MinimalHarness LangGraph. Same four Python tools, Skill/system policy, DeepSeek model, temperature=0, output cap512, model/tool/time limits, pre-save evidence gate, verified-tool stop and common post-save concept indexing. Frozen previous-day vendor captures; no live-web reliability comparison. OMP extension replaces default coding prompt and disables unrelated built-ins/skills/rules/advisor/memory/fallback. Local authenticated model adapter enforces caps, forwards native SSE buffered until usage receipt, canonicalizes same tool schemas. OMP context policy uses soft/12k threshold, native retains current legacy policy; estimators and strategies differ. No persistent/global OMP configuration changes. Sequential alternating order, fresh context/independent real sub-vault. Model input/caches differ; no forced cache state. Full content/concept acceptance requires subsequent source review.',
}, null, 2));
console.log(`结果目录：${directory}`);
for (let repeat = 1; repeat <= (pilot ? 1 : 2); repeat++) {
  for (const item of pilot ? manifest.sources.slice(0, 1) : repeat === 1 ? manifest.sources : [...manifest.sources].reverse()) {
    for (const mode of pilot ? ['omp'] : repeat === 1 ? ['native', 'omp'] : ['omp', 'native']) {
      const id = `${item.id}-${mode}-r${repeat}`;
      const vault = join(vaultBase, id), runDir = join(directory, id);
      await mkdir(runDir, { recursive: true });
      const bridge = new PythonBridge({ ...process.env, MINIMAL_AGENT_TASK_COORDINATION: '0',
        MINIMAL_AGENT_CODEX_DELEGATION: '0', MINIMAL_AGENT_OBSIDIAN_VAULT: vault });
      console.log(`开始 ${id}`);
      try {
        await bridge.request('describe');
        const start = performance.now();
        const fixtures = { read_webpage: item.source };
        const result = mode === 'omp' ? await runOmpBlog(bridge, config, item.url, runDir, fixtures)
          : await new BlogAgent(bridge, config, { skills: SKILLS_ROOT, runs: runDir })
            .run(item.url, undefined, { fixtures });
        const loopSeconds = (performance.now() - start) / 1000;
        const trace = await bridge.request('trace');
        const receipt = result.receipt;
        const draft = trace.events.filter((e: any) => e.type === 'tool' && e.name === 'save_obsidian_blog').at(-1)?.arguments;
        let graph: any = null, graphError: string | null = null;
        const indexUsage: any[] = [];
        const indexFetch: typeof fetch = async (request, init) => {
          const response = await fetch(request, init);
          const body = await response.clone().json();
          indexUsage.push(body.usage ?? null);
          return response;
        };
        if (result.saved) {
          try { graph = await new ObsidianKnowledge(vault, config, indexFetch).index(receipt.note_path); }
          catch (e) { graphError = (e as Error).message; }
        }
        let filesVerified = false, linksVerified = false;
        if (receipt) {
          const note = await readFile(receipt.note_path, 'utf8');
          filesVerified = sha(note) === receipt.sha256 && note.includes(item.url)
            && ['summary', 'takeaway', 'evidence_quote'].every(k => typeof draft?.[k] === 'string' && note.includes(draft[k]));
        }
        if (graph) {
          const state = JSON.parse(await readFile(join(vault, '知识图谱/.index.json'), 'utf8'));
          linksVerified = true;
          for (const file of Object.keys(state.files)) {
            const content = await readFile(join(vault, file), 'utf8');
            for (const m of content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g))
              await readFile(join(vault, m[1] + '.md'), 'utf8');
          }
        }
        const row = { id, mode, case: item.id, repeat, saved: result.saved, files_verified: filesVerified,
          graph_verified: linksVerified, loop_elapsed_seconds: loopSeconds,
          total_elapsed_seconds: (performance.now() - start) / 1000,
          model_requests: trace.model_requests, tool_calls: trace.tool_calls,
          input_tokens: trace.events.reduce((n: number, e: any) => n + (e.usage?.prompt_tokens ?? 0), 0),
          output_tokens: trace.events.reduce((n: number, e: any) => n + (e.usage?.completion_tokens ?? 0), 0),
          cache_hit_tokens: trace.events.reduce((n: number, e: any) => n + (e.usage?.prompt_cache_hit_tokens ?? 0), 0),
          loop_tokens: trace.events.reduce((n: number, e: any) => n + (e.usage?.total_tokens ?? 0), 0),
          indexing_tokens: indexUsage.reduce((n, u) => n + (u?.total_tokens ?? 0), 0),
          indexing_requests: indexUsage.length, indexing_usage_complete: indexUsage.every(u => !!u),
          graph, graph_error: graphError,
          error: mode === 'omp' ? (result as any).error : (result as any).record.result?.error ?? (result as any).record.harness_error,
          draft, receipt, tool_order: trace.events.filter((e: any) => e.type === 'tool').map((e: any) => e.name),
          source_verified: trace.events.filter((e: any) => e.type === 'tool' && e.name === 'read_webpage')
            .some((e: any) => e.arguments.url === item.url && e.result.document_id === item.document_id && sha(e.result.content) === item.preview_sha256),
          semantic_review: 'pending', conceptual_review: 'pending',
        };
        rows.push(row);
        await writeFile(join(runDir, 'result.json'), redact(JSON.stringify({ row, result, trace }, null, 2)));
        await writeFile(join(directory, 'results.json'), redact(JSON.stringify(rows, null, 2)));
        console.log(`${id}: saved=${row.saved}, graph=${row.graph_verified}, tokens=${row.loop_tokens}+${row.indexing_tokens}, seconds=${row.total_elapsed_seconds.toFixed(2)}${row.error ? ', error='+row.error : ''}`);
      } finally { bridge.close(); }
    }
  }
}
console.log(`完成：${directory}`);
