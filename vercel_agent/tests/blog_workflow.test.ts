import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlogWorkflow, quoteCandidates } from '../blog_workflow.js';
import { PythonBridge, ROOT } from '../bridge.js';
import type { Configuration } from '../execution_runtime.js';

const answer = (text: string, reason = 'stop') => new Response(JSON.stringify({
  id: 'test', object: 'chat.completion', created: 1, model: 'deepseek-flash',
  choices: [{ index: 0, finish_reason: reason, message: { role: 'assistant', content: text } }],
  usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
}), { headers: { 'content-type': 'application/json' } });

test('quote candidates are bounded actual substrings, not paraphrased or merged sentences', () => {
  const source = 'We launched a tool API.\n' + 'A long source sentence with words '.repeat(30) + '.';
  const quotes = quoteCandidates(source);
  assert.ok(quotes.length);
  assert.ok(quotes.every(q => source.includes(q) && q.length >= 12 && q.length <= 220));
  assert.deepEqual(quoteCandidates('short'), []);
  const formerlyRejected = 'The solution we arrived at was to decouple what we thought of as the “brain” (Claude and its harness) from both the “hands” (sandboxes and tools that perform actions) and the “session” (the log of session events).';
  assert.equal(formerlyRejected.length, 213);
  assert.ok(quoteCandidates(formerlyRejected).includes(formerlyRejected), 'a valid 213-character whole quote must not be shortened to 200');
});

