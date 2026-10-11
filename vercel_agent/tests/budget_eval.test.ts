import test from 'node:test';
import assert from 'node:assert/strict';
import { readingChecks, readingPrompt, readingLength, scaledBudget, type ReadingCase } from '../budget_eval.js';
import type { Configuration, RunResult } from '../execution_runtime.js';

const task: ReadingCase = { id: 'example', url: 'https://example.com/', document_id: 'a'.repeat(64),
  text: 'Read the source carefully before answering.', sections: ['Main'],
  facts: [{ id: 'f', question: 'How to read?', answerPattern: 'carefully', sourcePattern: 'carefully' }] };
const answer = JSON.stringify({ sections: [{ section: 'Main', summary: '基于原文仔细核对' }],
  facts: [{ id: 'f', answer: 'carefully', quote: task.text }], overall: '仔细阅读原文后回答', improvement: '保存原文以支持回查', source_url: task.url });
const read = (offset: number, end: number) => ({ type: 'tool', name: 'read_saved_webpage',
  result: { document_id: task.document_id, content_format: 'text', offset, end_offset: end,
    content: task.text.slice(offset, end) } });
const result = (events: any[]): RunResult => ({ error: null, answer, events } as RunResult);

test('含非BMP字符的快照与重叠区间按Python码点计数，不能误报全文缺两字', () => {
  const text = 'AB😀verified growth is 73%.';
  const characters = Array.from(text);
  const unicodeTask: ReadingCase = { ...task, text, sections: [],
    facts: [{ id: 'f', question: '增长率?', answerPattern: '73', sourcePattern: '73%' }] };
  assert.equal(readingLength(text), text.length - 1);
  assert.match(readingPrompt(unicodeTask), new RegExp(`总长度 ${characters.length} 字符`));
  const events = [[0, 6], [1, characters.length]].map(([offset, end]) => ({ type: 'tool', name: 'read_saved_webpage',
    result: { document_id: task.document_id, content_format: 'text', offset, end_offset: end,
      content: characters.slice(offset, end).join('') } }));
  const checked = readingChecks(unicodeTask, { ...result(events), answer: JSON.stringify({ sections: [],
    facts: [{ id: 'f', answer: '73%', quote: 'verified growth is 73%.' }],
    overall: '已核对原文增长率', improvement: '保留原文支持精确回查', source_url: task.url }) });
  assert.equal(checked.passed, true);
  assert.equal(checked.covered_chars, characters.length);
});

test('首尾都读到仍拒绝中间遗漏；口头全文读完不替代范围记录', () => {
  assert.equal(readingChecks(task, result([read(0, 10), read(20, task.text.length)])).items.full_extracted_text_read, false);
  assert.equal(readingChecks(task, result([])).passed, false);
});
test('全文和证据齐全才通过，重复读取单独计量', () => {
  const checks = readingChecks(task, result([read(0, task.text.length), read(0, 10)]));
  assert.equal(checks.passed, true);
  assert.equal(checks.repeated_read_chars, 10);
  const changed = { ...result([read(0, task.text.length)]), answer: answer.replace('Read the source', 'Read a source') };
  assert.equal(readingChecks(task, changed).items.quotes_verified, false);
});
test('正确事实和正确来源都必须存在，不能只靠一段匹配引文', () => {
  const changed = { ...result([read(0, task.text.length)]), answer: answer.replace('"answer":"carefully"', '"answer":"wrong"') };
  assert.equal(readingChecks(task, changed).passed, false);
});
test('真实引文跨两个相邻读取区间时仍有完整证据，中间缺段则拒绝', () => {
  assert.equal(readingChecks(task, result([read(0, 20), read(20, task.text.length)])).items.quotes_verified, true);
  assert.equal(readingChecks(task, result([read(0, 19), read(20, task.text.length)])).items.quotes_verified, false);
});
test('倍数预算扩大所有执行与输出上限，保留上下文配置和默认值', () => {
  const base = { max_steps: 5, max_model_requests: 8, max_tool_calls: 8, max_seconds: 90, max_output_tokens: 512,
    context_policy: { trigger_tokens: 10000 } } as Configuration;
  const scaled = scaledBudget(base, 3);
  assert.equal(scaled.max_steps, 15);
  assert.equal(scaled.max_output_tokens, 1536);
  assert.equal(scaled.context_policy, base.context_policy);
  assert.equal(base.max_steps, 5);
});
