import test from 'node:test';
import assert from 'node:assert/strict';
import type { ModelMessage } from 'ai';
import type { Configuration } from '../agent.js';
import { LangGraphLoop } from '../langgraph_loop.js';
import { PythonBridge } from '../bridge.js';

function completion(content: string | null, calls: any[] = [], finish = calls.length ? 'tool_calls' : 'stop') {
  return { id: 'offline', object: 'chat.completion', created: 1, model: 'deepseek-flash',
    choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content, ...(calls.length ? { tool_calls: calls } : {}) } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
}
function call(id: string, args: unknown, name = 'calculate') {
  return { id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } };
}
async function harness(t: any, responses: any[]) {
  const bridge = new PythonBridge({ ...process.env, DEEPSEEK_API_KEY: 'offline-test-key' });
  t.after(() => bridge.close());
  const config = await bridge.request<Configuration>('describe');
  const requests: any[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    requests.push(JSON.parse(init!.body as string));
    const body = responses.shift();
    assert.ok(body, '发生未预期的额外模型请求');
    if (body instanceof Error) throw body;
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  };
  return { agent: new LangGraphLoop(bridge, config, fetcher), requests, bridge };
}

test('LangGraph 节点循环，将工具结果按原 call id 发给下一次模型请求', async t => {
  const { agent, requests } = await harness(t, [completion(null, [call('calc-1', { operation: 'multiply', a: 123, b: 456 })]), completion('56088')]);
  const messages: ModelMessage[] = [{ role: 'user', content: '请计算' }];
  const result = await agent.run(messages);
  assert.equal(result.answer, '56088');
  assert.equal(result.model_requests, 2);
  assert.equal(result.tool_calls, 1);
  const returned = requests[1].messages.find((message: any) => message.role === 'tool');
  assert.equal(returned.tool_call_id, 'calc-1');
  assert.equal(JSON.parse(returned.content).result, 56088);
  assert.equal(requests[0].max_tokens, 512);
  assert.deepEqual(requests[0].thinking, { type: 'disabled' });
  assert.equal(messages.at(-1)?.role, 'assistant');
});

test('参数错误由共享 Pydantic 校验拒绝，共享模型适配器 将错误交回模型且计入工具预算', async t => {
  const { agent, requests } = await harness(t, [completion(null, [call('bad-1', { operation: 'add', a: '1', b: 2 })]), completion('参数错误')]);
  const result = await agent.run([{ role: 'user', content: '测试' }]);
  assert.equal(result.answer, '参数错误');
  assert.equal(result.tool_calls, 1);
  assert.equal(result.events.find(event => event.type === 'tool').result.error.code, 'sdk_validation_error');
  assert.equal(requests[1].messages.find((message: any) => message.role === 'tool').tool_call_id, 'bad-1');
});

test('未知工具不执行，并计入尝试次数', async t => {
  const { agent } = await harness(t, [completion(null, [call('missing', {}, 'no_such_tool')]), completion('无法使用这个工具')]);
  const result = await agent.run([{ role: 'user', content: '测试' }]);
  assert.equal(result.error, null);
  assert.equal(result.tool_calls, 1);
  assert.equal(result.events.find(event => event.type === 'tool').name, 'no_such_tool');
});

test('一次模型请求的多个工具调用不能越过独立工具预算', async t => {
  const args = { operation: 'add', a: 1, b: 2 };
  const { agent, requests } = await harness(t, [completion(null, [call('a', args), call('b', args), call('c', args)])]);
  const messages: ModelMessage[] = [{ role: 'user', content: '测试' }];
  const result = await agent.run(messages, { limits: { max_tool_calls: 2 } });
  assert.match(result.error ?? '', /工具调用上限/);
  assert.equal(result.tool_calls, 2);
  assert.equal(requests.length, 1);
  assert.equal(messages.length, 1);
});

test('除零作为工具业务错误返回，共享模型适配器 继续让模型解释', async t => {
  const { agent, requests } = await harness(t, [completion(null, [call('zero', { operation: 'divide', a: 10, b: 0 })]), completion('不能除以零')]);
  const result = await agent.run([{ role: 'user', content: '测试' }]);
  assert.equal(result.error, null);
  assert.ok(JSON.parse(requests[1].messages.find((message: any) => message.role === 'tool').content).error);
});

