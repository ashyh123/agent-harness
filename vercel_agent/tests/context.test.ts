import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelMessage } from 'ai';
import { LangGraphLoop } from '../langgraph_loop.js';
import type { Configuration } from '../execution_runtime.js';
import { PythonBridge, ROOT } from '../bridge.js';
import { collectEvidence, estimateTokens } from '../context.js';

function completion(content: string | null, calls: unknown[] = [], finish = calls.length ? 'tool_calls' : 'stop') {
  return { id: 'offline', object: 'chat.completion', created: 1, model: 'deepseek-flash',
    choices: [{ index: 0, finish_reason: finish, message: {
      role: 'assistant', content, ...(calls.length ? { tool_calls: calls } : {}),
    } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
}
function call(id: string, name: string, args: unknown) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}
const pageCall = () => completion(null, [call('page-1', 'read_webpage', { url: 'https://example.com/post' })]);
const page = { document_id: 'a'.repeat(64), url: 'https://example.com/post', title: 'Report',
  content: 'A'.repeat(8_000), content_format: 'text', total_chars: 8_032, truncated: true,
  completeness: 'not_verified', coverage_note: 'Not verified.' };
async function setup(t: any, responses: any[], env: NodeJS.ProcessEnv = process.env) {
  const bridge = new PythonBridge({ ...env, DEEPSEEK_API_KEY: 'offline-test-key' });
  t.after(() => bridge.close());
  const config = await bridge.request<Configuration>('describe');
  // 固定本组网页压缩实验的工具集合，避免新工具的 schema 改变容量基准。
  config.tools = config.tools.filter(tool => !['read_data', 'query_data'].includes(tool.name));
  config.context_policy = { strategy: 'legacy', trigger_tokens: 6_000, target_tokens: 4_500 };
  const requests: any[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    requests.push(JSON.parse(init!.body as string));
    const body = responses.shift();
    assert.ok(body, '发生未预期的额外模型请求');
    return body instanceof Response ? body : new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  };
  return { agent: new LangGraphLoop(bridge, config, fetcher), config, requests };
}

test('真实 SDK 自动压缩后从真实快照回查被摘要遗漏的证据；下一轮沿用压缩历史', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-context-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { ...process.env, MINIMAL_AGENT_WEBPAGE_STORE_DIR: directory };
  const fact = 'The verified growth rate is 73%.';
  const documentId = execFileSync(join(ROOT, '.venv/bin/python'), ['-c',
    `from tool_library.webpage_store import save_webpage; print(save_webpage(url="https://example.com/post", title="Report", content="A" * 8000 + ${JSON.stringify(fact)}, footnotes_found=0, coverage_note="Not verified."))`,
  ], { cwd: ROOT, env, encoding: 'utf8' }).trim();
  const { agent, requests } = await setup(t, [
    pageCall(), completion('已获得报告预览，需要回查末尾的增长率。'),
    completion(null, [call('recall-1', 'read_saved_webpage', { document_id: documentId, offset: 8000, limit: 100 })]),
    completion(fact), completion('下一轮回答'),
  ], env);
  const messages: ModelMessage[] = [{ role: 'user', content: '读取报告，核实末尾的增长率。' }];
  const notices: string[] = [];
  const result = await agent.run(messages, {
    fixtures: { read_webpage: { ...page, document_id: documentId, content: page.content + fact } },
    onNotice: notice => notices.push(notice),
  });
  assert.equal(result.error, null);
  assert.equal(result.answer, fact);
  assert.equal(result.model_requests, 4);
  assert.equal(result.tool_calls, 2);
  assert.equal(result.total_tokens, 60, '摘要用量也计入总用量');
  assert.deepEqual(result.events.filter(event => event.type === 'model').map(event => event.kind),
    ['vercel', 'vercel_context_compaction', 'vercel', 'vercel']);
  assert.equal(result.context_compactions.length, 1);
  assert.ok(result.context_compactions[0].output_estimated_tokens <= 4_500);
  assert.equal(notices.length, 2);
  assert.deepEqual(notices, result.notices);
  assert.equal(requests[1].tools, undefined, '摘要模型不执行工具');
  assert.ok(requests[1].max_tokens > 0 && requests[1].max_tokens <= 1_024, '摘要输出上限受剩余上下文容量约束');
  const continued = JSON.stringify(requests[2].messages);
  assert.doesNotMatch(continued, /A{100}/);
  assert.doesNotMatch(continued, /The verified growth rate/);
  assert.match(continued, new RegExp(documentId));
  assert.match(continued, /not_verified/);
  assert.equal(requests[2].messages.some((message: any) => message.role === 'tool' || message.tool_calls), false,
    '整组已完成调用被替换，不留下孤立 ID');
  assert.equal(requests[2].messages.at(-1).role, 'assistant', '进度摘要在当前任务之后，不能表现为任务重新提交');
  const returned = requests[3].messages.find((message: any) => message.role === 'tool');
  assert.equal(returned.tool_call_id, 'recall-1');
  assert.equal(JSON.parse(returned.content).content, fact);
  assert.equal(result.events.filter(event => event.name === 'read_webpage').length, 1);
  messages.push({ role: 'user', content: '继续对话' });
  const next = await agent.run(messages);
  assert.equal(next.error, null);
  assert.doesNotMatch(JSON.stringify(requests[4].messages), /A{100}/);
  assert.match(JSON.stringify(requests[4].messages), new RegExp(documentId));
  const ranges = collectEvidence(messages).find(record => record.tool_name === 'read_saved_webpage')!.result as any;
  assert.equal(ranges.offset, 8000);
  assert.equal(ranges.end_offset, 8000 + fact.length);
});

test('短上下文不压缩、不多发请求', async t => {
  const { agent, requests } = await setup(t, [completion('你好')]);
  const result = await agent.run([{ role: 'user', content: '你好' }]);
  assert.equal(result.error, null);
  assert.equal(requests.length, 1);
  assert.deepEqual(result.context_compactions, []);
  assert.deepEqual(result.notices, []);
});

test('摘要没有完整生成时强制停止，不提交历史，不重跑工具', async t => {
  const { agent, requests } = await setup(t, [pageCall(), completion('半截摘要', [], 'length')]);
  const messages: ModelMessage[] = [{ role: 'user', content: '读取网页' }];
  const before = structuredClone(messages);
  const result = await agent.run(messages, { fixtures: { read_webpage: page } });
  assert.match(result.error ?? '', /摘要没有完整生成/);
  assert.equal(requests.length, 2);
  assert.equal(result.tool_calls, 1);
  assert.equal(result.context_compactions.length, 0);
  assert.deepEqual(messages, before);
});

test('预算不够摘要加续跑两次时，压缩请求不会发出', async t => {
  const { agent, requests } = await setup(t, [pageCall()]);
  const result = await agent.run([{ role: 'user', content: '读取网页' }], {
    fixtures: { read_webpage: page }, limits: { max_model_requests: 2 },
  });
  assert.match(result.error ?? '', /预算不足以完成上下文压缩/);
  assert.equal(requests.length, 1);
  assert.equal(result.model_requests, 1);
  assert.equal(result.tool_calls, 1);
  assert.deepEqual(result.notices, []);
});

test('摘要请求遇到 HTTP 错误时不续跑，也不提交压缩历史', async t => {
  const { agent, requests } = await setup(t, [pageCall(), new Response(JSON.stringify({ error: { message: 'offline unavailable' } }), {
    status: 503, headers: { 'content-type': 'application/json' },
  })]);
  const messages: ModelMessage[] = [{ role: 'user', content: '读取网页' }];
  const before = structuredClone(messages);
  const result = await agent.run(messages, { fixtures: { read_webpage: page }, maxRetries: 1 });
  assert.match(result.error ?? '', /503/);
  assert.equal(requests.length, 2, '摘要不进行自动重试');
  assert.equal(result.model_requests, 2);
  assert.deepEqual(messages, before);
});

test('无法达到目标容量的摘要不能作为压缩成功提交', async t => {
  const { agent, requests } = await setup(t, [pageCall(), completion('未缩短的内容'.repeat(1000))]);
  const messages: ModelMessage[] = [{ role: 'user', content: '读取网页' }];
  const before = structuredClone(messages);
  const result = await agent.run(messages, { fixtures: { read_webpage: page } });
  assert.match(result.error ?? '', /未压缩到目标容量/);
  assert.equal(requests.length, 2);
  assert.deepEqual(result.context_compactions, []);
  assert.deepEqual(messages, before);
});

test('必须保留的用户输入太大时明确停止，不悄悄裁掉任务', async t => {
  const { agent, requests } = await setup(t, []);
  const messages: ModelMessage[] = [{ role: 'user', content: '任务'.repeat(4000) }];
  const before = structuredClone(messages);
  const result = await agent.run(messages);
  assert.match(result.error ?? '', /必须保留/);
  assert.equal(requests.length, 0);
  assert.deepEqual(messages, before);
  assert.ok(estimateTokens('汉'.repeat(100)) > estimateTokens('a'.repeat(100)));
});

test('上下文压缩后仍支持输出精简重试，复用摘要且不恢复长正文', async t => {
  const { agent, requests } = await setup(t, [pageCall(), completion('网页预览已获取，覆盖未核实。'),
    completion('半截回答', [], 'length'), completion('完整简答')]);
  const messages: ModelMessage[] = [{ role: 'user', content: '读取网页' }];
  const result = await agent.run(messages, { fixtures: { read_webpage: page } });
  assert.equal(result.error, null);
  assert.equal(result.compact_retry_used, true);
  assert.equal(result.context_compactions.length, 1);
  assert.equal(result.model_requests, 4);
  assert.equal(result.tool_calls, 1);
  assert.doesNotMatch(JSON.stringify(requests[3].messages), /A{100}|半截回答/);
  assert.match(JSON.stringify(requests[3].messages), /重新生成精简答案/);
  assert.doesNotMatch(JSON.stringify(messages), /重新生成精简答案/);
});

test('连续压缩保留旧来源索引和 Skill 指令，两次摘要共享外层五次预算', async t => {
  const secondId = 'b'.repeat(64);
  const { agent, config, requests } = await setup(t, [pageCall(), completion('第一份报告已读预览。'),
    completion(null, [call('page-2', 'read_webpage', { url: 'https://example.com/post' })]),
    completion('两份预览已获得，未核实全文。'), completion('完成简述')]);
  config.system_prompt += '\n保留的 Skill 验收规则：必须诚实标明覆盖范围。';
  let reads = 0;
  const original = agent.bridge.request.bind(agent.bridge);
  agent.bridge.request = async (op: string, args?: any) => {
    const result = await original(op, args);
    if (op === 'call_tool' && args.name === 'read_webpage' && ++reads === 2) return { ...result, document_id: secondId };
    return result;
  };
  const messages: ModelMessage[] = [{ role: 'user', content: '读取两份报告' }];
  const result = await agent.run(messages, { fixtures: { read_webpage: page } });
  assert.equal(result.error, null);
  assert.equal(result.context_compactions.length, 2);
  assert.equal(result.model_requests, 5);
  const finalInput = JSON.stringify(requests[4].messages);
  assert.match(finalInput, new RegExp(page.document_id));
  assert.match(finalInput, new RegExp(secondId));
  assert.match(finalInput, /保留的 Skill 验收规则/);
  assert.doesNotMatch(finalInput, /A{100}/);
});
