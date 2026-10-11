import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { LangGraphLoop } from './langgraph_loop.js';
import type { Configuration } from './execution_runtime.js';
import { PythonBridge, ROOT, loadLocalEnv, redact } from './bridge.js';
import { normaliseWhitespace as normalise, tableRows } from './checks.js';

const url = 'https://xn--ygr25xpohxwz.com/zero-to-fullstack/lessons/module-6-3/';
const themes = ['持久化动机', '四种存储', '文件局限', '数据库范围', '历史范围'];
// 验收标准在请求模型之前确定，事实的语义正确性仍由人核对。
const criteria = [
  '真实读取指定网页，说明读取不完整或失败的情况，引用实际来源 URL。',
  '输出主题、事实、原文证据三列，覆盖五个主题。',
  '每行至少一段连续原文证据，可多段摘录；逐字引文能在工具返回正文中找到。',
  '持久化动机包含留存数据供后续使用或运营分析；四种存储分类准确。',
  '文件局限覆盖全量读取、全量重写、并发脏写/脏读、半写崩溃损坏四处问题。',
  '数据库是铺垫，引出事务和下一节；未讲具体产品或完整原理。',
  '历史部分涉及古老记录方式、存储需求先于数据库、文字可能为记账；未展开完整技术史，不缩成只有一句。',
];
const clarifyHistory = process.argv.includes('--clarify-history');
const prompt = `请使用 read_webpage 读取 ${url}，只依据该页输出简短事实表。
表格固定为“主题 | 事实 | 原文证据”三列，恰好五行，主题依次为：${themes.join('、')}。
文件局限必须覆盖原文列出的四处问题；数据库和历史两行说明本页讲了什么、没有展开什么，不补外部知识。
${clarifyHistory ? '历史范围特指“存储这件事本身的历史背景”，与应用的用户查询历史记录、会话归属无关。\n' : ''}每行事实尽量短。原文证据用反引号包住每段逐字、连续的原文短引文，每行至少一段，必要时可有多段。不要把改写或带省略号的拼接当作引文。
只输出表格与最后的来源 URL；如果正文不完整或读取失败，明确说明。`;

loadLocalEnv();
if (!process.env.DEEPSEEK_API_KEY) throw new Error('请在项目 .env 配置 DEEPSEEK_API_KEY');
const bridge = new PythonBridge();
try {
  const config = await bridge.request<Configuration>('describe');
  const output = join(ROOT, `reports/module-6-3-sdk-facts${clarifyHistory ? '-clarified' : ''}.json`);
  const report: any = { date: new Date().toISOString(), model: config.model, url, prompt, criteria,
    variant: clarifyHistory ? '只增加历史范围的消歧说明' : '初始任务',
    settings: { max_output_tokens: config.max_output_tokens, max_steps: config.max_steps, maxRetries: 0 },
    manual_review: '待人工核对语义；自动检查通过不代表事实全部正确' };
  await mkdir(join(ROOT, 'reports'), { recursive: true });
  async function save() { await writeFile(output, redact(JSON.stringify(report, null, 2))); }
  await save();
  console.log('正在运行指定网页事实表任务，保持现有 512 token 上限及 0 次接口重试。');
  const result = await new LangGraphLoop(bridge, config).run([{ role: 'user', content: prompt }]);
  report.result = result;
  const page = result.events.find(event => event.type === 'tool' && event.name === 'read_webpage' && typeof event.result?.content === 'string')?.result;
  report.source_metadata = page ? { url: page.url, chars: page.content.length, truncated: page.truncated,
    sha256: createHash('sha256').update(page.content).digest('hex') } : null;
  const answer = result.answer ?? '';
  const rows = tableRows(answer);
  const dataRows = rows.filter(cells => themes.includes(cells[0]));
  const content = normalise(page?.content ?? '');
  report.evidence_checks = dataRows.map(cells => {
    const quotes = [...(cells[2] ?? '').matchAll(/`([^`]+)`/g)].map(match => match[1]);
    return { theme: cells[0], fact: cells[1], evidence: cells[2],
      quotes: quotes.map(quote => ({ quote, found_in_source: !!content && content.includes(normalise(quote)) })),
      passed: quotes.length > 0 && quotes.every(quote => !!content && content.includes(normalise(quote))) };
  });
  report.automatic_checks = {
    runtime_completed: result.answer !== null && result.error === null,
    read_requested_page: !!page && result.events.some(event => event.name === 'read_webpage' && event.arguments?.url === url && typeof event.result?.content === 'string'),
    source_not_truncated: page?.truncated === false,
    three_column_table: rows.length === 6 && rows.every(cells => cells.length === 3)
      && rows[0].join('|') === '主题|事实|原文证据',
    five_themes: dataRows.length === 5 && dataRows.every((cells, index) => cells[0] === themes[index]),
    quotes_in_source: dataRows.length === 5 && report.evidence_checks.every((check: any) => check.passed),
    cites_source_url: !!page && answer.includes(page.url),
  };
  await save();
  console.log(redact(answer || result.error || '没有回答'));
  console.log(`模型请求 ${result.model_requests}，工具 ${result.tool_calls}，tokens ${result.total_tokens}，精简恢复 ${result.compact_retry_used}`);
  console.log(JSON.stringify(report.automatic_checks, null, 2));
  console.log(`详细记录：${output}`);
} catch (error) {
  console.error(redact(`验证中断：${(error as Error).name}`));
  process.exitCode = 1;
} finally { bridge.close(); }