test('截断恢复保留已获得资料，丢弃半截输出，下一轮不携带恢复指令', async t => {
  const { agent, requests } = await harness(t, [
    completion(null, [call('page', { url: 'https://example.com/' }, 'read_webpage')]),
    completion('半截回答', [], 'length'), completion('两个问题都答完了'), completion('下一轮回答'),
  ]);
  const messages: ModelMessage[] = [{ role: 'user', content: '两个问题' }];
  const result = await agent.run(messages, { fixtures: { read_webpage: { content: '同一份原文', truncated: false } } });
  assert.equal(result.model_requests, 3);
  assert.equal(result.tool_calls, 1);
  assert.equal(result.compact_retry_used, true);
  assert.match(result.answer ?? '', /自动改为精简版/);
  const recovery = JSON.stringify(requests[2].messages);
  assert.match(recovery, /同一份原文/);
  assert.doesNotMatch(recovery, /半截回答/);
  assert.match(recovery, /重新生成精简答案/);
  messages.push({ role: 'user', content: '继续' });
  await agent.run(messages);
  assert.doesNotMatch(JSON.stringify(requests[3].messages), /重新生成精简答案/);
});

test('截断的工具调用不能执行，重试仍截断则本轮历史不提交', async t => {
  const { agent } = await harness(t, [completion(null, [call('partial', '{"a":')], 'length'), completion('仍不完整', [], 'length')]);
  const messages: ModelMessage[] = [{ role: 'user', content: '测试' }];
  const result = await agent.run(messages);
  assert.equal(result.tool_calls, 0);
  assert.match(result.error ?? '', /仍达到输出上限/);
  assert.equal(messages.length, 1);
  assert.equal(result.events[0].discarded_tool_calls, 1);
});

test('反复调用到第五步强制停下，不假装给出完成答案', async t => {
  const repeated = () => completion(null, [call('repeat', { operation: 'add', a: 1, b: 2 })]);
  const { agent, requests } = await harness(t, Array.from({ length: 5 }, repeated));
  const result = await agent.run([{ role: 'user', content: '测试' }]);
  assert.equal(requests.length, 5);
  assert.equal(result.answer, null);
  assert.match(result.error ?? '', /外层模型请求上限/);
});

test('精简重试也不能突破总模型请求预算', async t => {
  const { agent, requests } = await harness(t, [completion('半截', [], 'length')]);
  const result = await agent.run([{ role: 'user', content: '测试' }], { limits: { max_model_requests: 1 } });
  assert.equal(requests.length, 1);
  assert.match(result.error ?? '', /模型请求总数上限/);
  assert.equal(result.model_requests, 1);
});

test('共享模型适配器 校验失败太多也必须停止，观察回调吞错不能掩盖预算错误', async t => {
  const { agent, requests } = await harness(t, [completion(null, [call('a', {}, 'missing_a'), call('b', {}, 'missing_b')])]);
  const result = await agent.run([{ role: 'user', content: '测试' }], { limits: { max_tool_calls: 1 } });
  assert.equal(requests.length, 1);
  assert.equal(result.tool_calls, 1);
  assert.match(result.error ?? '', /工具调用上限/);
});

test('外层第五次请求截断后不能借精简重试多发第六次', async t => {
  const repeated = () => completion(null, [call('repeat', { operation: 'add', a: 1, b: 2 })]);
  const { agent, requests } = await harness(t, [...Array.from({ length: 4 }, repeated), completion('半截', [], 'length')]);
  const result = await agent.run([{ role: 'user', content: '测试' }]);
  assert.equal(requests.length, 5);
  assert.equal(result.model_requests, 5);
  assert.match(result.error ?? '', /外层模型请求上限/);
});

test('视觉工具的内部模型请求也受同一预算约束', async t => {
  const { agent, requests } = await harness(t, [completion(null, [call('image', { image_source: 'images/demo-chart.png', question: '读数字' }, 'analyze_image')])]);
  const result = await agent.run([{ role: 'user', content: '测试' }], { limits: { max_model_requests: 1 } });
  assert.equal(requests.length, 1);
  assert.equal(result.model_requests, 1);
  assert.equal(result.tool_calls, 1);
  assert.match(result.error ?? '', /模型请求上限/);
});

