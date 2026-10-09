import type { Configuration, RunResult } from './agent.js';

export function scaledBudget(base: Configuration, multiplier: number): Configuration {
  if (![2, 3].includes(multiplier)) throw new Error('本次实验仅比较 2 倍、3 倍预算');
  return { ...base, max_steps: base.max_steps * multiplier,
    max_model_requests: base.max_model_requests * multiplier,
    max_tool_calls: base.max_tool_calls * multiplier, max_seconds: base.max_seconds * multiplier,
    max_output_tokens: base.max_output_tokens * multiplier };
}

export interface Fact {
  id: string; question: string; answerPattern: string; sourcePattern: string;
}
export interface ReadingCase {
  id: string; url: string; document_id: string; text: string; sections: string[]; facts: Fact[];
}
// Python 的网页读取偏移量按 Unicode 码点计数，不能用 JS 的 UTF-16 .length。
export const readingLength = (text: string) => Array.from(text).length;
export function readingPrompt(task: ReadingCase): string {
  const length = readingLength(task.text);
  return `完整阅读已采集的原文快照 document_id=${task.document_id}，URL=${task.url}，text 格式总长度 ${length} 字符。
必须实际覆盖 text 的 [0, ${length})，包括参考文献、附录和示例；用 read_saved_webpage，每次可取最多 10000 字符，按 next_offset 继续。可以同一轮并行读多个不同范围。不得把读到末尾当作中间也已读过。不要重新下载，不调用保存工具。
为控制篇幅，每个主要章节用一句不超过 20 个中文字概括，章节名如下（参考文献无需单独总结）：${JSON.stringify(task.sections)}。
另回答这些原文核对问题：${JSON.stringify(task.facts.map(({ id, question }) => ({ id, question })))}。每个答案附 12–100 字符的连续逐字英文引文，不改标点。压缩丢失证据时可回查，不能凭记忆编造。
最终只输出 JSON：{"sections":[{"section":"原章节名","summary":"简述"}],"overall":"总体结论，40字内","improvement":"自己的Agent优化推论，40字内","facts":[{"id":"问题ID","answer":"简短回答","quote":"逐字引文"}],"source_url":"实际URL","coverage":"如实说明已读和未读范围"}。未读完也可报告，但不能声称完成。`;
}

export function parseAnswer(answer: string | null): any {
  if (!answer) return null;
  try { return JSON.parse(answer.slice(answer.indexOf('{'), answer.lastIndexOf('}') + 1)); }
  catch { return null; }
}

export function readingChecks(task: ReadingCase, result: RunResult) {
  const length = readingLength(task.text);
  const reads = result.events.filter(event => event.type === 'tool' && event.name === 'read_saved_webpage'
    && event.result?.document_id === task.document_id && event.result?.content_format === 'text'
    && typeof event.result.content === 'string' && !event.result.error);
  const ranges = reads.map(event => [event.result.offset, event.result.end_offset] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  let covered = 0;
  const merged: [number, number][] = [];
  for (const [start, end] of ranges) {
    const previous = merged.at(-1);
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else merged.push([start, end]);
  }
  covered = merged.reduce((sum, [start, end]) => sum + end - start, 0);
  // 引文可能横跨相邻工具结果；只拼接真实读取且连续的区间，不能补未读空洞。
  const buffers: { start: number; end: number; content: string }[] = [];
  for (const event of [...reads].sort((a, b) => a.result.offset - b.result.offset)) {
    const { offset, end_offset, content } = event.result;
    const previous = buffers.at(-1);
    if (previous && offset <= previous.end) {
      if (end_offset > previous.end) previous.content += Array.from(content).slice(previous.end - offset).join('');
      previous.end = Math.max(previous.end, end_offset);
    } else buffers.push({ start: offset, end: end_offset, content });
  }
  const output = parseAnswer(result.answer);
  const facts = task.facts.map(fact => {
    const row = output?.facts?.find((row: any) => row.id === fact.id);
    const quote = typeof row?.quote === 'string' ? row.quote : '';
    const normalise = (value: string) => value.replace(/\s+/g, '');
    return { id: fact.id, answer_correct: new RegExp(fact.answerPattern, 'i').test(String(row?.answer ?? '')),
      quote_in_actual_read: quote.length >= 12
        && buffers.some(buffer => normalise(buffer.content).includes(normalise(quote))),
      quote_length_within_prompt: quote.length >= 12 && quote.length <= 100,
      quote_supports_fact: !!quote && new RegExp(fact.sourcePattern, 'i').test(quote) };
  });
  const sectionChecks = task.sections.map(section => ({ section,
    present: Array.isArray(output?.sections) && output.sections.some((row: any) => row.section === section
      && typeof row.summary === 'string' && row.summary.trim().length >= 5) }));
  const items = {
    runtime_completed: !result.error && !!result.answer,
    full_extracted_text_read: covered === length && merged.length === 1 && merged[0][0] === 0,
    section_summaries_present: sectionChecks.every(row => row.present),
    fact_answers_correct: facts.every(row => row.answer_correct),
    quotes_verified: facts.every(row => row.quote_in_actual_read && row.quote_supports_fact),
    quote_length_within_prompt: facts.every(row => row.quote_length_within_prompt),
    conclusion_and_inference: typeof output?.overall === 'string' && output.overall.length >= 5
      && typeof output?.improvement === 'string' && output.improvement.length >= 5,
    source_url_correct: output?.source_url === task.url,
  };
  const readChars = ranges.reduce((sum, [start, end]) => sum + end - start, 0);
  const contentItems = Object.entries(items).filter(([name]) => name !== 'quote_length_within_prompt');
  return { passed: Object.values(items).every(Boolean), content_checks_passed: contentItems.every(([, passed]) => passed),
    items, facts, sections: sectionChecks,
    covered_chars: covered, total_chars: length, coverage_fraction: covered / length,
    repeated_read_chars: readChars - covered, merged_ranges: merged,
    scope: '全文指提取快照；核对读取区间、逐节产物、预设事实和逐字引文，不能自动证明全部摘要的语义保真。' };
}
