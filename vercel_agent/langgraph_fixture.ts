/** Offline fixture: real Vercel SDK + real Python calculate; only model HTTP is mocked. */
import { MinimalHarness, type TaskInput } from './harness.js';
import { PythonBridge } from './bridge.js';
import type { Configuration } from './execution_runtime.js';
import { SKILLS_ROOT } from './skills.js';
export async function fixtureHarness(runs: string, input: TaskInput, maxRequests = 8) {
  const bridge = new PythonBridge({ ...process.env, DEEPSEEK_API_KEY: 'offline-test-key' });
  let request = 0;
  try {
    const base = await bridge.request<Configuration>('describe');
    const config = { ...base, tools: base.tools.filter(tool => tool.name === 'calculate'), max_model_requests: maxRequests };
    const fetcher: typeof fetch = async () => {
      request++;
      const message = request === 1
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'calc', type: 'function', function: {
          name: 'calculate', arguments: JSON.stringify({ operation: 'multiply', a: 123, b: 456 }),
        } }] } : { role: 'assistant', content: '|步骤|运算输入|工具结果|\n|---|---|---|\n|1|123 × 456|56088|\n结果：56088' };
      if (request > 2) throw new Error('Unexpected model request');
      return new Response(JSON.stringify({ id: 'offline', object: 'chat.completion', created: 1, model: base.model,
        choices: [{ index: 0, finish_reason: request === 1 ? 'tool_calls' : 'stop', message }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }), { headers: { 'content-type': 'application/json' } });
    };
    return await new MinimalHarness(bridge, config, { skills: SKILLS_ROOT, runs }, fetcher).run(input);
  } finally { bridge.close(); }
}
