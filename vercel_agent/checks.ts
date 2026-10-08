export interface CheckItem { name: string; passed: boolean; detail: string }
export interface QuoteCheck { row: number; quote: string; found_in_source: boolean }
export interface CheckReport { passed: boolean; items: CheckItem[]; quotes: QuoteCheck[]; scope: string }
export type SkillCheck = (answer: string, events: any[]) => CheckReport;

export const normaliseWhitespace = (value: string) => value.replace(/\s+/g, '');

/** 第一张 Markdown 表格的表头与数据行；分隔行被丢弃，单元格内的竖线不受支持。 */
export function tableRows(markdown: string): string[][] {
  const lines = markdown.split('\n').map(line => line.trim());
  const start = lines.findIndex(line => line.startsWith('|'));
  if (start < 0) return [];
  const end = lines.findIndex((line, index) => index > start && !line.startsWith('|'));
  return lines.slice(start, end < 0 ? undefined : end)
    .map(line => line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim()))
    .filter(cells => !cells.every(cell => /^:?-+:?$/.test(cell)));
}

// 只读取证据列，避免把正文里用反引号标出的字段名或 URL 当成引文。
// 当前 Skill 要求反引号；旧版 Skill 未作要求，因此单元格没有反引号时退回读取双引号。
function evidenceQuotes(answer: string): string[][] | null {
  const rows = tableRows(answer);
  const column = rows[0]?.findIndex(cell => cell.includes('证据')) ?? -1;
  if (column < 0) return null;
  return rows.slice(1).map(cells => {
    const cell = cells[column] ?? '';
    const ticked = [...cell.matchAll(/`([^`]+)`/g)].map(match => match[1]);
    return ticked.length ? ticked : [...cell.matchAll(/“([^”]+)”|"([^"]+)"/g)].map(match => match[1] ?? match[2]);
  });
}

export function checkWebpageReader(answer: string, events: any[]): CheckReport {
  const pages = events.filter(event => event.type === 'tool' && event.name === 'read_webpage'
    && typeof event.result?.content === 'string').map(event => event.result);
  const sources = pages.map(page => normaliseWhitespace(page.content));
  const rows = evidenceQuotes(answer);
  const quotes: QuoteCheck[] = (rows ?? []).flatMap((row, index) => row.map(quote => ({
    row: index + 1, quote, found_in_source: sources.some(source => source.includes(normaliseWhitespace(quote))),
  })));
  const emptyRows = (rows ?? []).flatMap((row, index) => row.length ? [] : [index + 1]);
  const found = quotes.filter(quote => quote.found_in_source).length;
  const cited = pages.find(page => typeof page.url === 'string' && answer.includes(page.url));
  const items: CheckItem[] = [
    { name: 'read_succeeded', passed: pages.length > 0,
      detail: pages.length ? `成功读取 ${pages.length} 次网页` : '没有成功的 read_webpage 结果' },
    { name: 'quotes_verbatim', passed: !!rows?.length && !emptyRows.length && found === quotes.length,
      detail: !rows ? '没有找到含“证据”列的表格'
        : !rows.length ? '事实表没有数据行'
        : `${found}/${quotes.length} 段引文逐字出现在工具原文中（只忽略空白）`
          + (emptyRows.length ? `；第 ${emptyRows.join('、')} 行证据列没有可核对的引文` : '') },
    { name: 'cites_source_url', passed: !!cited,
      detail: cited ? `答案包含工具返回的 URL：${cited.url}` : '答案没有包含工具返回的来源 URL' },
  ];
  return { passed: items.every(item => item.passed), items, quotes,
           scope: '只核对读取成功、引文出处与来源 URL；引文是否回答了问题、事实与限定是否准确仍需人工验收。' };
}

export const SKILL_CHECKS: Record<string, SkillCheck> = { 'webpage-reader': checkWebpageReader };
