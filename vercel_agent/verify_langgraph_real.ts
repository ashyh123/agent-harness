/** Explicitly paid validation: existing DeepSeek provider + real shared calculate. */
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { MinimalHarness, type TaskInput } from './harness.js';
import { PythonBridge, ROOT, loadLocalEnv, redact } from './bridge.js';
import { harnessConfiguration, harnessEnvironment } from './person_profile.js';
import { SKILLS_ROOT } from './skills.js';
import type { Configuration } from './execution_runtime.js';
import { openLangGraphBackend } from './langgraph_backend.js';

loadLocalEnv();
if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY required');
if ([process.env.LANGSMITH_TRACING, process.env.LANGCHAIN_TRACING_V2, process.env.LANGCHAIN_TRACING]
  .some(value => value?.toLowerCase() === 'true')) throw new Error('Disable tracing');
const root = join(ROOT, 'reports/langgraph-runs');
await mkdir(root, { recursive: true });
const directory = await mkdtemp(join(root, 'real-'));
const input: TaskInput = { skill: 'calculation-audit', task: '计算123乘456' };
const rows: any[] = [];
const report = { mode: 'real_deepseek_real_python_tool', started_at: new Date().toISOString(), input,
  repeats: 3, model_cost_note: 'Actual provider usage retained; no account-specific monetary price assumed.', rows };
const save = () => writeFile(join(directory, 'comparison.json'), redact(JSON.stringify(report, null, 2)), { mode: 0o600 });
await save();
console.log(directory);

async function execute(runs: string, task: TaskInput, budget: number) {
  const bridge = new PythonBridge(harnessEnvironment(task.skill));
  try {
    const base = harnessConfiguration(await bridge.request<Configuration>('describe'), task.skill);
    const config = { ...base, tools: base.tools.filter(tool => tool.name === 'calculate'), max_model_requests: budget };
    return await new MinimalHarness(bridge, config, { skills: SKILLS_ROOT, runs }).run(task);
  } finally { bridge.close(); }
}
const runFile = promisify(execFile);
async function resume(path: string, approve = false) {
  const { stdout } = await runFile(process.execPath, ['--import', 'tsx',
    fileURLToPath(new URL('./langgraph_cli.ts', import.meta.url)), 'resume', path, ...(approve ? ['approve'] : [])],
    { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  return JSON.parse(stdout);
}
for (const budget of [8, 1]) for (let repeat = 0; repeat < 3; repeat++) {
  for (const backend of repeat % 2 ? ['langgraph', 'harness'] : ['harness', 'langgraph']) {
    const path = join(directory, `${budget}-${repeat}-${backend}`);
    const started = performance.now();
    let execution;
    let recovery: unknown = null;
    if (backend === 'harness') execution = await execute(join(path, 'harness'), input, budget);
    else {
      const graph = await openLangGraphBackend(path, task => execute(join(path, 'harness'), task, budget));
      let state;
      try { state = await graph.start(input); }
      finally { graph.close(); }
      execution = state.execution;
      if (state.status === 'needs_review') {
        // New OS process resumes approval using the real-model result, then another replays terminal state.
        const first = await resume(path, true);
        const before = await stat(join(path, 'delivery.md'));
        const second = await resume(path);
        const after = await stat(join(path, 'delivery.md'));
        const receipt = JSON.parse(await readFile(join(path, 'execution.json'), 'utf8'));
        recovery = { fresh_process: true, final_status: first.status, replay_status: second.status,
          harness_runs: (await readdir(join(path, 'harness'))).length,
          delivery_not_rewritten: before.ino === after.ino && before.mtimeMs === after.mtimeMs,
          requests_unchanged: receipt.record.result?.model_requests === execution.record.result?.model_requests,
          tool_calls_unchanged: receipt.record.result?.tool_calls === execution.record.result?.tool_calls };
        assert.equal(first.status, 'delivered');
        assert.equal(second.status, 'delivered');
        assert.equal((recovery as any).harness_runs, 1);
        for (const field of ['delivery_not_rewritten', 'requests_unchanged', 'tool_calls_unchanged']) {
          assert.equal((recovery as any)[field], true, field);
        }
      }
    }
    const result = execution.record.result;
    const trajectory = (result?.events ?? []).filter((event: any) => event.type === 'tool')
      .map((event: any) => ({ name: event.name, arguments: event.arguments, result: event.result }));
    const row = { backend, budget, repeat, model: execution.record.configuration.model,
      configuration: execution.record.configuration, completed: execution.record.runtime_status === 'completed',
      accepted: execution.record.runtime_status === 'completed' && result?.answer?.replaceAll(',', '').includes('56088') === true
        && trajectory.some((event: any) => event.name === 'calculate' && event.result?.result === 56088),
      model_requests: result?.model_requests ?? 0, tool_calls: result?.tool_calls ?? 0, tokens: result?.total_tokens ?? null,
      provider_usage: (result?.events ?? []).filter((event: any) => event.usage).map((event: any) => event.usage),
      duplicate_calls: trajectory.length - new Set(trajectory.map((event: any) => JSON.stringify([event.name, event.arguments]))).size,
      elapsed_ms: Math.round(performance.now() - started),
      executor_elapsed_ms: Date.parse(execution.record.finished_at) - Date.parse(execution.record.started_at), trajectory, recovery,
      model_cost: null, error: result?.error ?? execution.record.harness_error, answer: result?.answer ?? null };
    rows.push(row);
    await save(); // Preserve completed observations before attempting the next paid task.
    console.log(`${backend} budget=${budget} repeat=${repeat}: accepted=${row.accepted} requests=${row.model_requests} tools=${row.tool_calls} tokens=${row.tokens} ms=${row.elapsed_ms}`);
  }
}
await writeFile(join(directory, 'finished.json'), JSON.stringify({ finished_at: new Date().toISOString() }));
console.log('Completed 12 paid-model task runs.');
