import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObsidianKnowledge, articleIdentity, validateConceptLinks } from '../obsidian_knowledge.js';
import { PythonBridge } from '../bridge.js';
import type { Configuration } from '../execution_runtime.js';

const summary = '文章介绍模型使用工具调用，并通过执行环境完成动作。';
const quote = 'Agents use tools and sandboxes to perform actions.';
const material = { title: 'Agent tools', source: 'https://example.com/blog', document_id: 'a'.repeat(64), summary, evidence_quote: quote };
const links = [{ concept_id: 'tools', reason: '文章讨论工具调用', basis: 'summary', excerpt: '文章介绍模型使用工具调用' }];
const note = (source: string, title = 'Agent tools') => `---\ntitle: ${JSON.stringify(title)}\nsource: ${JSON.stringify(source)}\ndocument_id: "${'a'.repeat(64)}"\n---\n\n## 简化内容\n\n${summary}\n\n## 对我的 Agent 的启发\n\n我的推论：便于验收。\n\n## 原文证据\n\n> ${quote}\n\n## 来源与阅读范围\n\n真实保存格式。\n`;
const response = (output: unknown) => new Response(JSON.stringify({
  id: 'test', object: 'chat.completion', created: 1, model: 'deepseek-flash',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(output) } }],
  usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
}), { headers: { 'content-type': 'application/json' } });

test('article identity ignores anchors, preserves queries, and rejects non-web sources', () => {
  assert.equal(articleIdentity('https://example.com/blog#first').id, articleIdentity('https://example.com/blog#second').id);
  assert.notEqual(articleIdentity('https://example.com/blog?id=1').id, articleIdentity('https://example.com/blog?id=2').id);
  assert.throws(() => articleIdentity('file:///etc/passwd'));
  assert.throws(() => articleIdentity('https://user:secret@example.com/blog'));
});

test('unknown, duplicate and fabricated concept evidence is rejected; sparse results are valid', () => {
  assert.deepEqual(validateConceptLinks({ links: [] }, material), []);
  assert.deepEqual(validateConceptLinks({ links }, material), links);
  for (const invalid of [[{ ...links[0], concept_id: 'invented' }], [links[0], links[0]],
    [{ ...links[0], excerpt: '这句话不在保存的摘要中' }], [{ ...links[0], basis: 'takeaway' }],
    [{ ...links[0], concept_id: 'mcp' }]]) {
    assert.throws(() => validateConceptLinks({ links: invalid }, material));
  }
});

test('real files form shared concepts, merge article versions, cache, and preserve user additions', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'knowledge-')));
  const bridge = new PythonBridge();
  t.after(async () => { bridge.close(); await rm(dir, { recursive: true, force: true }); });
  const config = await bridge.request<Configuration>('describe');
  let calls = 0;
  const indexer = new ObsidianKnowledge(dir, config, async (_url, init) => {
    calls++;
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.tools, undefined);
    assert.ok(payload.max_tokens <= 1024);
    return response({ links });
  });
  const a = join(dir, 'version-a.md'); const b = join(dir, 'version-b.md'); const c = join(dir, 'other.md');
  await writeFile(a, note('https://example.com/blog#one'));
  await writeFile(b, note('https://example.com/blog#two', 'Revised title'));
  await writeFile(c, note('https://other.example/article'));
  const before = await readFile(a, 'utf8');
  const first = await indexer.index(a);
  assert.equal(first.total_tokens, 20);
  assert.equal(first.article_count, 1);
  await writeFile(first.article_path, await readFile(first.article_path, 'utf8') + '\n我的补充，不要覆盖。\n');
  const second = await indexer.index(b);
  assert.equal(second.article_path, first.article_path);
  assert.equal(second.version_count, 2);
  const third = await indexer.index(c);
  assert.equal(third.article_count, 2);
  assert.equal(third.version_count, 3);
  assert.match(await readFile(first.article_path, 'utf8'), /我的补充，不要覆盖/);
  const concept = await readFile(join(dir, '知识图谱/概念/工具调用.md'), 'utf8');
  assert.equal((concept.match(/^- \[\[/gm) ?? []).length, 2, 'one link per article, not one per version');
  const state = JSON.parse(await readFile(join(dir, '知识图谱/.index.json'), 'utf8'));
  for (const file of Object.keys(state.files)) {
    const content = await readFile(join(dir, file), 'utf8');
    for (const match of content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
      await readFile(join(dir, match[1] + '.md'), 'utf8');
    }
  }
  assert.equal((await indexer.index(a)).status, 'already_indexed');
  assert.equal(calls, 3, 'cached notes consume no model call');
  assert.equal(await readFile(a, 'utf8'), before, 'original reading note is untouched');
  const id = articleIdentity('https://example.com/blog').id;
  state.articles[id].versions['version-a.md'].taxonomy_hash = 'old-policy';
  await writeFile(join(dir, '知识图谱/.index.json'), JSON.stringify(state));
  assert.equal((await indexer.index(a)).status, 'indexed', 'changed classification rules invalidate prior cache');
  assert.equal(calls, 4);
  const damaged = (await readFile(first.article_path, 'utf8')).replace('共同概念表示主题关联', '我编辑了自动区');
  await writeFile(first.article_path, damaged);
  await assert.rejects(indexer.index(c), /自动区被修改/);
  assert.equal(await readFile(first.article_path, 'utf8'), damaged);
  assert.equal(calls, 4, 'conflict stops before further API cost');
});

test('invalid model output, outside notes, symlinks and existing user targets cannot create graph nodes', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'knowledge-reject-')));
  const bridge = new PythonBridge();
  t.after(async () => { bridge.close(); await rm(dir, { recursive: true, force: true }); });
  const config = await bridge.request<Configuration>('describe');
  const path = join(dir, 'note.md'); await writeFile(path, note(material.source));
  const indexer = new ObsidianKnowledge(dir, config, async () => response({ links: [{ ...links[0], excerpt: '虚构的文字没有实际出处' }] }));
  await assert.rejects(indexer.index(path), /依据不在笔记/);
  await assert.rejects(readFile(join(dir, '知识图谱/.index.json')), { code: 'ENOENT' });
  const link = join(dir, 'link.md'); await symlink(path, link);
  await assert.rejects(indexer.index(link), /符号链接/);
  const sub = join(dir, '知识图谱');
  await assert.rejects(new ObsidianKnowledge(sub, config).index(path), /vault内/);
  await writeFile(join(sub, '首页.md'), '已有个人笔记');
  const valid = new ObsidianKnowledge(dir, config, async () => response({ links }));
  await assert.rejects(valid.index(path), /目标文件已有内容/);
  assert.equal(await readFile(join(sub, '首页.md'), 'utf8'), '已有个人笔记');
  await assert.rejects(readFile(join(sub, '.index.json')), { code: 'ENOENT' });
});
