/** 真实搜索和模型的一次任务验证；完整资料留在独立记录中，不覆盖日常 CLI。 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LangGraphLoop } from './langgraph_loop.js';
import type { Configuration } from './execution_runtime.js';
import { PythonBridge, ROOT, loadLocalEnv, redact } from './bridge.js';

async function main() {
  loadLocalEnv();
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('请先配置项目 .env');
  const runs = join(ROOT, 'reports/search-reliability-runs');
  await mkdir(runs, { recursive: true });
  const directory = await mkdtemp(join(runs, 'search-'));
  const prompt = '找两篇模型厂商官方的 Agent 工程博客，读取正文，每篇用两句话描述并给来源 URL。只读取搜索结果提供的文章 URL，不猜测地址。如果搜索失败，就明确说明；不要只根据搜索摘要声称读过文章。';
  const bridge = new PythonBridge();
  try {
    const configuration = await bridge.request<Configuration>('describe');
    const result = await new LangGraphLoop(bridge, configuration).run([{ role: 'user', content: prompt }]);
    await writeFile(join(directory, 'run.json'), redact(JSON.stringify({ prompt, configuration, ...result }, null, 2)) + '\n');
    await writeFile(join(directory, 'answer.md'), redact(result.answer ?? `未完成：${result.error}`) + '\n');
    const searches = result.events.filter(event => event.type === 'tool' && event.name === 'web_search');
    const reads = result.events.filter(event => event.type === 'tool' && event.name === 'read_webpage' && !event.result?.error);
    console.log(redact(result.answer ?? result.error ?? '没有答案'));
    console.log(`记录：${directory}`);
    console.log(JSON.stringify({ model_requests: result.model_requests, tool_calls: result.tool_calls,
      total_tokens: result.total_tokens,
      searches: searches.map(event => ({ query: event.arguments.query, provider: event.result.provider,
        attempts: event.result.attempts, error: event.result.error })),
      read_urls: reads.map(event => event.result.url) }, null, 2));
    assert.equal(result.error, null, '任务运行失败；证据已保存');
    assert.ok(searches.some(event => event.result.results?.length > 0), '未取得真实搜索结果');
    assert.ok(new Set(reads.map(event => event.result.url)).size >= 2, '未成功读取两篇不同的网页');
    const discoveredUrls = new Set(searches.flatMap(event => (event.result.results ?? []).map((item: any) => item.url)));
    for (const event of reads) assert.ok(discoveredUrls.has(event.arguments.url), '读取地址未出现在本轮搜索结果中；不能用猜测 URL 验证搜索成功');
    for (const event of reads) assert.ok(result.answer?.includes(event.result.url), '答案缺少实际读取来源');
    console.log('搜索与读取流程通过；文章是否官方、概括是否准确仍需人工核对。');
  } finally { bridge.close(); }
}

main().catch(error => {
  console.error(redact(`搜索验证未通过：${error instanceof Error ? error.message : 'UnknownError'}`));
  process.exitCode = 1;
});
