import type { RunResult } from './agent.js';
import { readingChecks, readingLength, parseAnswer, type ReadingCase } from './budget_eval.js';

/** 按问题验收；读取覆盖率只作诊断，不作为必须读完全文的门槛。 */
export function targetedPrompt(task: ReadingCase): string {
  return `核对这篇已保存博客的三个事实问题。document_id=${task.document_id}，URL=${task.url}，text长度${readingLength(task.text)}字符。
${JSON.stringify(task.facts.map(({ id, question }) => ({ id, question })))}
只用 read_saved_webpage 读取此快照的text，按需选择范围；不要求全文覆盖。证据足够即可回答，不重新下载，不调用保存工具。每问附12–100字符的连续逐字英文引文，保留影响答案的来源、条件和例外。没有实际读到的证据不能凭记忆补充。
最终只输出JSON：{"facts":[{"id":"问题ID","answer":"简短中文回答","quote":"逐字引文"}],"source_url":"实际URL","reading_scope":"targeted","page_completeness":"not_verified"}。缺证据时明确说明未完成。`;
}

export function targetedChecks(task: ReadingCase, result: RunResult) {
  const checked = readingChecks({ ...task, sections: [] }, result);
  const output = parseAnswer(result.answer);
  const expected = task.facts.map(fact => fact.id);
  const items = {
    runtime_completed: checked.items.runtime_completed,
    exactly_requested_facts: Array.isArray(output?.facts) && output.facts.length === expected.length
      && expected.every(id => output.facts.filter((fact: any) => fact?.id === id).length === 1),
    fact_answers_correct: checked.items.fact_answers_correct,
    quotes_verified: checked.items.quotes_verified,
    quote_length_within_prompt: checked.items.quote_length_within_prompt,
    source_url_correct: checked.items.source_url_correct,
    scope_honest: output?.reading_scope === 'targeted' && output?.page_completeness === 'not_verified',
  };
  return { passed: Object.values(items).every(Boolean), items, facts: checked.facts,
    covered_chars: checked.covered_chars, total_chars: checked.total_chars,
    coverage_fraction: checked.coverage_fraction, repeated_read_chars: checked.repeated_read_chars,
    merged_ranges: checked.merged_ranges, manual_semantic_review_required: true,
    scope: '只验收指定问题及本轮实际读到的证据；覆盖率为诊断项。正则只能筛查预设事实，限定条件、否定和引文解释仍需人工复核。' };
}
