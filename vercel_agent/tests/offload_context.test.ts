import test from 'node:test';
import assert from 'node:assert/strict';
import type { ModelMessage } from 'ai';
import { offloadContext } from '../offload_context.js';
import { DEFAULT_CONTEXT_POLICY, estimateInput, CONTEXT_INSTRUCTION, SUMMARY_INSTRUCTION } from '../context.js';
import { LangGraphLoop } from '../langgraph_loop.js';
import type { Configuration } from '../execution_runtime.js';
import { PythonBridge } from '../bridge.js';

const id = 'a'.repeat(64);
const source = 'HEAD\n' + '文本😀'.repeat(3000) + '\nTAIL';
function messages(value: any): ModelMessage[] {
  return [{ role: 'user', content: '核对事实' },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'read-1', toolName: 'read_saved_webpage', input: { document_id: id } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'read-1', toolName: 'read_saved_webpage', output: { type: 'json', value } }] }, { role: 'assistant', content: '已观察正文，继续任务' }];
}
const value = { document_id: id, content: source, content_format: 'text', url: 'https://example.com',
  offset: 120, end_offset: 120 + Array.from(source).length, has_more: true, completeness: 'not_verified' };

test('只改大结果正文，保留原输入、工具ID和来源；预览范围按Unicode码点，不伪造全文覆盖', () => {
  const original = messages(value), before = structuredClone(original);
  const policy = { ...DEFAULT_CONTEXT_POLICY, target_tokens: 3000 };
  const reduced = offloadContext(original, policy, '', [], 0);
  assert.deepEqual(original, before);
  assert.deepEqual(reduced.messages.slice(0, 2), original.slice(0, 2));
  const tool: any = reduced.messages[2];
  assert.equal(tool.content[0].toolCallId, 'read-1');
  const retained = tool.content[0].output.value;
  assert.equal(retained.content_offloaded, true);
  assert.match(retained.content, /^HEAD/); assert.match(retained.content, /TAIL$/);
  assert.equal(retained.recall.arguments.offset, 120);
  assert.equal(retained.completeness, 'not_verified');
  assert.equal(retained.preview_ranges[1][1], Array.from(source).length);
  assert.ok(reduced.after <= policy.target_tokens);
});

test('目标未达且无可移出结果时不误报超限；用户指令完整保留，硬超限交给恢复层', () => {
  for (const invalid of [{ ...value, error: { code: 'failed' } }, { ...value, document_id: '' }, { ...value, content: '短结果' }]) {
    const input = messages(invalid);
    const reduced = offloadContext(input, { ...DEFAULT_CONTEXT_POLICY, target_tokens: 100 }, '', [], 0);
    assert.deepEqual(reduced.messages, input);
    assert.equal(reduced.target_met, false);
    assert.equal(reduced.requires_fallback, false);
    assert.deepEqual(reduced.replaced, []);
  }
  const input = messages(value); input[0] = { role: 'user', content: '不可丢弃'.repeat(12000) };
  const before = structuredClone(input);
  const reduced = offloadContext(input, DEFAULT_CONTEXT_POLICY, '', [], 0);
  assert.equal(reduced.requires_fallback, true);
  assert.deepEqual(reduced.messages[0], input[0]);
  assert.deepEqual(input, before);
});

test('文本JSON结果可以再缩减旧预览，小的最新证据不变；不伪造二次预览的原文范围', () => {
  const input = messages(value);
  const part: any = (input[2] as any).content[0]; part.output = { type: 'text', value: JSON.stringify(value) };
  input.push({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'read-2', toolName: 'read_saved_webpage', input: {} }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'read-2', toolName: 'read_saved_webpage', output: { type: 'json', value: { ...value, content: '关键证据' } } }] });
  const reduced = offloadContext(input, { ...DEFAULT_CONTEXT_POLICY, target_tokens: 4000 }, '', [], 0);
  assert.deepEqual(reduced.messages.slice(-2), input.slice(-2));
  assert.ok(JSON.parse((reduced.messages[2] as any).content[0].output.value).content_offloaded);
  const twice = offloadContext(reduced.messages, { ...DEFAULT_CONTEXT_POLICY, target_tokens: 50 }, '', [], 0);
  const retained = JSON.parse((twice.messages[2] as any).content[0].output.value);
  assert.equal(retained.content, ''); assert.deepEqual(retained.preview_ranges, []);
  assert.equal(twice.target_met, false); assert.equal(twice.requires_fallback, false);
  assert.ok(twice.after < reduced.after);
  assert.deepEqual(twice.messages.slice(-2), input.slice(-2));
  const noProgress = offloadContext(twice.messages, { ...DEFAULT_CONTEXT_POLICY, target_tokens: 50 }, '', [], 0);
  assert.equal(noProgress.after, twice.after); assert.deepEqual(noProgress.replaced, []);
});