test('fixed workflow saves real notes once and fails closed on bad evidence, reads, truncation or budget', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'blog-workflow-')));
  const env = { ...process.env, DEEPSEEK_API_KEY: 'offline-test-key',
    MINIMAL_AGENT_TASK_COORDINATION: '0', MINIMAL_AGENT_CODEX_DELEGATION: '0',
    MINIMAL_AGENT_WEBPAGE_STORE_DIR: join(dir, 'snapshots'), MINIMAL_AGENT_OBSIDIAN_VAULT: join(dir, 'vault') };
  const id = execFileSync(join(ROOT, '.venv/bin/python'), ['-c',
    'from tool_library.webpage_store import save_webpage; print(save_webpage(url="https://example.com/blog", title="Agent loop", content="An agent uses tools in a loop. " * 100, footnotes_found=0, coverage_note="Not verified."))'],
    { cwd: ROOT, env, encoding: 'utf8' }).trim();
  const bridge = new PythonBridge(env);
  t.after(async () => { bridge.close(); await rm(dir, { recursive: true, force: true }); });
  const config = await bridge.request<Configuration>('describe');
  const fixtures = { read_webpage: { document_id: id, url: 'https://example.com/blog',
    content: 'An agent uses tools in a loop.', total_chars: 3000, truncated: true } };
  const draft = { summary: '文章介绍模型在循环中使用工具、观察工具结果并继续执行任务，工具反馈作为后续判断的上下文。', takeaway: '我的推论：应保存工具结果便于核查。',
    evidence_quote: 'An agent uses tools in a loop.' };
  const authored = { summary: draft.summary, takeaway: draft.takeaway, quote_index: 0 };
  let calls = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    calls++;
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.tools, undefined, 'host owns all tool invocation');
    if (JSON.stringify(payload.messages).includes('你是博客笔记的证据核对器'))
      return answer(JSON.stringify({checks:['summary_facts','quote_supports_core','takeaway_is_inference'].map(id=>({id,verdict:'supported',reason:'原文支持'})),
        core_match: { claim: '模型在循环中使用工具', evidence_field: 'evidence_quote' }, risk_checks: []}));
    return answer(JSON.stringify(authored));
  };
  const workflow = new BlogWorkflow(bridge, config, fetcher);
  const good = await workflow.run('https://example.com/blog', { fixtures });
  assert.equal(good.saved, true, good.error ?? 'missing save');
  assert.equal(good.model_requests, 2);
  assert.equal(good.tool_calls, 2);
  assert.deepEqual(good.graph_nodes, ['read', 'summarize', 'validate', 'review_evidence', 'save']);
  assert.match(await readFile(good.receipt.note_path, 'utf8'), /保存工具结果/);
  const wrong = await new BlogWorkflow(bridge, config, async () => answer(JSON.stringify({ ...authored, quote_index: 999 })))
    .run('https://example.com/blog', { fixtures });
  assert.equal(wrong.saved, false);
  assert.equal(wrong.tool_calls, 1, 'invalid quote must never reach save');
  const broken = await workflow.run('https://example.com/blog', { fixtures: { read_webpage: { error: { code: 'unavailable' } } } });
  assert.equal(broken.saved, false);
  assert.equal(broken.model_requests, 0, 'failed read must not waste a model request');
  const truncated = await new BlogWorkflow(bridge, config, async () => answer('{"summary":"partial', 'length'))
    .run('https://example.com/blog', { fixtures });
  assert.equal(truncated.saved, false);
  assert.equal(truncated.tool_calls, 1);
  const exhausted = await new BlogWorkflow(bridge, { ...config, max_tool_calls: 1 }, fetcher)
    .run('https://example.com/blog', { fixtures });
  assert.equal(exhausted.saved, false);
  assert.match(exhausted.error ?? '', /工具调用上限/);
  assert.equal(calls, 4);
  const markdown = await workflow.run('https://example.com/blog', { fixtures: { read_webpage:
    { ...fixtures.read_webpage, content_format: 'markdown', content: 'An [agent](https://example.com) uses tools in a loop.' } } });
  assert.equal(markdown.saved, true, markdown.error ?? 'missing save');
  assert.equal(markdown.tool_calls, 3, 'Markdown pages must read a text snapshot before summary');
  assert.equal(markdown.events.filter((e: any) => e.type === 'tool' && e.name === 'read_saved_webpage')[0].arguments.content_format, 'text');
  const irrelevant = await new BlogWorkflow(bridge, config, async (_url, init) => {
    const payload = JSON.parse(String(init?.body));
    return JSON.stringify(payload.messages).includes('你是博客笔记的证据核对器')
      ? answer(JSON.stringify({ checks: ['summary_facts', 'quote_supports_core', 'takeaway_is_inference']
          .map(id => ({ id, verdict: id === 'quote_supports_core' ? 'insufficient' : 'supported', reason: '真实引文不支持核心结论' })) }))
      : answer(JSON.stringify(authored));
  }).run('https://example.com/blog', { fixtures });
  assert.equal(irrelevant.saved, false);
  assert.match(irrelevant.error ?? '', /证据核对未通过/);
  assert.equal(irrelevant.tool_calls, 1, 'semantic rejection must occur before real save');
  assert.equal(irrelevant.model_requests, 2);
  const ungrounded = await new BlogWorkflow(bridge, config, async (_url, init) => {
    const payload = JSON.parse(String(init?.body));
    return JSON.stringify(payload.messages).includes('你是博客笔记的证据核对器')
      ? answer(JSON.stringify({ checks: ['summary_facts', 'quote_supports_core', 'takeaway_is_inference']
          .map(id => ({ id, verdict: 'supported', reason: '看似正确' })) }))
      : answer(JSON.stringify(authored));
  }).run('https://example.com/blog', { fixtures });
  assert.equal(ungrounded.saved, false, 'an ungrounded positive verdict must never cause a real write');
  assert.equal(ungrounded.tool_calls, 1);
  const noReviewBudget = await new BlogWorkflow(bridge, { ...config, max_model_requests: 1 }, async () => answer(JSON.stringify(authored)))
    .run('https://example.com/blog', { fixtures });
  assert.equal(noReviewBudget.saved, false);
  assert.equal(noReviewBudget.model_requests, 1);
  assert.equal(noReviewBudget.tool_calls, 1);
  assert.match(noReviewBudget.error ?? '', /模型请求总数/);
  await assert.rejects(workflow.run('file:///tmp/a'), /HTTP/);
});
