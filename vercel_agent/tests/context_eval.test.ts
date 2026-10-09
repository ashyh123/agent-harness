import test from 'node:test';
import assert from 'node:assert/strict';
import { contextDecision, type ContextEvalRow } from '../context_eval.js';

function row(task: string, strategy: ContextEvalRow['strategy'], passed: boolean, compact = true): ContextEvalRow {
  return { task, repeat: 1, strategy, checks: { passed }, within_budget: true,
    result: { total_tokens: 100, model_requests: 3, tool_calls: 2, context_compactions: compact ? [{}] : [] } as any };
}
test('没有实际压缩或配对不完整，不能据此切换默认策略', () => {
  assert.equal(contextDecision([row('a', 'legacy', false, false), row('a', 'working_memory', true, false)]).adopt, false);
  assert.equal(contextDecision([row('a', 'working_memory', true)]).adopt, false);
});
test('总通过数增加且任务类别不退步、预算合规时允许切换；总数掩盖退步则拒绝', () => {
  assert.equal(contextDecision([row('a', 'legacy', false), row('a', 'working_memory', true)]).adopt, true);
  assert.equal(contextDecision([row('a', 'legacy', true), row('a', 'working_memory', false),
    row('b', 'legacy', false), row('b', 'working_memory', true), row('c', 'legacy', false), row('c', 'working_memory', true)]).adopt, false);
  const exceeded = row('a', 'working_memory', true); exceeded.within_budget = false;
  assert.equal(contextDecision([row('a', 'legacy', false), exceeded]).adopt, false);
});
test('同样通过率必须有至少10%的tokens节省且请求不增加才算改善', () => {
  const before = row('a', 'legacy', true), after = row('a', 'working_memory', true);
  assert.equal(contextDecision([before, after]).adopt, false);
  after.result!.total_tokens = 89;
  assert.equal(contextDecision([before, after]).adopt, true);
  after.result!.model_requests = 4;
  assert.equal(contextDecision([before, after]).adopt, false);
});
