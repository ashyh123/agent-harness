import test from 'node:test';
import assert from 'node:assert/strict';
import { LangGraphLoop } from '../langgraph_loop.js';
import type { Configuration } from '../execution_runtime.js';
import { PythonBridge } from '../bridge.js';

test('扩大预算实际穿过第六次请求，压缩和输出恢复不能绕过新的硬上限', async t => {
  const bridge = new PythonBridge({ ...process.env, DEEPSEEK_API_KEY: 'offline-test-key' });
  t.after(() => bridge.close());
  const config = await bridge.request<Configuration>('describe');
  let count = 0;
  const fetcher: typeof fetch = async () => {
    count++;
    return new Response(JSON.stringify({ id: 'offline', object: 'chat.completion', created: 1,
      model: 'deepseek-flash', choices: [{ index: 0, finish_reason: count === 6 ? 'stop' : 'tool_calls',
        message: count === 6 ? { role: 'assistant', content: '完成' } : { role: 'assistant', content: null,
          tool_calls: [{ id: `call-${count}`, type: 'function', function: { name: 'calculate',
            arguments: '{"operation":"add","a":1,"b":2}' } }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }), { headers: { 'content-type': 'application/json' } });
  };
  const result = await new LangGraphLoop(bridge, { ...config, max_steps: 10, max_model_requests: 16,
    max_tool_calls: 16, max_seconds: 180 }, fetcher).run([{ role: 'user', content: '测试扩大预算' }]);
  assert.equal(result.error, null);
  assert.equal(result.model_requests, 6);
  assert.equal(result.tool_calls, 5);
  await bridge.request('start', { limits: { max_steps: 6, max_model_requests: 16 } });
  for (let i = 0; i < 5; i++) await bridge.request('begin_model');
  await assert.rejects(bridge.request('ensure_model_capacity', { requests: 2 }), /预算不足/);
  await bridge.request('begin_model');
  await assert.rejects(bridge.request('begin_model'), /外层模型请求上限/);
});
