import test from 'node:test';
import assert from 'node:assert/strict';
import type { ModelMessage } from 'ai';
import { collectEvidence, DEFAULT_CONTEXT_POLICY, estimateInput } from '../context.js';
import { planWorkingContext, parseWorkingState, workingMessages, type WorkingState } from '../working_context.js';
import { VercelLoop, type Configuration } from '../agent.js';
import { PythonBridge } from '../bridge.js';

const state = (facts: WorkingState['facts'] = []): WorkingState => ({ goal: '核对增长率', constraints: ['必须引用原文'],
  facts, completed: ['已读取指定范围'], missing: ['全文完整性未验证'], next: [] });
function group(id: string, content: string): ModelMessage[] {
  return [{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName: 'read_saved_webpage', input: {} }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: id, toolName: 'read_saved_webpage',
      output: { type: 'json', value: { document_id: 'a'.repeat(64), content, offset: 0, end_offset: content.length } } }] }];
}
const policy = { ...DEFAULT_CONTEXT_POLICY, strategy: 'working_memory' as const, target_tokens: 3_000, keep_recent_tokens: 800 };

test('只压缩旧历史，近期完整工具组与用户任务、系统指令原样保留', () => {
  const recent = group('recent', 'The verified growth rate is 73%.');
  const messages: ModelMessage[] = [{ role: 'system', content: '必须逐字核对' }, { role: 'user', content: '核对增长率' },
    ...group('old', 'A'.repeat(8000)), ...recent];
  const plan = planWorkingContext(messages, policy, '', [], 512);
  assert.deepEqual(plan.recent, recent);
  assert.ok(plan.older.some(message => JSON.stringify(message).includes('A'.repeat(100))));
  const reduced = workingMessages(plan, state());
  assert.equal(reduced[0], messages[0]);
  assert.equal(reduced[1], messages[1]);
  assert.deepEqual(reduced.slice(-2), recent);
  assert.ok(estimateInput(reduced, '', [], 512) < policy.target_tokens);
  assert.doesNotMatch(JSON.stringify(reduced), /A{100}/);
});

test('超大的最近一组整体交给摘要，不截断正文或拆出孤立工具结果', () => {
  const messages: ModelMessage[] = [{ role: 'user', content: '核对报告' }, ...group('huge', '汉'.repeat(8000))];
  const plan = planWorkingContext(messages, policy, '', [], 512);
  assert.deepEqual(plan.recent, []);
  assert.equal(plan.older.length, 2);
});

test('一批多个调用和乱序返回的结果必须成组保留，缺失或孤立ID被拒绝', () => {
  const messages: ModelMessage[] = [{ role: 'user', content: '核对' },
    { role: 'assistant', content: ['a', 'b'].map(id => ({ type: 'tool-call', toolCallId: id, toolName: 'calculate', input: {} })) },
    { role: 'tool', content: ['b', 'a'].map(id => ({ type: 'tool-result', toolCallId: id, toolName: 'calculate',
      output: { type: 'json', value: { result: 35 } } })) }];
  assert.equal(planWorkingContext(messages, policy, '', [], 512).recent.length, 2);
  assert.throws(() => planWorkingContext(messages.slice(0, -1), policy, '', [], 512), /没有结果/);
  assert.throws(() => planWorkingContext([messages[0], messages[2]], policy, '', [], 512), /孤立/);
});

test('事实引文必须来自指定实际工具结果；重复压缩保留旧事实和来源记录', () => {
  const fact = { text: '增长率为73%', call_id: 'old', quote: 'The verified growth rate is 73%.' };
  const messages: ModelMessage[] = [{ role: 'user', content: '核对增长率' }, ...group('old', fact.quote)];
  const plan = planWorkingContext(messages, policy, '', [], 512);
  const first = parseWorkingState(JSON.stringify(state([fact])), plan);
  const secondPlan = planWorkingContext([...workingMessages(plan, first), ...group('new', 'Another source.')], policy, '', [], 512);
  const second = parseWorkingState(JSON.stringify({ ...state(), constraints: [] }), secondPlan);
  assert.deepEqual(second.facts, [fact], '摘要模型遗漏旧事实时程序仍保留');
  assert.deepEqual(second.constraints, ['必须引用原文']);
  assert.ok(collectEvidence(workingMessages(secondPlan, second)).some(row => row.tool_call_id === 'old'));
  const invented = parseWorkingState(JSON.stringify(state([{ ...fact, call_id: 'invented' }])), plan);
  assert.equal(invented.facts.length, 0);
  assert.match(invented.missing.join(' '), /未经验证.*禁止当作已确认事实/);
  const paraphrase = parseWorkingState(JSON.stringify(state([{ ...fact, quote: 'Growth is 99%.' }])), plan);
  assert.equal(paraphrase.facts.length, 0);
  assert.match(paraphrase.missing.join(' '), /不匹配/);
  assert.throws(() => parseWorkingState('{"goal":', plan), /合法的 JSON/);
});

