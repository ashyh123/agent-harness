import test from 'node:test';
import assert from 'node:assert/strict';
import { dataChecks, matchesExpected, type DataCase } from '../diverse_eval.js';
import type { RunResult } from '../agent.js';

const url = 'https://example.com/data.txt';
const task: DataCase = { id: 'sample', prompt: '', expected: { rows: [{ year: 2024, value: 1.29 }], missing: null },
  requiredUrls: [url], calculations: [1.29] };
const result = (answer: unknown, events: any[]): RunResult => ({ answer: JSON.stringify(answer), error: null, events } as RunResult);
const answer = { rows: [{ year: 2024, value: 1.29 }], missing: null };
const reads = [{ type: 'tool', name: 'read_webpage', result: { url } },
  { type: 'tool', name: 'calculate', result: { result: 1.29 } }];

test('正确输出仍必须有实际读取和计算证据', () => {
  assert.equal(dataChecks(task, result(answer, reads)).passed, true);
  assert.equal(dataChecks(task, result(answer, [])).passed, false);
  assert.equal(dataChecks(task, result(answer, reads.slice(0, 1))).passed, false);
});
test('拒绝单位错误、缺失值转零与数字字符串', () => {
  assert.equal(matchesExpected(task.expected, { rows: [{ year: 2024, value: 129 }], missing: null }), false);
  assert.equal(matchesExpected(task.expected, { ...answer, missing: 0 }), false);
  assert.equal(matchesExpected(1.29, '1.29'), false);
});
test('舍入容差与无序数组不能掩盖重复行', () => {
  assert.equal(matchesExpected(0.12, 0.1200000000000001), true);
  assert.equal(matchesExpected([{ a: 1 }, { a: 2 }], [{ a: 2 }, { a: 1 }]), true);
  assert.equal(matchesExpected([{ a: 1 }, { a: 2 }], [{ a: 1 }, { a: 1 }]), false);
});
test('单位允许附加解释，额外来源必须实际读过', () => {
  const withUnit = { ...task, expected: { ...task.expected, unit: 'ppm', source_urls: [url] } };
  const extra = 'https://example.com/about';
  const output = { ...answer, unit: 'ppm (micromol/mol, dry air)', source_urls: [url, extra] };
  assert.equal(dataChecks(withUnit, result(output, [...reads, { type: 'tool', name: 'read_webpage', result: { url: extra } }])).passed, true);
  assert.equal(dataChecks(withUnit, result(output, reads)).passed, false);
  assert.equal(dataChecks(withUnit, result({ ...output, unit: 'ppb', source_urls: [url] }, reads)).passed, false);
});
test('诚实说明不支持格式单独通过错误处理，不算完成数据提取', () => {
  const blocked = { ...task, unsupported: true };
  const checked = dataChecks(blocked, result({ status: 'blocked', data: null },
    [{ type: 'tool', name: 'read_webpage', result: { error: { code: 'unsupported_content' } } }]));
  assert.equal(checked.passed, false);
  assert.equal(checked.failure_handling_passed, true);
  assert.equal(dataChecks(blocked, result({ status: 'blocked', data: 99 }, reads)).failure_handling_passed, false);
});
