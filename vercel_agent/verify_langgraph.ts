/** Paired OFFLINE comparison; no .env, real model, web, tracing or paid service. */
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ROOT } from './bridge.js';
import { fixtureHarness } from './langgraph_fixture.js';
import { openLangGraphBackend } from './langgraph_backend.js';
const root = join(ROOT, 'reports/langgraph-runs');
await mkdir(root, { recursive: true });
const directory = await mkdtemp(join(root, 'offline-'));
const input = { skill: 'calculation-audit', task: '计算123乘456' };
const rows = [];
for (const budget of [8, 1]) for (let repeat = 0; repeat < 3; repeat++) {
  // Alternating order controls warm-up a little; no inference about real-model performance.
  for (const backend of repeat % 2 ? ['langgraph', 'harness'] : ['harness', 'langgraph']) {
    const path = join(directory, `${budget}-${repeat}-${backend}`);
    const started = performance.now();
    let execution;
    if (backend === 'harness') execution = await fixtureHarness(join(path, 'harness'), input, budget);
    else {
      const graph = await openLangGraphBackend(path, input => fixtureHarness(join(path, 'harness'), input, budget));
      try {
        let state = await graph.start(input);
        if (state.status === 'needs_review') state = await graph.resume(true);
        execution = state.execution;
      } finally { graph.close(); }
    }
    const result = execution.record.result!;
    const trajectory = result.events.filter(event => event.type === 'tool').map(event => ({ name: event.name, arguments: event.arguments, result: event.result }));
    rows.push({ backend, budget, repeat, completed: execution.record.runtime_status === 'completed',
      accepted: execution.record.runtime_status === 'completed' && result.answer?.includes('56088') === true
        && trajectory.some(event => event.name === 'calculate' && event.result?.result === 56088),
      model_requests: result.model_requests, tool_calls: result.tool_calls, tokens: result.total_tokens,
      duplicate_calls: trajectory.length - new Set(trajectory.map(event => JSON.stringify([event.name, event.arguments]))).size,
      elapsed_ms: Math.round(performance.now() - started), trajectory,
      model_cost: null, error: result.error });
  }
}
await writeFile(join(directory, 'comparison.json'), JSON.stringify({ mode: 'offline_mock_model_real_python_tool', input,
  repeats: 3, model_cost_note: 'No model API called. Tokens are synthetic fixture values, not billing.', rows }, null, 2));
console.log(directory);
for (const backend of ['harness', 'langgraph']) {
  const group = rows.filter(row => row.backend === backend);
  console.log(`${backend}: ${group.filter(row => row.accepted).length}/${group.length} accepted (includes deliberate budget failures), duplicates ${group.reduce((sum, row) => sum + row.duplicate_calls, 0)}`);
}
