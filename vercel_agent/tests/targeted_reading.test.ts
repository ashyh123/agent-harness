import test from 'node:test';
import assert from 'node:assert/strict';
import { targetedChecks, targetedPrompt } from '../targeted_reading.js';
import type { ReadingCase } from '../budget_eval.js';
import type { RunResult } from '../execution_runtime.js';

const task: ReadingCase = { id: 'targeted', url: 'https://example.com/blog', document_id: 'a'.repeat(64),
  text: 'Irrelevant introduction. Start with 20-50 tasks drawn from real failures. Unneeded appendix.', sections: [],
  facts: [{ id: 'size', question: 'How many tasks and from where?',
    answerPattern: '(?=[\\s\\S]*20[\\s\\S]*50)(?=[\\s\\S]*真实失败)',
    sourcePattern: '20-50 tasks drawn from real failures' }] };
const quote = 'Start with 20-50 tasks drawn from real failures.';
const output = { facts: [{ id: 'size', answer: '20–50个，来自真实失败', quote }],
  source_url: task.url, reading_scope: 'targeted', page_completeness: 'not_verified' };
function result(content = quote, answer: any = output): RunResult {
  const start = task.text.indexOf(content);
  return { answer: JSON.stringify(answer), error: null, events: [{ type: 'tool', name: 'read_saved_webpage',
    result: { document_id: task.document_id, content_format: 'text', offset: start,
      end_offset: start + content.length, content } }] } as RunResult;
}
test('只有相关原文已读且问题/证据齐全即可通过；不要求读取无关开头和附录', () => {
  const checked = targetedChecks(task, result());
  assert.equal(checked.passed, true);
  assert.ok(checked.coverage_fraction < 1);
  assert.equal(checked.manual_semantic_review_required, true);
  assert.match(targetedPrompt(task), /不要求全文覆盖/);
});
test('凭记忆回答正确但本轮没读到引文，仍拒绝', () => {
  assert.equal(targetedChecks(task, result('Irrelevant introduction.')).passed, false);
});
test('遗漏事实的来源限定，或改写引文，不能靠数字正确通过', () => {
  assert.equal(targetedChecks(task, result(quote, { ...output,
    facts: [{ ...output.facts[0], answer: '20–50个任务' }] })).passed, false);
  assert.equal(targetedChecks(task, result(quote, { ...output,
    facts: [{ ...output.facts[0], quote: quote.replace('real', 'actual') }] })).passed, false);
});
test('来源错、重复问题或宣称网页完整性已验证，均拒绝', () => {
  assert.equal(targetedChecks(task, result(quote, { ...output, source_url: 'https://wrong.example' })).passed, false);
  assert.equal(targetedChecks(task, result(quote, { ...output, facts: [...output.facts, ...output.facts] })).passed, false);
  assert.equal(targetedChecks(task, result(quote, { ...output, page_completeness: 'verified' })).passed, false);
});
