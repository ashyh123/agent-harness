import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MinimalHarness } from '../harness.js';
import type { Configuration } from '../agent.js';
import { PythonBridge } from '../bridge.js';
import { SKILLS_ROOT } from '../skills.js';

function completion(text: string | null, calls: unknown[] = []) {
  return { id: 'offline', object: 'chat.completion', created: 1, model: 'deepseek-flash',
    choices: [{ index: 0, finish_reason: calls.length ? 'tool_calls' : 'stop', message: {
      role: 'assistant', content: text, ...(calls.length ? { tool_calls: calls } : {}),
    } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
}
const calculation = completion(null, [{ id: 'calc-1', type: 'function', function: {
  name: 'calculate', arguments: JSON.stringify({ operation: 'multiply', a: 123, b: 456 }),
} }]);

async function setup(t: any, responses: unknown[], limits: Partial<Configuration> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'minimal-harness-test-'));
  const bridge = new PythonBridge({ ...process.env, DEEPSEEK_API_KEY: 'offline-test-key' });
  t.after(async () => { bridge.close(); await rm(directory, { recursive: true, force: true }); });
  const config = { ...await bridge.request<Configuration>('describe'), ...limits };
  const requests: any[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    requests.push(JSON.parse(init!.body as string));
    const next = responses.shift();
    assert.ok(next, '不应发生额外的模型请求');
    return new Response(JSON.stringify(next), { headers: { 'content-type': 'application/json' } });
  };
  const runs = join(directory, 'runs');
  return { harness: new MinimalHarness(bridge, config, { skills: SKILLS_ROOT, runs }, fetcher), requests, runs, bridge };
}

test('不同 Skill 复用同一工具库，任务上下文隔离，运行记录不覆盖，完成仍待验收', async t => {
  const { harness, requests, runs } = await setup(t, [calculation, completion('结果：56088'), completion('请补充网页 URL')]);
  const first = await harness.run({ skill: 'calculation-audit', task: '请计算 123 乘 456' });
  const second = await harness.run({ skill: 'webpage-reader', task: '请阅读网页' });
  assert.deepEqual(requests[0].tools, requests[2].tools);
  assert.match(JSON.stringify(requests[0].messages), /算术必须使用 calculate/);
  assert.match(JSON.stringify(requests[2].messages), /搜索摘要不能代替指定网页原文/);
  assert.doesNotMatch(JSON.stringify(requests[2].messages), /123|56088|算术必须/);
  assert.equal(first.record.result?.tool_calls, 1);
  assert.equal(first.record.result?.model_requests, 2);
  assert.equal(first.record.result?.events.find(event => event.type === 'tool').result.result, 56088);
  assert.equal(second.record.result?.model_requests, 1);
  assert.equal(second.record.result?.tool_calls, 0);
  assert.equal(first.record.runtime_status, 'completed');
  assert.equal(first.record.task_verdict, 'needs_review');
  assert.equal(first.record.automatic_checks, null);
  assert.equal(second.record.runtime_status, 'completed');
  assert.equal(second.record.task_verdict, 'failed_checks');
  assert.equal(second.record.automatic_checks?.items.find(item => item.name === 'read_succeeded')?.passed, false);
  assert.equal(JSON.parse(await readFile(join(second.directory, 'run.json'), 'utf8')).task_verdict, 'failed_checks');
  assert.match(await readFile(join(second.directory, 'answer.md'), 'utf8'), /任务验收：failed_checks[\s\S]*自动检查：未通过/);
  assert.notEqual(first.directory, second.directory);
  assert.equal((await readdir(runs)).length, 2);
  const saved = JSON.parse(await readFile(join(first.directory, 'run.json'), 'utf8'));
  assert.equal(saved.skill.name, 'calculation-audit');
  assert.ok(saved.finished_at);
  assert.equal(saved.result.answer, '结果：56088');
  assert.match(await readFile(join(first.directory, 'answer.md'), 'utf8'), /needs_review[\s\S]*56088/);
});

test('沿用共享预算，停止后保存工具证据，任务不能标记完成', async t => {
  const { harness, requests } = await setup(t, [calculation], { max_model_requests: 1 });
  const result = await harness.run({ skill: 'calculation-audit', task: '请计算 123 乘 456' });
  assert.equal(requests.length, 1);
  assert.equal(result.record.runtime_status, 'failed');
  assert.equal(result.record.task_verdict, 'not_completed');
  assert.equal(result.record.result?.answer, null);
  assert.equal(result.record.result?.tool_calls, 1);
  assert.match(result.record.result?.error ?? '', /模型请求总数上限/);
  const saved = JSON.parse(await readFile(join(result.directory, 'run.json'), 'utf8'));
  assert.equal(saved.result.events.find((event: any) => event.type === 'tool').result.result, 56088);
  assert.match(await readFile(join(result.directory, 'answer.md'), 'utf8'), /运行未完成/);
});

test('桥接中断时也留下失败任务记录，不伪造答案', async t => {
  const { harness, bridge, requests } = await setup(t, []);
  bridge.close();
  const { record, directory } = await harness.run({ skill: 'calculation-audit', task: '请计算' });
  assert.equal(requests.length, 0);
  assert.equal(record.runtime_status, 'failed');
  assert.equal(record.task_verdict, 'not_completed');
  assert.equal(record.result, null);
  assert.ok(record.harness_error);
  assert.ok(JSON.parse(await readFile(join(directory, 'run.json'), 'utf8')).finished_at);
});

test('无效任务或 Skill 在模型请求之前拒绝，不产生运行目录', async t => {
  const { harness, requests, runs } = await setup(t, []);
  await assert.rejects(harness.run({ skill: 'calculation-audit', task: '  ' }), /任务不能为空/);
  await assert.rejects(harness.run({ skill: '../outside', task: '任务' }), /Skill 名称/);
  await assert.rejects(harness.run({ skill: 'unknown', task: '任务' }), /ENOENT/);
  assert.equal(requests.length, 0);
  await assert.rejects(readdir(runs), /ENOENT/);
});
