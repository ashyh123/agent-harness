import type { RunResult } from './execution_runtime.js';

export interface ContextEvalRow {
  task: string; repeat: number; strategy: 'legacy' | 'working_memory';
  checks: { passed: boolean; facts?: { answer_correct: boolean; quote_in_actual_read: boolean; quote_supports_fact: boolean }[] };
  result: RunResult | null;
  within_budget: boolean;
}
export function contextDecision(rows: ContextEvalRow[]) {
  const aggregate = (strategy: ContextEvalRow['strategy']) => {
    const subset = rows.filter(row => row.strategy === strategy);
    return { runs: subset.length, passed: subset.filter(row => row.checks.passed).length,
      verified_facts: subset.reduce((sum, row) => sum + (row.checks.facts ?? [])
        .filter(fact => fact.answer_correct && fact.quote_in_actual_read && fact.quote_supports_fact).length, 0),
      model_requests: subset.reduce((sum, row) => sum + (row.result?.model_requests ?? 0), 0),
      tool_calls: subset.reduce((sum, row) => sum + (row.result?.tool_calls ?? 0), 0),
      tokens: subset.reduce((sum, row) => sum + (row.result?.total_tokens ?? 0), 0),
      compactions: subset.reduce((sum, row) => sum + (row.result?.context_compactions.length ?? 0), 0) };
  };
  const legacy = aggregate('legacy'), working = aggregate('working_memory');
  const keys = new Set(rows.map(row => `${row.task}/${row.repeat}`));
  const balanced = rows.length > 0 && [...keys].every(key => rows.filter(row => `${row.task}/${row.repeat}` === key).length === 2
    && new Set(rows.filter(row => `${row.task}/${row.repeat}` === key).map(row => row.strategy)).size === 2);
  const perTask = [...new Set(rows.map(row => row.task))].map(task => ({ task,
    legacy: rows.filter(row => row.task === task && row.strategy === 'legacy' && row.checks.passed).length,
    working_memory: rows.filter(row => row.task === task && row.strategy === 'working_memory' && row.checks.passed).length }));
  const checks = {
    complete_pairs: balanced,
    hard_budgets_respected: rows.every(row => row.within_budget),
    both_strategies_exercised_compaction: legacy.compactions > 0 && working.compactions > 0,
    no_task_category_regression: perTask.every(row => row.working_memory >= row.legacy),
    verified_facts_not_worse: working.verified_facts >= legacy.verified_facts,
    improved: working.passed > legacy.passed || working.passed === legacy.passed && working.passed > 0
      && working.tokens <= legacy.tokens * 0.9 && working.model_requests <= legacy.model_requests,
  };
  return { adopt: Object.values(checks).every(Boolean), checks, legacy, working_memory: working, per_task: perTask,
    rule: '完整配对且预算合规；双方实际触发压缩；各任务类别通过数和有证据的事实数不下降；总通过数提高，或通过数相同而tokens至少减少10%且请求不增加。小样本只支持当前任务集的决策，不代表普遍优越。' };
}
