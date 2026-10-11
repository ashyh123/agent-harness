import { parseAnswer, readingChecks, type ReadingCase } from './budget_eval.js';
import type { RunResult } from './execution_runtime.js';

export interface DataCase {
  id: string;
  prompt: string;
  expected: Record<string, unknown>;
  requiredUrls: string[];
  calculations?: number[];
  unsupported?: boolean;
  search?: boolean;
  explanationPattern?: string;
}

// 数值允许舍入误差；对象必须包含所有基准字段，数组允许调整顺序。
export function matchesExpected(expected: unknown, actual: any): boolean {
  if (typeof expected === 'number') return typeof actual === 'number' && Number.isFinite(actual)
    && Math.abs(expected - actual) <= Math.max(0.00001, Math.abs(expected) * 0.00001);
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    const remaining = [...actual];
    for (const value of expected) {
      const index = remaining.findIndex(row => matchesExpected(value, row));
      if (index < 0) return false;
      remaining.splice(index, 1);
    }
    return true;
  }
  if (expected !== null && typeof expected === 'object') return actual !== null && typeof actual === 'object'
    && Object.entries(expected).every(([key, value]) => matchesExpected(value, actual[key]));
  return expected === actual;
}

export function dataChecks(task: DataCase, result: RunResult) {
  const events = result.events.filter(event => event.type === 'tool');
  const reads = events.filter(event => event.name === 'read_webpage' && !event.result?.error);
  const output = parseAnswer(result.answer);
  const urlsRead = reads.map(event => event.result?.url);
  const { source_urls: expectedSources, ...expectedData } = task.expected;
  const actualData = output && { ...output };
  // 单位带解释仍是 ppm；额外来源允许，但每个引用必须有真实读取记录。
  if (expectedData.unit === 'ppm' && /^ppm(?:\s*\([^)]*\))?$/.test(String(output?.unit ?? ''))) actualData.unit = 'ppm';
  const sourcesCorrect = !expectedSources || Array.isArray(output?.source_urls)
    && (expectedSources as string[]).every(url => output.source_urls.includes(url))
    && output.source_urls.every((url: string) => urlsRead.includes(url));
  const items = {
    runtime_completed: !result.error && !!result.answer,
    expected_fields: matchesExpected(expectedData, actualData) && sourcesCorrect,
    sources_actually_read: task.requiredUrls.every(url => urlsRead.includes(url)),
    calculated_with_tools: (task.calculations ?? []).every(value => events.some(event => event.name === 'calculate'
      && matchesExpected(value, event.result?.result))),
    searched_if_requested: !task.search || events.some(event => event.name === 'web_search'
      && Array.isArray(event.result?.results) && event.result.results.length > 0),
    explanation_correct: !task.explanationPattern || new RegExp(task.explanationPattern, 'i').test(String(output?.note ?? '')),
  };
  const handling = task.unsupported ? !result.error && output?.status === 'blocked' && output?.data === null
    && events.some(event => event.name === 'read_webpage' && event.result?.error?.code === 'unsupported_content') : null;
  // 无法读取原文的任务仍算未完成；诚实报告工具边界单独记分。
  return { passed: !task.unsupported && Object.values(items).every(Boolean), items,
    failure_handling_passed: handling, expected: task.expected, actual: output,
    successful_read_urls: urlsRead, boundary_case: !!task.unsupported };
}

export function longReadingChecks(papers: ReadingCase[], result: RunResult) {
  let output: any;
  try { output = JSON.parse(result.answer ?? ''); } catch { output = null; }
  const perPaper = papers.map(p => {
    const checked = readingChecks({ ...p, sections: [] }, { ...result,
      answer: JSON.stringify(output?.papers?.find((row: any) => row.id === p.id) ?? null) });
    const { full_extracted_text_read, fact_answers_correct, quotes_verified, quote_length_within_prompt } = checked.items;
    const core = full_extracted_text_read && fact_answers_correct && quotes_verified;
    return { ...checked, passed: core && quote_length_within_prompt, content_checks_passed: core,
      items: { full_extracted_text_read, fact_answers_correct, quotes_verified, quote_length_within_prompt } };
  });
  return { passed: !result.error && !!output && perPaper.every(row => row.passed),
    content_checks_passed: !result.error && !!output && perPaper.every(row => row.content_checks_passed), per_paper: perPaper };
}
