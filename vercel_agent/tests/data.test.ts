import test from 'node:test';
import assert from 'node:assert/strict';
import type { ModelMessage } from 'ai';
import { LangGraphLoop } from '../langgraph_loop.js';
import type { Configuration } from '../execution_runtime.js';
import { PythonBridge } from '../bridge.js';
import { collectEvidence, compactedMessages } from '../context.js';

function response(content: string | null, name?: string, args?: unknown) {
  return { id: 'data-test', object: 'chat.completion', created: 1, model: 'deepseek-flash',
    choices: [{ index: 0, finish_reason: name ? 'tool_calls' : 'stop', message: {
      role: 'assistant', content, ...(name ? { tool_calls: [{ id: name, type: 'function',
        function: { name, arguments: JSON.stringify(args) } }] } : {}),
    } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
}

test('真实 SDK 复用共享数据工具，查询全量内存数据并在新任务释放 ID', async t => {
  const bridge = new PythonBridge({ ...process.env, DEEPSEEK_API_KEY: 'offline-test-key' });
  t.after(() => bridge.close());
  const config = await bridge.request<Configuration>('describe');
  assert.ok(config.tools.some(tool => tool.name === 'read_data'));
  assert.ok(config.tools.some(tool => tool.name === 'query_data'));
  let requests = 0;
  let datasetId = '';
  const fetcher: typeof fetch = async (_url, init) => {
    const request = JSON.parse(init!.body as string);
    requests++;
    let body;
    if (requests === 1) body = response(null, 'read_data', { text: 'n\n2\n10\n3\n', data_format: 'csv', limit: 1 });
    else if (requests === 2) {
      const read = JSON.parse(request.messages.find((message: any) => message.role === 'tool').content);
      datasetId = read.dataset_id;
      assert.equal(read.returned_records, 1);
      body = response(null, 'query_data', { dataset_id: datasetId, aggregate: 'sum', aggregate_column: 'n' });
    } else {
      const sum = JSON.parse(request.messages.filter((message: any) => message.role === 'tool').at(-1).content);
      assert.equal(sum.value, 15, '不能只计算预览中的第一行');
      body = response('{"sum":15}');
    }
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  };
  const result = await new LangGraphLoop(bridge, config, fetcher).run([{ role: 'user', content: '统计 CSV' }]);
  assert.equal(result.error, null);
  assert.equal(result.model_requests, 3);
  assert.equal(result.tool_calls, 2);
  assert.equal(result.answer, '{"sum":15}');
  await bridge.request('start');
  const forgotten = await bridge.request('call_tool', { name: 'query_data', arguments: { dataset_id: datasetId } });
  assert.equal(forgotten.error.code, 'data_not_found');
});

test('压缩大型数据结果仍保留数据 ID、来源、字段与分页位置，可在本轮回查', () => {
  const messages: ModelMessage[] = [{ role: 'user', content: '继续提取' }, { role: 'tool', content: [{
    type: 'tool-result', toolName: 'read_data', toolCallId: 'data-read', output: { type: 'json', value: {
      dataset_id: 'a'.repeat(64), source_url: 'https://example.com/data.csv', format: 'csv',
      columns: ['id', 'name'], offset: 0, next_offset: 5, has_more: true, data: 'x'.repeat(4000),
    } },
  }] }];
  const result: any = collectEvidence(compactedMessages(messages, '还需要后面的记录'))[0].result;
  assert.equal(result.dataset_id, 'a'.repeat(64));
  assert.deepEqual(result.columns, ['id', 'name']);
  assert.equal(result.next_offset, 5);
  assert.equal(result.data, undefined);
  assert.equal(result.data_omitted, true);
  assert.match(result.recall, /query_data/);
});

test('真实 SDK 压缩后 query_data 能统计仍在内存的全部原始记录，不重新解析', async t => {
  const bridge = new PythonBridge({ ...process.env, DEEPSEEK_API_KEY: 'offline-test-key' });
  t.after(() => bridge.close());
  const config = await bridge.request<Configuration>('describe');
  config.context_policy = { trigger_tokens: 8_000, target_tokens: 7_000 };
  let requests = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    const request = JSON.parse(init!.body as string);
    requests++;
    let body;
    if (requests === 1) body = response(null, 'read_data', {
      text: JSON.stringify(Array.from({ length: 6 }, (_, i) => ({ n: i + 1, note: '汉'.repeat(500) }))), limit: 100,
    });
    else if (requests === 2) {
      assert.equal(request.tools, undefined, '本次请求仅负责摘要');
      body = response('数据已解析，接下来统计 n 列之和。');
    } else if (requests === 3) {
      const memory = JSON.parse(request.messages.at(-1).content);
      const record = memory.tool_records.find((record: any) => record.tool_name === 'read_data');
      assert.equal(record.result.data_omitted, true);
      body = response(null, 'query_data', { dataset_id: record.result.dataset_id, aggregate: 'sum', aggregate_column: 'n' });
    } else {
      const sum = JSON.parse(request.messages.filter((message: any) => message.role === 'tool').at(-1).content);
      assert.equal(sum.value, 21);
      body = response('{"sum":21}');
    }
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  };
  const result = await new LangGraphLoop(bridge, config, fetcher).run([{ role: 'user', content: '计算所有记录 n 之和' }]);
  assert.equal(result.error, null);
  assert.equal(result.answer, '{"sum":21}');
  assert.equal(result.context_compactions.length, 1);
  assert.equal(result.model_requests, 4);
  assert.equal(result.tool_calls, 2);
  assert.equal(result.events.filter(event => event.name === 'read_data').length, 1);
});

test('无效分页参数返回具体字段错误，模型可修正且复用原数据，失败仍计入预算', async t => {
  const bridge = new PythonBridge({ ...process.env, DEEPSEEK_API_KEY: 'offline-test-key' });
  t.after(() => bridge.close());
  const config = await bridge.request<Configuration>('describe');
  let requests = 0;
  let datasetId = '';
  const fetcher: typeof fetch = async (_url, init) => {
    const request = JSON.parse(init!.body as string);
    requests++;
    let body;
    if (requests === 1) body = response(null, 'read_data', { text: '[{"n":1},{"n":2}]' });
    else if (requests === 2) {
      datasetId = JSON.parse(request.messages.find((message: any) => message.role === 'tool').content).dataset_id;
      body = response(null, 'query_data', { dataset_id: datasetId, offset: -1 });
    } else if (requests === 3) {
      const error = request.messages.filter((message: any) => message.role === 'tool').at(-1).content;
      assert.match(error, /offset/);
      assert.match(error, /greater_than_equal/);
      body = response(null, 'query_data', { dataset_id: datasetId, aggregate: 'count' });
    } else {
      assert.equal(JSON.parse(request.messages.filter((message: any) => message.role === 'tool').at(-1).content).value, 2);
      body = response('{"count":2}');
    }
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  };
  const result = await new LangGraphLoop(bridge, config, fetcher).run([{ role: 'user', content: '统计行数' }]);
  assert.equal(result.error, null);
  assert.equal(result.answer, '{"count":2}');
  assert.equal(result.model_requests, 4);
  assert.equal(result.tool_calls, 3);
  assert.equal(result.events.filter(event => event.name === 'read_data').length, 1);
  assert.equal(result.events.filter(event => event.result?.error?.code === 'sdk_validation_error').length, 1);
});
