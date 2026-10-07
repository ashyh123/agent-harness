import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { VercelLoop, type Configuration } from './agent.js';
import { PythonBridge, ROOT, loadLocalEnv, redact } from './bridge.js';

loadLocalEnv();
if (!process.env.DEEPSEEK_API_KEY) throw new Error('请在项目 .env 配置 DEEPSEEK_API_KEY');
const bridge = new PythonBridge();
const url = 'https://xn--ygr25xpohxwz.com/zero-to-fullstack/lessons/module-6-3/';
const cases = [
  ['精确计算', '请使用计算工具算出 123 乘以 456，简短回答。'],
  ['工具错误', '请用 calculate 计算 10 除以 0。如果工具返回错误，就说明原因并停止，不要编造数值。'],
  ['网页搜索', '用 web_search 搜索 Hugging Face Agents Course 官方课程，最多返回两条搜索结果，给出官方入口 URL。'],
  ['指定网页总结', `请读取这个具体网页：${url}\n仅依据这个网页原文回答两个问题：\n1. 这个网页原文里面讲述了哪些内容？\n2. 对于存储、数据库和存储的历史，它们分别有什么样的讲解内容？\n简洁列出要点。原文没讲到的内容明确说明，不用其他资料补充；如果读取不完整也明确说明。附来源 URL。`],
  ['看图后计算', '阅读 images/demo-chart.png，提取 2024 和 2025 年的数值，然后使用计算工具算出增长百分比。简短给出数据和结果。'],
];
const output = join(ROOT, 'reports/vercel-sdk-comparison.json');
try {
  const config = await bridge.request<Configuration>('describe');
  const agent = new VercelLoop(bridge, config);
  console.log('一次性抓取网页和搜索结果，两个 Loop 重放同一份工具返回；图片和计算照常执行。');
  const webpage = await bridge.request('capture_tool', { name: 'read_webpage', arguments: { url } });
  const search = await bridge.request('capture_tool', { name: 'web_search', arguments: { query: 'Hugging Face Agents Course', max_results: 2 } });
  if (webpage.error) throw new Error('指定网页抓取失败，不能开展正文对比');
  const fixtures = { read_webpage: webpage, web_search: search };
  const report = { model: config.model, date: new Date().toISOString(),
    baseline_commit: '1c574be', config, fixture_mode: '同一次真实抓取的网页/搜索返回；仅本次评估重放，日常 CLI 使用真实工具',
    fixtures, results: [] as any[] };
  await mkdir(join(ROOT, 'reports'), { recursive: true });
  async function save() { await writeFile(output, redact(JSON.stringify(report, null, 2))); }
  await save();
  const chosen = process.argv.slice(2).join(' ');
  if (chosen && !cases.some(([name]) => name === chosen)) throw new Error('未知场景名称');
  for (const [index, [name, prompt]] of cases.entries()) {
    if (chosen && name !== chosen) continue;
    console.log(`正在对比：${name}`);
    // 交替先后顺序，避免所有 SDK 请求都固定排在手写版后面。
    const pair: any = { case: name, prompt, order: index % 2 ? ['vercel', 'python'] : ['python', 'vercel'] };
    report.results.push(pair);
    for (const implementation of pair.order) {
      const started = performance.now();
      pair[implementation] = implementation === 'python'
        ? await bridge.request('run_python', { name, prompt, fixtures })
        : await agent.run([{ role: 'user', content: prompt }], { fixtures });
      pair[implementation].elapsed_seconds = Number(((performance.now() - started) / 1000).toFixed(3));
      await save();
      const result = pair[implementation];
      console.log(`${implementation}：模型 ${result.model_requests}，工具 ${result.tool_calls}，tokens ${result.total_tokens}，${result.error ? '未完成' : '返回答案'}`);
    }
  }
  console.log(`详细记录：${output}`);
} catch (error) {
  console.error(redact(`对比中断：${(error as Error).message}`));
  process.exitCode = 1;
} finally { bridge.close(); }