function completion(text: string | null, calls: any[] = []) {
  return { id: 'offline', object: 'chat.completion', created: 1, model: 'deepseek-flash',
    choices: [{ index: 0, finish_reason: calls.length ? 'tool_calls' : 'stop', message: { role: 'assistant', content: text,
      ...(calls.length ? { tool_calls: calls } : {}) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
}
async function setup(t: any, responses: any[]) {
  const bridge = new PythonBridge({ ...process.env, DEEPSEEK_API_KEY: 'offline-test-key' });
  t.after(() => bridge.close());
  const config = await bridge.request<Configuration>('describe');
  config.tools = config.tools.filter(tool => ['read_webpage', 'read_saved_webpage', 'calculate'].includes(tool.name));
  const base = estimateInput([{ role: 'user', content: '读取网页' }], `${config.system_prompt}\n\n${CONTEXT_INSTRUCTION}`, config.tools, config.max_output_tokens);
  config.context_policy = { strategy: 'artifact_offload', trigger_tokens: base + 2000, target_tokens: base + 1500 };
  const requests: any[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    requests.push(JSON.parse(init!.body as string));
    const next = responses.shift(); assert.ok(next, '不得额外请求摘要模型');
    return new Response(JSON.stringify(next), { headers: { 'content-type': 'application/json' } });
  };
  return { config, requests, agent: new LangGraphLoop(bridge, config, fetcher) };
}
test('真实SDK先观察新结果，再移出旧正文续跑；原工具证据和用量保留，短任务不触发', async t => {
  const { agent, requests } = await setup(t, [completion(null, [{ id: 'page-1', type: 'function',
    function: { name: 'read_webpage', arguments: JSON.stringify({ url: 'https://example.com' }) } }]), completion(null, [{ id: 'calc-2', type: 'function', function: { name: 'calculate', arguments: '{"expression":"1+1"}' } }]), completion('已核对'), completion('你好')]);
  const result = await agent.run([{ role: 'user', content: '读取网页' }], {
    limits: { max_model_requests: 3 }, fixtures: { read_webpage: { ...value, content: 'A'.repeat(8000), truncated: false } } });
  assert.equal(result.error, null); assert.equal(result.model_requests, 3); assert.equal(result.total_tokens, 45);
  assert.equal(result.context_compactions.length, 1);
  assert.equal(result.context_compactions[0].strategy, 'artifact_offload');
  assert.equal(result.events.filter(event => event.type === 'tool')[0].result.content.length, 8000);
  assert.doesNotMatch(JSON.stringify(requests[1].messages), /content_offloaded/);
  assert.match(JSON.stringify(requests[1].messages), /A{8000}/, '模型第一次观察完整新结果');
  assert.match(JSON.stringify(requests[2].messages), /content_offloaded/);
  assert.equal(requests[1].messages.find((message: any) => message.role === 'tool').tool_call_id, 'page-1');
  assert.deepEqual(result.events.filter(event => event.type === 'model').map(event => event.kind), ['vercel', 'vercel', 'vercel']);
  const short = await agent.run([{ role: 'user', content: '你好' }]);
  assert.equal(short.error, null); assert.equal(short.model_requests, 1); assert.deepEqual(short.context_compactions, []);
});

test('真实SDK遇到未达软目标但低于硬容量时续跑，模型和工具预算不改变', async t => {
  const { agent, config, requests } = await setup(t, [completion('A'.repeat(6000))]);
  // 无可移出结果的长历史曾直接触发停止，现在保持原历史发出一次模型请求。
  const input: ModelMessage[] = [{ role: 'user', content: '继续' }, { role: 'assistant', content: '历史'.repeat(3000) }];
  config.context_policy = { strategy: 'artifact_offload', target_tokens: 1000, trigger_tokens: 2000, max_input_tokens: 64000 };
  const result = await agent.run(input, { limits: { max_model_requests: 1 } });
  assert.equal(result.error, null); assert.equal(result.model_requests, 1);
  assert.equal(result.tool_calls, 0); assert.equal(requests.length, 1);
  assert.match(JSON.stringify(requests[0].messages), /历史/);
  assert.deepEqual(result.context_compactions, []);
});

async function fallbackSetup(t: any) {
  const call = { id: 'calc-1', type: 'function', function: { name: 'calculate', arguments: '{"expression":"1+1"}' } };
  const history = 'A'.repeat(20000);
  const context: ModelMessage[] = [{ role: 'user', content: '计算并报告结果' },
    { role: 'assistant', content: [{ type: 'text', text: history }, { type: 'tool-call', toolCallId: 'calc-1', toolName: 'calculate', input: { expression: '1+1' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'calc-1', toolName: 'calculate', output: { type: 'json', value: { result: 2 } } }] }];
  const setupResult = await setup(t, [completion(history, [call]), completion('计算工具已返回2，下一步报告结果。'), completion('2')]);
  const { config } = setupResult;
  const summarySize = estimateInput([{ role: 'user', content: JSON.stringify(context) }], SUMMARY_INSTRUCTION, [], 1024);
  const fullSize = estimateInput(context, `${config.system_prompt}\n\n${CONTEXT_INSTRUCTION}`, config.tools, config.max_output_tokens);
  assert.ok(fullSize > summarySize, '去掉工具Schema后摘要请求可在硬容量内发送');
  config.context_policy = { ...config.context_policy, max_input_tokens: Math.ceil((fullSize + summarySize) / 2) };
  return setupResult;
}

test('真实SDK本地无收益且超硬容量时升级摘要；复用成功工具结果，摘要计入预算', async t => {
  const { agent, requests } = await fallbackSetup(t);
  const result = await agent.run([{ role: 'user', content: '计算并报告结果' }], { fixtures: { calculate: { result: 2 } }, limits: { max_model_requests: 3 } });
  assert.equal(result.error, null); assert.equal(result.answer, '2');
  assert.equal(result.model_requests, 3); assert.equal(result.tool_calls, 1);
  assert.deepEqual(result.events.filter(e => e.type === 'model').map(e => e.kind), ['vercel', 'vercel_context_compaction', 'vercel']);
  assert.equal(result.context_compactions[0].method, 'summary_fallback');
  assert.equal(requests[1].tools, undefined);
  assert.doesNotMatch(JSON.stringify(requests[2].messages), /A{100}/);
  assert.match(JSON.stringify(requests[2].messages), /2/);
});

test('摘要恢复依然服从共享预算，不够摘要和续跑时不发送额外请求', async t => {
  const { agent, requests } = await fallbackSetup(t);
  const result = await agent.run([{ role: 'user', content: '计算并报告结果' }], { fixtures: { calculate: { result: 2 } }, limits: { max_model_requests: 2 } });
  assert.match(result.error ?? '', /预算不足以完成上下文压缩/);
  assert.equal(result.model_requests, 1); assert.equal(result.tool_calls, 1);
  assert.equal(requests.length, 1);
});

test('最新同批多个工具结果完整保留，旧结果可移出；ID和调用参数不变', () => {
  const old = messages(value);
  const latest: ModelMessage[] = [
    { role: 'assistant', content: [1, 2].map(n => ({ type: 'tool-call' as const, toolCallId: `new-${n}`, toolName: 'read_saved_webpage', input: { offset: n * 10000 } })) },
    { role: 'tool', content: [2, 1].map(n => ({ type: 'tool-result' as const, toolCallId: `new-${n}`, toolName: 'read_saved_webpage', output: { type: 'json' as const, value: { ...value, content: source, offset: n * 10000 } } })) },
  ];
  const input = [...old, ...latest], original = structuredClone(input);
  const reduced = offloadContext(input, { ...DEFAULT_CONTEXT_POLICY, target_tokens: 1000 }, '', [], 0);
  assert.deepEqual(input, original);
  assert.deepEqual(reduced.messages.slice(-2), latest);
  assert.equal(reduced.target_met, false);
  assert.equal(reduced.requires_fallback, false);
  assert.ok(reduced.replaced.length > 0);
});

test('恢复摘要也不把小于必需指令大小的软目标当作停止边界', async t => {
  const { agent, config } = await fallbackSetup(t);
  config.context_policy = { ...config.context_policy, target_tokens: 1000, trigger_tokens: 2000 };
  const result = await agent.run([{ role: 'user', content: '计算并报告结果' }], { fixtures: { calculate: { result: 2 } }, limits: { max_model_requests: 3 } });
  assert.equal(result.error, null); assert.equal(result.answer, '2');
  assert.equal(result.context_compactions[0].method, 'summary_fallback');
  assert.equal(result.context_compactions[0].target_met, false);
  assert.ok(result.context_compactions[0].output_estimated_tokens <= result.context_policy.max_input_tokens);
});
