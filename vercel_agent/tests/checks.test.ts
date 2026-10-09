import test from 'node:test';
import assert from 'node:assert/strict';
import { checkWebpageReader, tableRows } from '../checks.js';

const url = 'https://example.com/post';
const page = (content: string) => [{ type: 'model' }, { type: 'tool', name: 'read_webpage',
  result: { url, title: 'Post', content, truncated: false } }];
const source = 'Our first partner is Ironclad.\n\n这些技术“没有绝对的好，只有合不合适”。\n\n[网页脚注]\nTimes are simulated estimates.';
const answer = (evidence: string[], extra = `\n\n来源：${url}`) =>
  `说明：\`read_webpage\` 返回 \`truncated=false\`。\n\n| 问题 | 原文讲解 | 证据 |\n|---|---|---|\n`
  + evidence.map((cell, index) => `| 问题${index + 1} | 讲解 | ${cell} |`).join('\n') + extra;
const item = (report: ReturnType<typeof checkWebpageReader>, name: string) => report.items.find(entry => entry.name === name)!;

test('回查原文也参与引文验收；不能使用未实际回读的其他范围', () => {
  const events = [{ type: 'tool', name: 'read_saved_webpage', result: {
    url, document_id: 'a'.repeat(64), content: 'Times are simulated estimates.', offset: 11000,
  } }];
  assert.equal(checkWebpageReader(answer(['`Times are simulated estimates.`']), events).passed, true);
  assert.equal(checkWebpageReader(answer(['`Our first partner is Ironclad.`']), events).passed, false);
});

test('不放宽引文匹配：Markdown 的跨格式引文需实际回读 text，改写仍拒绝', () => {
  const markdown = [{ type: 'tool', name: 'read_webpage', result: {
    url, content: 'The **outcome** is the final state.', content_format: 'markdown',
  } }];
  const quote = answer(['`The outcome is the final state.`']);
  assert.equal(checkWebpageReader(quote, markdown).passed, false);
  const text = { type: 'tool', name: 'read_saved_webpage', result: {
    url, content: 'The outcome is the final state.', content_format: 'text',
  } };
  assert.equal(checkWebpageReader(quote, [...markdown, text]).passed, true);
  assert.equal(checkWebpageReader(answer(['`The outcome is a final state.`']), [...markdown, text]).passed, false);
});

test('逐字引文、正文外脚注与来源齐全时通过；说明文字里的反引号不当作引文', () => {
  const report = checkWebpageReader(answer(['`Our first partner is Ironclad.`', '`Times are  simulated\testimates.`']), page(source));
  assert.equal(report.passed, true);
  assert.deepEqual(report.quotes.map(quote => quote.quote), ['Our first partner is Ironclad.', 'Times are  simulated\testimates.']);
  assert.match(report.scope, /人工验收/);
});

test('大小写或引号标点改动都判为未找到，并指出所在行', () => {
  const report = checkWebpageReader(answer(['`our first partner is Ironclad`', '`这些技术"没有绝对的好，只有合不合适"`']), page(source));
  assert.equal(report.passed, false);
  assert.equal(item(report, 'quotes_verbatim').passed, false);
  assert.deepEqual(report.quotes.map(quote => [quote.row, quote.found_in_source]), [[1, false], [2, false]]);
  assert.match(item(report, 'quotes_verbatim').detail, /0\/2/);
});

test('单元格没有反引号时读取双引号；仍有一行没有引文就不通过', () => {
  const report = checkWebpageReader(answer(['“Our first partner is Ironclad.”', '"Times are simulated estimates."', '见原文']), page(source));
  assert.equal(report.quotes.length, 2);
  assert.ok(report.quotes.every(quote => quote.found_in_source));
  assert.equal(item(report, 'quotes_verbatim').passed, false);
  assert.match(item(report, 'quotes_verbatim').detail, /第 3 行证据列没有可核对的引文/);
});

test('读取失败、缺少证据表或来源 URL 时分别报告', () => {
  const failed = checkWebpageReader(`读取失败：\`${url}\` 返回 403。`, [{ type: 'tool', name: 'read_webpage', result: { error: { code: 'http_error' } } }]);
  assert.deepEqual(failed.items.map(entry => entry.passed), [false, false, false]);
  assert.equal(failed.quotes.length, 0);
  assert.match(item(failed, 'quotes_verbatim').detail, /没有找到含“证据”列的表格/);
  const noUrl = checkWebpageReader(answer(['`Our first partner is Ironclad.`'], ''), page(source));
  assert.deepEqual(noUrl.items.map(entry => entry.passed), [true, true, false]);
});

test('只解析第一张表格并忽略分隔行', () => {
  assert.deepEqual(tableRows('前言\n| a | b |\n| :-- | --: |\n| 1 | 2 |\n\n| c |\n|---|\n| 3 |'), [['a', 'b'], ['1', '2']]);
});
