/** Paired live benchmark; extraction frozen once per URL, real per-run vault writes.
 * Both strategies include the production evidence reviewer in their execution budget.
 * Independent source review is recorded separately after execution.
 */
import { mkdir, mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { BlogAgent } from './blog_agent.js';
import { BlogWorkflow } from './blog_workflow.js';
import { PythonBridge, ROOT, loadLocalEnv, redact } from './bridge.js';
import { SKILLS_ROOT } from './skills.js';
import type { Configuration } from './execution_runtime.js';

const cases = [
  { id: 'anthropic', url: 'https://www.anthropic.com/engineering/managed-agents',
    core_facts: ['session/harness/sandbox stable interfaces', 'independent replacement and failure recovery'],
    critical_qualifiers: ['VPC originally allowed peering or self-hosting; not impossible', 'durable session does not mean infinite model context'] },
  { id: 'openai', url: 'https://openai.com/index/new-tools-for-building-agents/',
    core_facts: ['Responses API and web/file/computer tools', 'Agents SDK orchestration and observability'],
    critical_qualifiers: ['article release-time plans are not current live status', 'no separate API fee does not mean free model and tools'] },
  { id: 'google', url: 'https://blog.google/innovation-and-ai/technology/developers-tools/expanding-managed-agents-gemini-api/',
    core_facts: ['background tasks return ID for polling and reconnecting', 'remote MCP/custom functions/credential refresh'],
    critical_qualifiers: ['custom functions use requires_action and client execution', 'credential refresh preserves existing environment state'] },
];
const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

async function prepare() {
  loadLocalEnv();
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('请配置DEEPSEEK_API_KEY');
  const root = join(ROOT, 'reports/blog-workflow');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'paired-'));
  const bridge = new PythonBridge({ ...process.env, MINIMAL_AGENT_TASK_COORDINATION: '0', MINIMAL_AGENT_CODEX_DELEGATION: '0' });
  try {
    const config = await bridge.request<Configuration>('describe');
    config.temperature = 0;
    const sources: any[] = [];
    for (const item of cases) {
      const started = performance.now();
      let source = await bridge.request('capture_tool', { name: 'read_webpage', arguments: { url: item.url } });
      let preparation = 'live_capture';
      if (source.error) {
        const snapshots = join(ROOT, 'reports/webpage-snapshots');
        const documents = await Promise.all((await readdir(snapshots)).filter(f => f.endsWith('.json')).map(async f =>
          ({ id: f.slice(0, -5), document: JSON.parse(await readFile(join(snapshots, f), 'utf8')) })));
        const found = documents.find(d => d.document.url === item.url);
        if (!found) throw new Error(`抓取失败且无快照 ${item.id}: ${source.error.code}`);
        preparation = `cached_snapshot_after_${source.error.code}`;
        const d = found.document;
        source = { url: d.url, title: d.title, document_id: found.id, content: d.content.slice(0, 10000),
          total_chars: d.content.length, content_format: 'markdown', truncated: d.content.length > 10000,
          completeness: 'not_verified', coverage_note: d.coverage_note };
      }
      sources.push({ ...item, source, preparation, preparation_seconds: (performance.now() - started) / 1000,
        preview_sha256: sha(source.content), document_id: source.document_id });
    }
    const vault = process.env.MINIMAL_AGENT_OBSIDIAN_VAULT
      ?? join(process.env.HOME!, 'Documents/Obsidian/Agent 博客阅读');
    const manifest = { config, sources, repeats: 3, created_at: new Date().toISOString(),
      vault_root: join(vault, '工作流对照', new Date().toISOString().slice(0, 10), directory.split('/').at(-1)!),
      controls: 'Same model, temperature=0, per-call output cap, total model/tool/time budgets, Skill and real save tool. Each URL captured once then read_webpage replays exactly that preview. Both may read the same frozen snapshot. Both include the production evidence reviewer in the original budget. Fresh context and isolated vault per run, sequential alternating order. Timing excludes common network preparation and Python startup. Fixed workflow omits tool schemas and routing turns by design. Independent semantic review separately against the frozen full source; quick-summary scope, not full-article coverage. No defaults changed.',
      rubric_locked_before_runs: true,
      review_rule: ['summary factual statements supported by source; preserve relevant conditions; no major factual error',
        'takeaway explicitly distinguishes inference', 'quote supports central summary, not merely string membership',
        'real file readback/hash/source/draft matches', 'summary length 100–180 and takeaway 40–90 are separate editorial diagnostics'],
    };
    await writeFile(join(directory, 'manifest.json'), redact(JSON.stringify(manifest, null, 2)) + '\n');
    console.log(directory);
  } finally { bridge.close(); }
}