test('HTTP 失败不自动重试，失败轮不修改先前成功历史', async t => {
  const bridge = new PythonBridge({ ...process.env, DEEPSEEK_API_KEY: 'offline-test-key' });
  t.after(() => bridge.close());
  const config = await bridge.request<Configuration>('describe');
  let requests = 0;
  const fetcher: typeof fetch = async () => {
    requests++;
    return new Response(JSON.stringify({ error: { message: 'offline unavailable' } }), { status: 503, headers: { 'content-type': 'application/json' } });
  };
  const agent = new LangGraphLoop(bridge, config, fetcher);
  const messages: ModelMessage[] = [{ role: 'user', content: '上一轮' }, { role: 'assistant', content: '已成功' }, { role: 'user', content: '新任务' }];
  const before = structuredClone(messages);
  const result = await agent.run(messages);
  assert.equal(requests, 1);
  assert.equal(result.model_requests, 1);
  assert.match(result.error ?? '', /503/);
  assert.deepEqual(messages, before);
});

function threeCalculations() {
  return completion(null, [
    call('a', { operation: 'add', a: 1, b: 2 }),
    call('b', { operation: 'multiply', a: 2, b: 4 }),
    call('c', { operation: 'subtract', a: 10, b: 3 }),
  ]);
}
function serviceUnavailable() {
  return new Response(JSON.stringify({ error: { message: 'offline temporary unavailable' } }), {
    status: 503, headers: { 'content-type': 'application/json', 'retry-after-ms': '0' },
  });
}

test('503 后只重试当前模型请求，复用三个工具结果且重试计入预算', async t => {
  const { agent, requests } = await harness(t, [threeCalculations(), serviceUnavailable(), completion('结果是 3、8、7')]);
  const messages: ModelMessage[] = [{ role: 'user', content: '执行三个计算并总结' }];
  const result = await agent.run(messages, { maxRetries: 1 });
  assert.equal(result.error, null);
  assert.equal(result.answer, '结果是 3、8、7');
  assert.equal(requests.length, 3);
  assert.equal(result.model_requests, 3);
  assert.equal(result.outer_requests, 3);
  assert.equal(result.tool_calls, 3);
  assert.equal(result.sdk_steps.length, 2);
  // 失败请求与重试请求的完整请求体一致，包括工具结果及其调用 ID。
  assert.deepEqual(requests[2], requests[1]);
  const returned = requests[2].messages.filter((message: any) => message.role === 'tool');
  assert.equal(returned.length, 3);
  assert.deepEqual(returned.map((message: any) => message.tool_call_id), ['a', 'b', 'c']);
  assert.deepEqual(returned.map((message: any) => JSON.parse(message.content).result), [3, 8, 7]);
  assert.equal(result.events.filter(event => event.type === 'tool').length, 3);
  const models = result.events.filter(event => event.type === 'model');
  assert.equal(models[1].status_code, 503);
  assert.equal(models[2].finish_reason, 'stop');
  assert.equal(messages.at(-1)?.content, '结果是 3、8、7');
});

test('重试不能突破共享模型请求预算，已执行工具不重复且失败历史不提交', async t => {
  const { agent, requests } = await harness(t, [threeCalculations(), serviceUnavailable()]);
  const messages: ModelMessage[] = [{ role: 'user', content: '执行三个计算并总结' }];
  const before = structuredClone(messages);
  const result = await agent.run(messages, { maxRetries: 1, limits: { max_model_requests: 2 } });
  assert.equal(requests.length, 2);
  assert.equal(result.model_requests, 2);
  assert.equal(result.tool_calls, 3);
  assert.equal(result.answer, null);
  assert.match(result.error ?? '', /模型请求总数上限/);
  assert.deepEqual(messages, before);
});

test('只允许一次重试，连续两次 503 后停止，不重启整个 Loop', async t => {
  const { agent, requests } = await harness(t, [threeCalculations(), serviceUnavailable(), serviceUnavailable()]);
  const messages: ModelMessage[] = [{ role: 'user', content: '执行三个计算并总结' }];
  const before = structuredClone(messages);
  const result = await agent.run(messages, { maxRetries: 1 });
  assert.equal(requests.length, 3);
  assert.equal(result.model_requests, 3);
  assert.equal(result.tool_calls, 3);
  assert.equal(result.answer, null);
  assert.ok(result.error);
  assert.deepEqual(requests[2], requests[1]);
  assert.deepEqual(messages, before);
});

test('本地 TimeoutError 不触发 共享模型适配器 原生重试，已有工具不重复执行', async t => {
  const { agent, requests } = await harness(t, [threeCalculations(), new DOMException('offline timeout', 'TimeoutError')]);
  const result = await agent.run([{ role: 'user', content: '执行三个计算并总结' }], { maxRetries: 1 });
  assert.equal(requests.length, 2);
  assert.equal(result.model_requests, 2);
  assert.equal(result.tool_calls, 3);
  assert.equal(result.error, 'TimeoutError');
  assert.equal(result.answer, null);
});
