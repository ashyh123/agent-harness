import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MinimalHarness } from '../harness.js';
import type { Configuration } from '../execution_runtime.js';
import { PythonBridge, ROOT } from '../bridge.js';
import { SKILLS_ROOT } from '../skills.js';

function completion(content: string | null, calls: unknown[] = []) {
  return { id: 'offline', object: 'chat.completion', created: 1, model: 'deepseek-flash',
    choices: [{ index: 0, finish_reason: calls.length ? 'tool_calls' : 'stop', message: {
      role: 'assistant', content, ...(calls.length ? { tool_calls: calls } : {}),
    } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
}

test('工具进程重启且旧消息移除后，真实 SDK 从快照回查被省略证据并验收', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'webpage-recall-test-'));
  const env = { ...process.env, DEEPSEEK_API_KEY: 'offline-test-key', MINIMAL_AGENT_WEBPAGE_STORE_DIR: directory };
  const documentId = execFileSync(join(ROOT, '.venv/bin/python'), ['-c',
    'from tool_library.webpage_store import save_webpage; print(save_webpage(url="https://example.com/post", title="Report", content="A" * 11000 + "Times are simulated estimates.", footnotes_found=1, coverage_note="Not verified."))',
  ], { cwd: ROOT, env, encoding: 'utf8' }).trim();
  const previous = new PythonBridge(env);
  try {
    const old = await previous.request('capture_tool', { name: 'read_saved_webpage', arguments: {
      document_id: documentId, offset: 11000,
    } });
    assert.equal(old.content, 'Times are simulated estimates.');
  } finally { previous.close(); }

  const bridge = new PythonBridge(env);
  t.after(async () => { bridge.close(); await rm(directory, { recursive: true, force: true }); });
  const config = await bridge.request<Configuration>('describe');
  const requests: any[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    const request = JSON.parse(init!.body as string);
    requests.push(request);
    if (requests.length === 1) {
      assert.doesNotMatch(JSON.stringify(request.messages), /Times are simulated estimates\./);
      return new Response(JSON.stringify(completion(null, [{ id: 'recall-1', type: 'function', function: {
        name: 'read_saved_webpage', arguments: JSON.stringify({ document_id: documentId, offset: 11000 }),
      } }])), { headers: { 'content-type': 'application/json' } });
    }
    assert.equal(requests.length, 2);
    const returned = request.messages.find((message: any) => message.role === 'tool');
    assert.equal(returned.tool_call_id, 'recall-1');
    assert.equal(JSON.parse(returned.content).content, 'Times are simulated estimates.');
    return new Response(JSON.stringify(completion(
      '| 问题 | 原文讲解 | 证据 |\n|---|---|---|\n| 时间含义 | 模拟估计 | `Times are simulated estimates.` |\n来源：https://example.com/post',
    )), { headers: { 'content-type': 'application/json' } });
  };
  const { record } = await new MinimalHarness(bridge, config, { skills: SKILLS_ROOT, runs: join(directory, 'runs') }, fetcher)
    .run({ skill: 'webpage-reader', task: `工作摘要：保留文档 ID ${documentId}，证据位置 11000；时间的测量条件已省略，请回查。` });
  assert.equal(record.runtime_status, 'completed');
  assert.equal(record.automatic_checks?.passed, true);
  assert.equal(record.task_verdict, 'needs_review');
  assert.equal(record.result?.tool_calls, 1);
  assert.equal(record.result?.model_requests, 2);
  assert.equal(record.result?.events.find(event => event.type === 'tool').name, 'read_saved_webpage');
});
