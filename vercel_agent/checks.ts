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
  const pages = events.filter(event => event.type === 'tool' && ['read_webpage', 'read_saved_webpage'].includes(event.name)
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
      detail: pages.length ? `成功读取 ${pages.length} 次网页正文或快照` : '没有成功的网页正文或快照读取结果' },
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

export function checkObsidianBlogReader(answer: string, events: any[]): CheckReport {
  const reads = events.filter(event => event.type === 'tool' && ['read_webpage', 'read_saved_webpage'].includes(event.name)
    && typeof event.result?.content === 'string');
  const saves = events.filter(event => event.type === 'tool' && event.name === 'save_obsidian_blog'
    && event.result?.verified === true && ['saved', 'already_saved'].includes(event.result.status));
  const items: CheckItem[] = [
    { name: 'read_succeeded', passed: reads.length > 0, detail: `实际正文/快照读取 ${reads.length} 次` },
    { name: 'note_saved_and_verified', passed: saves.length > 0, detail: `工具完成写入并回读核验 ${saves.length} 次` },
    { name: 'summary_is_shorter', passed: saves.length > 0 && saves.every(event => event.result.summary_chars < event.result.source_chars),
      detail: '检查简化内容字符数小于提取原文，语义保真另行验收' },
    { name: 'reports_real_path', passed: saves.length > 0 && saves.every(event => answer.includes(event.result.note_path)),
      detail: '最终回答应包含工具返回的真实笔记路径' },
  ];
  return { passed: items.every(item => item.passed), items, quotes: [],
    scope: '工具内部核验来源、逐字引文与文件回读；自动检查核对实际保存与简化长度，不能证明概括和启发的语义正确。' };
}

export function checkPersonAgent(answer: string, events: any[]): CheckReport {
  const delegated = events.filter(event => event.type === 'tool' && event.name === 'delegate_to_codex' && event.result?.task_id);
  const succeeded = delegated.filter(event => event.result.status === 'completed'
    && event.result.task_verdict === 'needs_review' && !event.result.missing_files?.length);
  const reads = events.filter(event => event.type === 'tool' && event.name === 'read_delegated_file'
    && event.result?.hash_verified === true && typeof event.result.full_path === 'string'
    && succeeded.some(run => run.result.task_id === event.result.task_id));
  const hasFiles = succeeded.some(run => run.result.file_count > 0);
  const items: CheckItem[] = [
    { name: 'delegation_succeeded', passed: succeeded.length > 0 && succeeded.length === delegated.length,
      detail: `收到 ${succeeded.length}/${delegated.length} 份正常结束且无已知文件检查失败的子任务收据` },
    { name: 'parent_read_artifacts', passed: succeeded.length > 0 && (!hasFiles || reads.length > 0),
      detail: `父Agent实际回读并核对hash ${reads.length} 次；不能凭子Agent口头声称完成` },
    { name: 'reports_real_path', passed: succeeded.length > 0 && (!hasFiles || reads.some(read => answer.includes(read.result.full_path))),
      detail: '有文件时，最终回答须包含已回读文件的实际绝对路径' },
  ];
  return { passed: items.every(item => item.passed), items, quotes: [],
    scope: '只检查委派结束、文件回读与路径；不能证明子Agent引文来自原网页或父Agent语义审阅正确。' };
}

export const SKILL_CHECKS: Record<string, SkillCheck> = {
  'webpage-reader': checkWebpageReader, 'obsidian-blog-reader': checkObsidianBlogReader,
  'person-agent': checkPersonAgent,
};
