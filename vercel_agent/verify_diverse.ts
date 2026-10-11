/** 固定两倍预算/较晚压缩；重复旧题，并增加数据与长上下文任务。 */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { LangGraphLoop } from './langgraph_loop.js';
import type { Configuration } from './execution_runtime.js';
import { PythonBridge, ROOT, loadLocalEnv, redact } from './bridge.js';
import { readingChecks, scaledBudget, type ReadingCase } from './budget_eval.js';
import { dataChecks, longReadingChecks, type DataCase } from './diverse_eval.js';
import { gold } from './verify_budget.js';

async function main() {
  if (process.argv[2] === '--review-only') {
    if (!process.argv[3]) throw new Error('请提供实验目录');
    await reviewSaved(resolve(process.argv[3]));
    return;
  }
  loadLocalEnv();
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('请配置项目 .env');
  const previous = process.argv[2] ? resolve(process.argv[2]) : join(ROOT, 'reports/budget-runs/paired-roomy-ECjPVX');
  const old = JSON.parse(await readFile(join(previous, 'manifest.json'), 'utf8'));
  const probePath = process.argv[3] ? resolve(process.argv[3]) : join(ROOT, 'reports/budget-runs/diverse-sources.json');
  const probes = JSON.parse(await readFile(probePath, 'utf8'));
  old.input_sources = old.input_sources.map((row: ReadingCase) => ({ ...row, facts: gold[row.id] }));
  const source = (id: string) => probes.find((row: any) => row.id === id);
  const noaa = source('noaa'), nasa = source('nasa'), html = source('w3c');
  const n = (year: number) => noaa.data[String(year)] as number;
  const t = (year: number) => nasa.data[String(year)] as number;
  const jsonInstruction = '最终只输出要求的 JSON。数值字段必须是数值；来源用 source_urls 数组。需要计算时必须用 calculate，不能心算。遇到工具无法读取的格式，输出 {"status":"blocked","data":null,"note":"真实原因","source_urls":["URL"]}，不得从记忆编造数据。不保存文件。';
  const data: DataCase[] = [
    { id: 'noaa-growth', requiredUrls: [noaa.url], expected: {
      rows: [2022, 2023, 2024].map(year => ({ year, mean: n(year) })), unit: 'ppm',
      delta: n(2024) - n(2022), growth_percent: (n(2024) - n(2022)) / n(2022) * 100, source_urls: [noaa.url],
    }, calculations: [n(2024) - n(2022), (n(2024) - n(2022)) / n(2022), (n(2024) - n(2022)) / n(2022) * 100],
    prompt: `读取 ${noaa.url}，提取2022、2023、2024年年度 CO2 mean，说明单位；以2022为基数计算2024的绝对增加值与增长百分比。JSON 字段 rows:[{year,mean}],unit,delta,growth_percent,source_urls。` },
    { id: 'nasa-units', requiredUrls: [nasa.url], expected: { baseline: '1951-1980', unit: 'deg-C',
      rows: [2022, 2023, 2024].map(year => ({ year, raw_jd: t(year), anomaly_c: t(year) / 100 })),
      delta_c: (t(2024) - t(2023)) / 100, source_urls: [nasa.url] },
    calculations: [t(2022) / 100, t(2023) / 100, t(2024) / 100, (t(2024) - t(2023)) / 100],
    prompt: `读取 ${nasa.url}，从 J-D 列提取2022、2023、2024年度温度异常原始值，按文件单位转换为摄氏度，说明基准期，计算2024比2023增加多少摄氏度。别把 D-N 或月份当成 J-D；按需回查末尾。JSON 字段 baseline(YYYY-YYYY),unit(使用deg-C),rows:[{year,raw_jd,anomaly_c}],delta_c,source_urls。` },
    { id: 'nasa-missing', requiredUrls: [nasa.url], expected: { year: 2026, annual_jd: null,
      available_months: 8, missing_months: [9, 10, 11, 12], source_urls: [nasa.url] }, explanationPattern: '缺失|不完整|missing|incomplete',
    prompt: `读取 ${nasa.url}，核对2026年 J-D 年度值是否可用、已有多少个月份值、缺少哪些月份。必须保留缺失语义，不能以已有月份均值冒充年度值。JSON 字段 year,annual_jd(不可用则null),available_months,missing_months(数字数组),note,source_urls。` },
    { id: 'cross-source-data', requiredUrls: [noaa.url, nasa.url], expected: {
      co2_rows: [2020, 2024].map(year => ({ year, mean_ppm: n(year) })),
      temperature_rows: [2020, 2024].map(year => ({ year, anomaly_c: t(year) / 100 })),
      co2_delta_ppm: n(2024) - n(2020), temperature_delta_c: (t(2024) - t(2020)) / 100,
      source_urls: [noaa.url, nasa.url] }, calculations: [t(2020) / 100, t(2024) / 100, n(2024) - n(2020), (t(2024) - t(2020)) / 100],
    explanationPattern: '因果|causal',
    prompt: `分别读取 ${noaa.url} 和 ${nasa.url}，提取2020及2024年度CO2 mean与温度异常 J-D（转换摄氏度），分别计算增量。note说明两个年份的对比不足以单独推断因果。JSON 字段 co2_rows:[{year,mean_ppm}],temperature_rows:[{year,anomaly_c}],co2_delta_ppm,temperature_delta_c,note,source_urls。` },
    { id: 'html-table', requiredUrls: [html.url], expected: { rows: [
      { company: 'Alfreds Futterkiste', contact: 'Maria Anders', country: 'Germany' },
      { company: 'Ernst Handel', contact: 'Roland Mendel', country: 'Austria' },
      { company: 'Island Trading', contact: 'Helen Bennett', country: 'UK' },
      { company: 'Magazzini Alimentari Riuniti', contact: 'Giovanni Rovelli', country: 'Italy' },
    ], count: 4, source_urls: [html.url] },
    prompt: `读取 ${html.url}，只针对第一张 Company/Contact/Country 示例表筛选属于欧洲国家的行，保留完整公司、联系人和国家信息，报告数量。注意后面的代码示例可能重复展示同一行，不能重复计数。这是教程示例数据。JSON 字段 rows:[{company,contact,country}],count,source_urls。` },
    { id: 'worldbank-json', requiredUrls: [source('json').url], unsupported: true,
      expected: { value: 1410710000 }, prompt: `读取这个世界银行官方JSON接口 ${source('json').url}，提取中国2023人口数字及年份和指标名。若未读取成功，必须报告阻塞且 data:null。` },
    { id: 'usgs-csv', requiredUrls: [source('csv').url], unsupported: true,
      expected: {}, prompt: `读取 USGS 的实时显著地震CSV ${source('csv').url}，提取首个地震的 time/place/mag，报告 earthquake 类型行的数量。只采用本轮实际获取的文件。若不能读取，必须报告阻塞且 data:null。` },
    { id: 'search-then-extract', requiredUrls: [noaa.url], search: true,
      expected: { year: 2024, mean: n(2024), unit: 'ppm', source_urls: [noaa.url] },
      prompt: '先 web_search 找 NOAA Mauna Loa CO2 annual mean 官方原始数据文件（co2_annmean_mlo.txt），然后实际读取该文件，提取2024年度mean值及单位。不能只凭搜索摘要作答。JSON 字段 year,mean,unit,source_urls。' },
  ];
  for (const task of data) task.prompt += '\n' + jsonInstruction;
  const papers: ReadingCase[] = old.input_sources.filter((row: any) => ['react', 'toolformer'].includes(row.id));
  const longPrompt = `完整阅读两个已保存的 text 快照：${papers.map(p => `${p.id} document_id=${p.document_id}, URL=${p.url}, 总长=${p.text.length}`).join('; ')}。
必须用 read_saved_webpage 实际覆盖每篇 [0,总长)，每个工具 limit<=10000、content_format=text，同轮最多2个读取调用，按每篇 next_offset 继续，避免一口气装入全文。先完整读ReAct再完整读Toolformer，不要重新下载。
最后回答以下核对问题，每个提供12–100字符连续逐字英文引文：${JSON.stringify(papers.map(p => ({ id: p.id, facts: p.facts.map(({ id, question }) => ({ id, question })) })))}。
只输出JSON {"papers":[{"id":"论文ID","facts":[{"id":"问题ID","answer":"简短答案","quote":"逐字引文"}]}],"note":"如实报告未完成部分"}。压缩后证据不确定必须回查，不能编造。`;
  const tasks: { id: string; prompt: string; anchor?: boolean; reading?: ReadingCase; data?: DataCase; long?: boolean }[] = old.cases.map((task: any) => ({
    ...task, anchor: true, reading: old.input_sources.find((doc: any) => doc.id === task.id),
  }));
  tasks.push(...data.map(task => ({ id: task.id, prompt: task.prompt, data: task })), { id: 'two-papers-long-context', prompt: longPrompt, long: true });
  const bridge = new PythonBridge();
  let config: Configuration;
  try { config = scaledBudget(await bridge.request('describe'), 2); } finally { bridge.close(); }
  config.context_policy = { trigger_tokens: 50000, target_tokens: 30000, max_input_tokens: 64000, summary_output_tokens: 1024 };
  const directory = await mkdtemp(join(ROOT, 'reports/budget-runs/diverse-roomy-'));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ prepared_at: new Date().toISOString(), repeats: 2,
    config, previous, tasks, probes, papers,
    methodology: '旧题复用原快照和原提示词，新数据任务从实际URL开始，工具/SDK/提示词/上下文策略不做优化。独立抓取原始数据计算基准；准备不计入agent执行预算。负例诚实失败单独计分，不算任务完成。长任务刻意覆盖两篇全文以检验晚压缩。每项重复两次，只是小样本。' }, null, 2));
  const rows: any[] = [];
  for (let repeat = 1; repeat <= 2; repeat++) {
    const ordered = repeat === 1 ? tasks : [...tasks].reverse();
    // 不同题互相独立；每批两个Agent并发，控制外部服务压力。
    for (let index = 0; index < ordered.length; index += 2) {
      await Promise.all(ordered.slice(index, index + 2).map(async task => {
        const runBridge = new PythonBridge();
        const id = `${task.id}-2x-r${repeat}`;
        const started = Date.now();
        console.log(`开始 ${id}`);
        try {
          const result = await new LangGraphLoop(runBridge, config).run([{ role: 'user', content: task.prompt }], {
            onNotice: notice => console.log(`${id}: ${redact(notice)}`),
          });
          let checks: any;
          if (task.reading) checks = readingChecks(task.reading, result);
          else if (task.data) checks = dataChecks(task.data, result);
          else if (task.long) checks = longReadingChecks(papers, result);
          else {
            const events = result.events.filter(event => event.type === 'tool' && event.name === 'calculate');
            if (task.id === 'six-step-calculation') {
              const expected = [56088, 56877, 18959, 18900, 189, 2362.5];
              checks = { passed: !result.error && expected.every((value, i) => events[i]?.result?.result === value)
                && expected.every(value => result.answer?.includes(String(value))) };
            } else checks = { passed: !result.error && events.some(event => event.result?.error)
              && events.some(event => event.result?.result === 35) && /无法|不能|零|zero/i.test(result.answer ?? '') && /35/.test(result.answer ?? '') };
          }
          const row = { id, task: task.id, repeat, anchor: !!task.anchor, elapsed_seconds: (Date.now() - started) / 1000, checks, result };
          rows.push(row);
          await writeFile(join(directory, `${id}.json`), redact(JSON.stringify(row, null, 2)));
          console.log(`结束 ${id} pass=${checks.passed} models=${result.model_requests} tools=${result.tool_calls} tokens=${result.total_tokens} compressed=${result.context_compactions.length} error=${result.error}`);
        } catch (error) {
          rows.push({ id, task: task.id, repeat, anchor: !!task.anchor, checks: { passed: false }, harness_error: error instanceof Error ? error.name : 'UnknownError' });
          console.log(`结束 ${id} harness_error`);
        } finally { runBridge.close(); }
      }));
      await writeFile(join(directory, 'results.json'), redact(JSON.stringify(rows, null, 2)));
    }
  }
  console.log(`实验完成 ${directory}`);
  await reviewSaved(directory);
}

async function reviewSaved(directory: string) {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  const rows = JSON.parse(await readFile(join(directory, 'results.json'), 'utf8'));
  const papers = manifest.papers.map((p: ReadingCase) => ({ ...p, facts: gold[p.id] }));
  const reviewed = rows.map((row: any) => {
    const task = manifest.tasks.find((task: any) => task.id === row.task);
    const checks = !row.result ? row.checks : task.reading
      ? readingChecks({ ...task.reading, facts: gold[task.id] }, row.result) : task.data
        ? dataChecks(task.data, row.result) : task.long ? longReadingChecks(papers, row.result) : row.checks;
    return { ...row, original_checks: row.checks, checks };
  });
  await writeFile(join(directory, 'reviewed-results.json'), JSON.stringify({
    checker_revision: 'v4: 接受代表性不足同义词；ppm允许括号解释；附加来源须实际读过。不修复模型输出JSON，不放宽全文/工具计算/事实/引文要求。', rows: reviewed,
  }, null, 2));
  console.log(`离线复核完成 ${directory}`);
}
main().catch(error => { console.error(redact(`实验失败：${error instanceof Error ? error.message : 'UnknownError'}`)); process.exitCode = 1; });
