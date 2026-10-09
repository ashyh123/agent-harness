import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { MinimalHarness } from '../harness.js';
import type { Configuration } from '../agent.js';
import { PythonBridge, ROOT } from '../bridge.js';
import { SKILLS_ROOT } from '../skills.js';
import { checkObsidianBlogReader } from '../checks.js';

const response = (content: string | null, calls: unknown[] = []) => ({ id: 'offline', object: 'chat.completion', created: 1,
  model: 'deepseek-flash', choices: [{ index: 0, finish_reason: calls.length ? 'tool_calls' : 'stop',
    message: { role: 'assistant', content, ...(calls.length ? { tool_calls: calls } : {}) } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
const call = (id: string, name: string, args: unknown) => ({ id, type: 'function',
  function: { name, arguments: JSON.stringify(args) } });

test('Skill 通过真实 SDK 和工具读取、简化、实际落盘、回读并自动验收', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'obsidian-harness-test-')));
  const vault = join(directory, 'vault');
  const env = { ...process.env, DEEPSEEK_API_KEY: 'offline-test-key',
    MINIMAL_AGENT_WEBPAGE_STORE_DIR: join(directory, 'snapshots'), MINIMAL_AGENT_OBSIDIAN_VAULT: vault };
  const documentId = execFileSync(join(ROOT, '.venv/bin/python'), ['-c',
    'from tool_library.webpage_store import save_webpage; print(save_webpage(url="https://example.com/blog", title="Agent learning", content="An agent uses tools in a loop. " * 600, footnotes_found=0, coverage_note="Not verified."))',
  ], { cwd: ROOT, env, encoding: 'utf8' }).trim();
  const bridge = new PythonBridge(env);
  t.after(async () => { bridge.close(); await rm(directory, { recursive: true, force: true }); });
  const config = await bridge.request<Configuration>('describe');
  const summary = '文章说明模型如何在循环中选择工具、观察结果并继续判断任务，工具反馈构成上下文。';
  let requests = 0;
  let notePath = '';
  const fetcher: typeof fetch = async (_url, init) => {
    const request = JSON.parse(init!.body as string);
    requests++;
    let body;
    if (requests === 1) body = response(null, [
      call('read-1', 'read_saved_webpage', { document_id: documentId, limit: 10000 }),
      call('read-2', 'read_saved_webpage', { document_id: documentId, offset: 10000, limit: 10000 }),
    ]);
    else if (requests === 2) body = response('已读取文章：An agent uses tools in a loop. 需要简化分析并保存；全文完整性未验证。');
    else if (requests === 3) body = response(null, [call('save', 'save_obsidian_blog', {
      document_id: documentId, summary, takeaway: '我的推论：为工具循环保留事件记录，便于查错和复用结果。',
      evidence_quote: 'An agent uses tools in a loop.',
    })]);
    else {
      assert.fail('保存已回读核验后不应额外请求模型确认');
    }
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  };
  const { record } = await new MinimalHarness(bridge, config, { skills: SKILLS_ROOT, runs: join(directory, 'runs') }, fetcher)
    .run({ skill: 'obsidian-blog-reader', task: `回查 ${documentId}，简化分析并存入 Obsidian。` });
  assert.equal(record.runtime_status, 'completed');
  assert.equal(record.result?.completion_source, 'verified_tool');
  assert.equal(record.automatic_checks?.passed, true);
  assert.equal(record.task_verdict, 'needs_review');
  assert.equal(record.result?.model_requests, 3);
  assert.equal(record.result?.tool_calls, 3);
  assert.equal(record.result?.context_compactions.length, 1, 'Skill 与来源索引保留后按剩余容量压缩，仍可实际保存');
  const saved = record.result!.events.find(event => event.name === 'save_obsidian_blog').result;
  notePath = saved.note_path;
  const bytes = await readFile(notePath);
  assert.match(bytes.toString(), new RegExp(summary));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), saved.sha256);
  assert.match(await readFile(saved.original_path, 'utf8'), /An agent uses tools in a loop/);
  assert.match(notePath, new RegExp(vault));
});

test('模型只声称已保存，但没有实际写入工具结果时拒绝验收', () => {
  assert.equal(checkObsidianBlogReader('已保存到 Obsidian', []).passed, false);
});
