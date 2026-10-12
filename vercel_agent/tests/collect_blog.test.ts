import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, readFile, writeFile, rename, mkdir, readdir, symlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { collectBlog } from '../collect_blog.js';
import { createCard } from '../article_cards.js';
const response = (output: unknown) => new Response(JSON.stringify({ id: 'test', object: 'chat.completion',
  created: 1, model: 'deepseek-flash', choices: [{ index: 0, finish_reason: 'stop', message: {
    role: 'assistant', content: JSON.stringify(output) } }],
  usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }),
{ headers: { 'content-type': 'application/json' } });

test('one preview and one brief; renamed, edited cards are reused byte for byte without requests', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'collect-card-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { ...process.env, MINIMAL_AGENT_WEBPAGE_STORE_DIR: join(dir, 'sources'),
    MINIMAL_AGENT_OBSIDIAN_VAULT: join(dir, 'vault') };
  let requests = 0;
  const fake: typeof fetch = async (_url, init) => {
    requests++;
    const body = JSON.parse(String(init?.body));
    const prompt = JSON.parse(body.messages.find((m: any) => m.role === 'user').content);
    assert.ok(prompt.preview.length <= 1800);
    assert.equal(body.max_tokens ?? body.max_completion_tokens, 320);
    return response({ brief: '文章介绍模型使用工具并观察结果的循环，帮助理解工具反馈如何影响下一轮判断。', topics: ['工具调用'] });
  };
  const options = { env, fetcher: fake, reports: join(dir, 'records'), fixtures: { read_webpage: {
    title: 'Tools', url: 'https://example.com/blog', content: 'An agent uses tools in a loop. '.repeat(400) } } };
  const good = await collectBlog('https://example.com/blog#section', options);
  assert.equal(good.status, 'complete', good.error ?? '');
  assert.equal(good.model_requests, 1); assert.equal(good.total_tokens, 20);
  assert.deepEqual(good.topics, ['工具调用']);
  assert.equal(good.reading_status, '待阅读'); assert.equal(good.existing, false);
  const original = await readFile(good.note_path!, 'utf8');
  assert.match(original, /## 我的笔记/); assert.match(original, /source: "https:\/\/example.com\/blog"/);
  const edited = original.replace('status: "待阅读"', 'status: 已读')
    .replace('## 我的笔记', '## 我的笔记\n\n这是我的学习心得，下一步验证工具错误处理。')
    + '\n[[我的概念]]\n[我自己的链接](https://example.com/mine)\n';
  const moved = join(dirname(good.note_path!), '学习', '我改过的标题.md');
  await mkdir(dirname(moved)); await writeFile(good.note_path!, edited); await rename(good.note_path!, moved);
  const cached = await collectBlog('https://example.com/blog', options);
  assert.equal(cached.status, 'complete'); assert.equal(cached.model_requests, 0);
  assert.equal(cached.total_tokens, 0); assert.equal(requests, 1);
  assert.equal(cached.note_path, moved); assert.equal(cached.existing, true);
  assert.equal(cached.reading_status, '已读'); assert.equal(await readFile(moved, 'utf8'), edited);
  assert.equal((await readdir(dirname(good.note_path!))).filter(p => p.endsWith('.md')).length, 0);
});

test('unavailable preview and malformed brief preserve a real bookmark, with truthful partial status and usage', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'collect-failure-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const options = { env: { ...process.env, MINIMAL_AGENT_OBSIDIAN_VAULT: join(dir, 'vault') },
    reports: join(dir, 'records'), fetcher: async () => response({ brief: 'x'.repeat(121), topics: [] }) };
  const failed = await collectBlog('https://example.com/unavailable', { ...options,
    fixtures: { read_webpage: { error: { code: 'unavailable' } } } });
  assert.equal(failed.status, 'partial'); assert.ok(failed.note_path);
  assert.equal(failed.model_requests, 0); assert.equal(failed.brief_available, false);
  assert.match(await readFile(failed.note_path!, 'utf8'), /暂无自动简介/);
  const cached = await collectBlog('https://example.com/unavailable', options);
  assert.equal(cached.status, 'partial'); assert.equal(cached.model_requests, 0);
  const malformed = await collectBlog('https://example.com/malformed', { ...options,
    fixtures: { read_webpage: { title: 'Demo', content: 'A short introduction.' } } });
  assert.equal(malformed.status, 'partial'); assert.equal(malformed.total_tokens, 20);
  assert.equal(malformed.model_requests, 1); assert.equal(malformed.brief_available, false);
});

test('card creation refuses a symlink vault and never overwrites a conflicting file', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'collect-safe-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'real')); await symlink(join(dir, 'real'), join(dir, 'alias'));
  const draft = { title: 'A', brief: 'An introduction.', topics: [], scope: 'short preview' };
  await assert.rejects(createCard(join(dir, 'alias'), 'https://example.com/a', draft), /符号链接/);
  const card = await createCard(join(dir, 'real'), 'https://example.com/a', draft);
  await writeFile(card.path, 'my unrelated contents');
  await assert.rejects(createCard(join(dir, 'real'), 'https://example.com/a', draft), /未覆盖/);
  assert.equal(await readFile(card.path, 'utf8'), 'my unrelated contents');
});

test('OMP command validates one URL, guards concurrent submissions and displays receipt without starting a model turn', async () => {
  const { default: extension, collectionUrl, formatCollection } = await import(new URL('../omp_collect_extension.mjs', import.meta.url).href);
  for (const input of ['', 'https://example.com https://other.example', 'file:///tmp/note', 'https://user:pass@example.com'])
    assert.throws(() => collectionUrl(input));
  const commands: Record<string, any> = {}, callbacks: any[] = [], messages: any[] = [], notifications: string[] = [];
  let starts = 0;
  const result = { status: 'partial', note_path: '/vault/note.md', reading_status: '待阅读', topics: [], existing: false,
    total_tokens: 60, usage_complete: true, model_requests: 3, elapsed_seconds: 1,
    error: '简介待补充', record_path: '/record.json' };
  extension({ registerCommand: (name: string, command: any) => { commands[name] = command; }, on: () => {},
    sendMessage: (m: any, options: any) => { assert.equal(options.triggerTurn, false); messages.push(m); } },
    () => { starts++; return { promise: Promise.resolve(result), cancel: () => {} }; });
  const ctx = { ui: { notify: (s: string) => notifications.push(s), setStatus: () => {} },
    setTimeout: (fn: any) => callbacks.push(fn) };
  await commands.collect.handler('https://example.com', ctx);
  await commands.collect.handler('https://example.com', ctx);
  assert.equal(callbacks.length, 1); assert.ok(notifications.some(s => s.includes('等待')));
  await callbacks[0]();
  assert.equal(starts, 1); assert.equal(messages.length, 1);
  assert.match(messages[0].content, /卡片已保存，简介待补充/);
  assert.doesNotMatch(messages[0].content, /文章卡片已收录/);
  assert.match(formatCollection({ ...result, usage_complete: false }), /至少60/);
});