test('长引文先验证再保存连续短片段，并标记为定位摘录；不裁掉事实文字', () => {
  const quote = 'A'.repeat(120);
  const plan = planWorkingContext([{ role: 'user', content: '核对' }, ...group('old', quote)], policy, '', [], 512);
  const parsed = parseWorkingState(JSON.stringify(state([{ text: '完整事实及其限定', call_id: 'old', quote }])), plan);
  assert.equal(parsed.facts[0].quote.length, 100);
  assert.equal(parsed.facts[0].quote_excerpted, true);
  assert.equal(parsed.facts[0].text, '完整事实及其限定');
});

test('已保留事实无法放进目标容量时明确停止，不静默丢事实', () => {
  const messages: ModelMessage[] = [{ role: 'user', content: '核对' }, { role: 'assistant', content: JSON.stringify({
    kind: 'minimal_agent_context_v2', state: state([{ text: '汉'.repeat(5000), call_id: 'old', quote: '原文' }]), tool_records: [],
  }) }];
  assert.throws(() => planWorkingContext(messages, policy, '', [], 512), /必须保留的任务、事实/);
});

test('真实SDK的新策略计入摘要预算，只执行一次原工具；格式错误不提交历史', async t => {
  for (const valid of [true, false]) {
    const bridge = new PythonBridge({ ...process.env, DEEPSEEK_API_KEY: 'offline-test-key' });
    t.after(() => bridge.close());
    const config = await bridge.request<Configuration>('describe');
    config.context_policy = { strategy: 'working_memory', trigger_tokens: 12_000, target_tokens: 8_500 };
    let requests = 0;
    const fetcher: typeof fetch = async (_url, init) => {
      requests++;
      const request = JSON.parse(init!.body as string);
      const content = requests === 1 ? null : requests === 2 ? valid ? JSON.stringify(state()) : '{broken' : '73%';
      if (requests === 2) {
        assert.equal(request.tools, undefined, '内部整理不能调用工具');
        assert.deepEqual(request.response_format, { type: 'json_object' }, '使用SDK现成的JSON生成模式');
      }
      if (requests === 3) assert.match(JSON.stringify(request.messages), /minimal_agent_context_v2/);
      return new Response(JSON.stringify({ id: 'test', object: 'chat.completion', created: 1, model: config.model,
        choices: [{ index: 0, finish_reason: requests === 1 ? 'tool_calls' : 'stop', message: { role: 'assistant', content,
          ...(requests === 1 ? { tool_calls: [{ id: 'read', type: 'function', function: { name: 'read_webpage',
            arguments: JSON.stringify({ url: 'https://example.com/post' }) } }] } : {}) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }), { headers: { 'content-type': 'application/json' } });
    };
    const messages: ModelMessage[] = [{ role: 'user', content: '核对增长率' }];
    const before = structuredClone(messages);
    const result = await new VercelLoop(bridge, config, fetcher).run(messages, { fixtures: { read_webpage: {
      document_id: 'a'.repeat(64), url: 'https://example.com/post', content: 'A'.repeat(20000),
      content_format: 'text', total_chars: 20000, completeness: 'not_verified',
    } } });
    assert.equal(result.tool_calls, 1);
    if (valid) {
      assert.equal(result.error, null);
      assert.equal(result.model_requests, 3);
      assert.equal(result.total_tokens, 45);
      assert.equal(result.context_compactions[0].strategy, 'working_memory');
    } else {
      assert.match(result.error ?? '', /合法的 JSON/);
      assert.equal(requests, 2);
      assert.deepEqual(messages, before);
    }
  }
});