async function run(directory: string) {
  loadLocalEnv();
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  const rows: any[] = [];
  for (let repeat = 1; repeat <= manifest.repeats; repeat++) {
    for (const item of repeat % 2 ? manifest.sources : [...manifest.sources].reverse()) {
      for (const mode of repeat % 2 ? ['workflow', 'agent'] : ['agent', 'workflow']) {
        const id = `${item.id}-${mode}-r${repeat}`;
        const vault = join(manifest.vault_root, id);
        const bridge = new PythonBridge({ ...process.env, MINIMAL_AGENT_TASK_COORDINATION: '0',
          MINIMAL_AGENT_CODEX_DELEGATION: '0', MINIMAL_AGENT_OBSIDIAN_VAULT: vault });
        console.log(`开始 ${id}`);
        try {
          await bridge.request('describe'); // exclude equal Python process startup
          const started = performance.now();
          const fixtures = { read_webpage: item.source };
          const result = mode === 'agent'
            ? await new BlogAgent(bridge, manifest.config, { skills: SKILLS_ROOT, runs: join(directory, 'runs') })
              .run(item.url, undefined, { fixtures })
            : await new BlogWorkflow(bridge, manifest.config).run(item.url, { fixtures });
          const elapsed_seconds = (performance.now() - started) / 1000;
          const trace = await bridge.request('trace');
          const saving = trace.events.filter((e: any) => e.type === 'tool' && e.name === 'save_obsidian_blog');
          const receipt = result.receipt;
          const draft = saving.at(-1)?.arguments ?? (result as any).draft;
          let note = '', original = '';
          if (receipt) { note = await readFile(receipt.note_path, 'utf8'); original = await readFile(receipt.original_path, 'utf8'); }
          const snapshot = JSON.parse(await readFile(join(ROOT, 'reports/webpage-snapshots', `${item.document_id}.json`), 'utf8'));
          const file_verified = !!receipt && sha(note) === receipt.sha256
            && note.includes(item.source.document_id) && note.includes(item.source.url)
            && ['summary', 'takeaway', 'evidence_quote'].every(k => typeof draft?.[k] === 'string' && note.includes(draft[k]))
            && original.includes(item.source.url) && original.includes(snapshot.content);
          const sourceReads = trace.events.filter((e: any) => e.type === 'tool' && e.name === 'read_webpage');
          const source_verified = sourceReads.length > 0 && sourceReads
            .every((e: any) => e.arguments.url === item.url && e.result.document_id === item.document_id && sha(e.result.content) === item.preview_sha256);
          const evidence_reviews = trace.events.filter((e: any) => e.type === 'blog_review').map((e: any) => e.review);
          const row = { id, mode, case: item.id, repeat, saved: result.saved, file_verified, source_verified,
            elapsed_seconds, model_requests: trace.model_requests, tool_calls: trace.tool_calls,
            input_tokens: trace.events.reduce((n: number, e: any) => n + (e.usage?.prompt_tokens ?? 0), 0),
            output_tokens: trace.events.reduce((n: number, e: any) => n + (e.usage?.completion_tokens ?? 0), 0),
            total_tokens: trace.events.reduce((n: number, e: any) => n + (e.usage?.total_tokens ?? 0), 0),
            summary_chars: draft?.summary?.length ?? null, takeaway_chars: draft?.takeaway?.length ?? null,
            draft, receipt, evidence_reviews,
            review_model_requests: trace.events.filter((e: any) => e.type === 'model' && e.kind === 'blog_evidence_review').length,
            error: (result as any).error ?? (result as any).record?.result?.error ?? null,
            tool_order: trace.events.filter((e: any) => e.type === 'tool').map((e: any) => e.name),
            semantic_review: 'pending' };
          rows.push(row);
          await writeFile(join(directory, `${id}.json`), redact(JSON.stringify({ result, trace }, null, 2)) + '\n');
          console.log(`${id}: saved=${row.saved}, tokens=${row.total_tokens}, seconds=${elapsed_seconds.toFixed(2)}`);
        } finally { bridge.close(); }
        await writeFile(join(directory, 'results.json'), redact(JSON.stringify(rows, null, 2)) + '\n');
      }
    }
  }
}

if (process.argv[2] === '--prepare') await prepare();
else if (process.argv[2]) await run(process.argv[2]);
else throw new Error('先 --prepare 抓取并冻结资料，再传准备目录运行；须人工核对原文后再评价准确性。');
