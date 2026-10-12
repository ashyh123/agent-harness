/** Small release acceptance: real saves plus deliberately wrong evidence controls.
 * Supply a manifest prepared by verify:blog-workflow; snapshots stay local.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { BlogWorkflow } from './blog_workflow.js';
import { reviewBlogEvidence } from './blog_evidence.js';
import { createExecutionRuntime } from './execution_runtime.js';
import { PythonBridge, ROOT, loadLocalEnv, redact } from './bridge.js';

loadLocalEnv();
(globalThis as any).AI_SDK_LOG_WARNINGS = false;
if (!process.argv[2]) throw new Error('传入已冻结的 manifest.json；先用 verify:blog-workflow -- --prepare 准备');
const manifest = JSON.parse(await readFile(resolve(process.argv[2]), 'utf8'));
const directory = resolve(process.argv[3] ?? join(ROOT, 'reports/blog-acceptance', new Date().toISOString().replace(/[:.]/g, '-')));
await mkdir(directory, { recursive: true });
const vault = join(process.env.MINIMAL_AGENT_OBSIDIAN_VAULT ?? join(process.env.HOME!, 'Documents/Obsidian/Agent 博客阅读'),
  '版本验收', directory.split('/').at(-1)!);
const records: any[] = [];
const drafts: Record<string, any> = {};
const sha = (data: string) => createHash('sha256').update(data).digest('hex');
const makeBridge = (id: string) => new PythonBridge({ ...process.env,
  MINIMAL_AGENT_TASK_COORDINATION: '0', MINIMAL_AGENT_CODEX_DELEGATION: '0', MINIMAL_AGENT_OBSIDIAN_VAULT: join(vault, id) });
await writeFile(join(directory, 'manifest.json'), redact(JSON.stringify({ ...manifest,
  acceptance: 'Two fixed-workflow runs per article; controlled evidence regressions use the same model, source and limits. No strategy comparisons or budget tuning.',
  vault_root: vault }, null, 2)));
const record = async (id: string, data: any) => {
  records.push({ id, ...data });
  await writeFile(join(directory, 'results.json'), redact(JSON.stringify(records, null, 2)));
};
for (const item of manifest.sources) {
  for (let repeat = 1; repeat <= 2; repeat++) {
    const id = `${item.id}-workflow-r${repeat}`;
    const bridge = makeBridge(id);
    try {
      await bridge.request('describe');
      const started = performance.now();
      const result = await new BlogWorkflow(bridge, manifest.config).run(item.url, { fixtures: { read_webpage: item.source } });
      const elapsed_seconds = (performance.now() - started) / 1000;
      const snapshot = JSON.parse(await readFile(join(ROOT, 'reports/webpage-snapshots', `${item.document_id}.json`), 'utf8'));
      let file_verified = false;
      if (result.saved && result.receipt) {
        const note = await readFile(result.receipt.note_path, 'utf8');
        const original = await readFile(result.receipt.original_path, 'utf8');
        file_verified = sha(note) === result.receipt.sha256 && note.includes(item.url)
          && ['summary', 'takeaway', 'evidence_quote'].every(key => note.includes(result.draft[key]))
          && original.includes(snapshot.content);
      }
      if (result.draft) drafts[item.id] = { ...result.draft, document_id: item.document_id };
      await writeFile(join(directory, `${id}.json`), redact(JSON.stringify(result, null, 2)));
      await record(id, { kind: 'workflow', case: item.id, repeat, saved: result.saved, file_verified,
        total_tokens: result.total_tokens, model_requests: result.model_requests, tool_calls: result.tool_calls,
        elapsed_seconds, error: result.error, draft: result.draft, receipt: result.receipt,
        source_review: 'pending; production model verdict is not ground truth' });
      console.log(`${id}: saved=${result.saved}, verified=${file_verified}, tokens=${result.total_tokens}, ${elapsed_seconds.toFixed(2)}s`);
    } finally { bridge.close(); }
  }
}
const controls = [
  { id: 'vpc_absolute', case: 'anthropic', summary: '文章把Agent分为session、harness和sandbox，三者可独立替换。早期同容器架构无法接入客户 VPC。' },
  { id: 'agent_definition', case: 'openai', quote: 'We view agents as systems that independently accomplish tasks on behalf of users.' },
  { id: 'generic_release', case: 'openai', quote: 'To address these challenges, we’re launching a new set of APIs and tools specifically designed to simplify the development of agentic applications:' },
  { id: 'generic_benefit', case: 'openai', quote: 'These new tools streamline core agent logic, orchestration, and interactions, making it significantly easier for developers to get started with building agents.' },
  { id: 'problem_only', case: 'google', quote: 'Holding an HTTP connection open for long-running tasks is fragile.' },
];
for (const control of controls) {
  const item = manifest.sources.find((s: any) => s.id === control.case);
  if (!item || !drafts[control.case]) throw new Error(`缺少控制案例来源 ${control.case}`);
  const bridge = makeBridge(control.id);
  try {
    await bridge.request('describe');
    const { max_steps, max_model_requests, max_tool_calls, max_seconds } = manifest.config;
    await bridge.request('start', { fixtures: { read_webpage: item.source }, limits: {
      max_steps, max_model_requests, max_tool_calls, max_seconds } });
    await bridge.request('call_tool', { name: 'read_webpage', arguments: { url: item.url }, tool_call_id: 'acceptance-read' });
    await bridge.request('call_tool', { name: 'read_saved_webpage', arguments: {
      document_id: item.document_id, content_format: 'text', offset: 0, limit: 10000 }, tool_call_id: 'acceptance-text' });
    const draft = { ...drafts[control.case], ...(control.summary ? { summary: control.summary } : {}),
      ...(control.quote ? { evidence_quote: control.quote } : {}) };
    const runtime = createExecutionRuntime(bridge, manifest.config, fetch);
    const review = await reviewBlogEvidence(bridge, manifest.config, runtime, draft);
    const trace = await bridge.request('trace');
    await record(control.id, { kind: 'negative_control', case: control.case, expected_passed: false,
      passed: !review.passed, review, draft, total_tokens: trace.events.reduce((n: number, e: any) => n + (e.usage?.total_tokens ?? 0), 0) });
    console.log(`${control.id}: rejected=${!review.passed}`);
  } finally { bridge.close(); }
}
const structuralPass = records.every(r => r.kind === 'workflow' ? r.saved && r.file_verified : r.passed);
console.log(`结构与拒绝控制验收=${structuralPass}; 仍须人工核对六份笔记。记录：${directory}`);
if (!structuralPass) process.exitCode = 1;
