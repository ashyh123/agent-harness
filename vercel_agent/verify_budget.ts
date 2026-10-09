/** 真实模型的配对预算实验；采集一次，相同原文/提示词用于两档预算。 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VercelLoop, type Configuration } from './agent.js';
import { PythonBridge, ROOT, loadLocalEnv, redact } from './bridge.js';
import { readingChecks, readingPrompt, scaledBudget, type Fact, type ReadingCase } from './budget_eval.js';

const sources = [
  { id: 'react', url: 'https://arxiv.org/html/2210.03629' },
  { id: 'toolformer', url: 'https://arxiv.org/html/2302.04761' },
  { id: 'reflexion', url: 'https://arxiv.org/html/2303.11366' },
  { id: 'research-blog', url: 'https://www.anthropic.com/engineering/multi-agent-research-system' },
];
export const gold: Record<string, Fact[]> = {
  react: [
    { id: 'early', question: '摘要报告 ALFWorld 和 WebShop 的绝对成功率提升分别是多少？', answerPattern: '34[\\s\\S]*10', sourcePattern: '34%.*10%' },
    { id: 'middle', question: '在 Fever 上 ReAct 与 CoT 的分数各是多少？', answerPattern: '60[.]9[\\s\\S]*56[.]3', sourcePattern: '60[.]9.*56[.]3' },
    { id: 'late', question: 'Appendix E 的示例省略了哪些内容来节约空间？', answerPattern: '(搜索|检索|search)[\\s\\S]*(非代表|不具代表|代表性不足|non-representative)', sourcePattern: 'Search results and non-representative steps' },
  ],
  toolformer: [
    { id: 'early', question: 'Toolformer 是否采用自监督训练？', answerPattern: '自监督|self.supervised', sourcePattern: 'self-supervised' },
    { id: 'middle', question: '第7节指出它能否把一个工具输出作为另一个工具输入形成调用链？', answerPattern: '不能|无法|不支持|inability|cannot', sourcePattern: 'inability.*chain' },
    { id: 'late', question: 'Dateset 随机抽取多少个 current dates？过去或未来日期的选取范围是几年？', answerPattern: '500[\\s\\S]*(4|四|four)', sourcePattern: '500|four-year' },
  ],
  reflexion: [
    { id: 'early', question: '摘要中的 HumanEval pass@1 与对照 GPT-4 数字分别是多少？', answerPattern: '91[\\s\\S]*80', sourcePattern: '91%|80%' },
    { id: 'middle', question: '去掉单元测试引导的自反思，其准确率与 baseline 各是多少？', answerPattern: '52[\\s\\S]*60', sourcePattern: '52%.*60%' },
    { id: 'late', question: '附录最后一个学位领域示例第二次试验的正确答案是什么？', answerPattern: 'Engineering|工程', sourcePattern: 'Finish\\[Engineering\\]|M[.]Sc[.] in Engineering' },
  ],
  'research-blog': [
    { id: 'early', question: '文章对简单事实查询建议多少 Agent、多少工具调用？', answerPattern: '(1|一)[\\s\\S]*3[\\s\\S]*10', sourcePattern: '1 agent with 3-10 tool calls' },
    { id: 'middle', question: '他们最初用多少个代表实际使用的查询开始评测？', answerPattern: '20|二十', sourcePattern: '20 queries' },
    { id: 'late', question: '末尾文件系统模式中，子 Agent 保存工作后传给协调者的是完整输出还是轻量引用？', answerPattern: '轻量引用|lightweight references', sourcePattern: 'lightweight references' },
  ],
};
const blogSections = ['Benefits of a multi-agent system', 'Architecture overview for Research',
  'Prompt engineering and evaluations for research agents', 'Effective evaluation of agents',
  'Production reliability and engineering challenges', 'Conclusion', 'Appendix'];
const calculationPrompt = '必须用 calculate 按依赖顺序逐步完成以下六步，每步单独调用工具，不允许心算跳步：123乘456；加789；除3；减59；除100；乘12.5。输出全部六个中间结果及最终结果，简短回答。';
const errorPrompt = '先用 calculate 执行10除0，明确该步骤无法计算，不能编造数值。接着用 calculate 计算70除2，给出正确结果。这是两个独立操作，前一个业务错误不应阻止后一个。';

async function reviewSaved(directory: string) {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  const rows = JSON.parse(await readFile(join(directory, 'results.json'), 'utf8'));
  const reviewed = rows.map((row: any) => {
    const task = manifest.input_sources.find((task: any) => task.id === row.task);
    return { ...row, original_checks: row.checks,
      checks: task ? readingChecks({ ...task, facts: gold[task.id] }, row.result) : row.checks };
  });
  await writeFile(join(directory, 'reviewed-results.json'), JSON.stringify({
    checker_revision: 'v3: 同义词与等价原文纠正、相邻真实区间支持跨页引文；引文长度仍为必选格式项。保留原评分，不请求模型。', rows: reviewed,
  }, null, 2));
  console.log(`已离线复核：${directory}`);
}

async function main() {
  loadLocalEnv();
  if (process.argv[2] === '--review-only') {
    if (!process.argv[3]) throw new Error('请提供已完成的实验目录');
    await reviewSaved(resolve(process.argv[3]));
    return;
  }
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('请配置项目 .env');
  const repeats = Number(process.argv[2] ?? 2);
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 3) throw new Error('重复次数限 1–3');
  const manifestPath = process.argv[3] === '-' ? undefined : process.argv[3];
  const contextProfile = process.argv[4] ?? 'current';
  if (!['current', 'roomy'].includes(contextProfile)) throw new Error('上下文对照只能是 current 或 roomy');
  const root = join(ROOT, 'reports/budget-runs');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, `paired-${contextProfile}-`));
  const captureBridge = new PythonBridge();
  let base: Configuration;
  const documents: any[] = [];
  try {
    base = await captureBridge.request('describe');
    const prepared = manifestPath ? JSON.parse(await readFile(join(ROOT, manifestPath), 'utf8')) : null;
    for (const source of sources) {
      const cached = prepared?.find((row: any) => row.id === source.id);
      const capture = cached?.capture ?? await captureBridge.request('capture_tool', { name: 'read_webpage', arguments: { url: source.url } });
      if (!capture.document_id || capture.error) throw new Error(`真实来源读取失败：${source.id}`);
      const document = JSON.parse(execFileSync(join(ROOT, '.venv/bin/python'), ['-c',
        'import json,sys; from tool_library.webpage_store import load_webpage; print(json.dumps(load_webpage(sys.argv[1]),ensure_ascii=False))',
        capture.document_id], { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
      const text = document.text_content ?? document.content;
      const sections = source.id === 'research-blog' ? blogSections
        : [...document.content.matchAll(/^## (.+)$/gm)].map(match => match[1]).filter(section => section !== 'References');
      for (const fact of gold[source.id]) if (!new RegExp(fact.sourcePattern, 'i').test(text)) throw new Error(`原文基准不存在：${source.id}/${fact.id}`);
      documents.push({ ...source, document_id: capture.document_id, url: document.url, title: document.title,
        text, sections, facts: gold[source.id], capture });
    }
  } finally { captureBridge.close(); }
  const cases: { id: string; prompt: string; reading?: ReadingCase }[] = documents.map(document => ({
    id: document.id, prompt: readingPrompt(document), reading: document }));
  cases.push({ id: 'six-step-calculation', prompt: calculationPrompt }, { id: 'recover-tool-error', prompt: errorPrompt });
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ prepared_at: new Date().toISOString(), base,
    repeats, multipliers: [2, 3], context_profile: contextProfile, context_policy_unchanged: contextProfile === 'current', input_sources: documents,
    cases: cases.map(({ id, prompt }) => ({ id, prompt })),
    semantics: '请求/工具/耗时/单次输出上限全部按倍数扩展；同一组内上下文阈值相同。roomy 组仅将压缩阈值设为50000、目标30000，本地安全上限仍64000，摘要上限1024。比较的是预算配置组合，不是纯请求次数因果实验。采集独立完成，不计入分析。',
  }, null, 2));
  const rows: any[] = [];
  const save = () => writeFile(join(directory, 'results.json'), redact(JSON.stringify(rows, null, 2)) + '\n');
  await save();
  for (let repeat = 1; repeat <= repeats; repeat++) {
    const ordered = repeat % 2 ? cases : [...cases].reverse();
    for (const task of ordered) {
      await Promise.all([2, 3].map(async multiplier => {
        const bridge = new PythonBridge();
        const config = scaledBudget(base!, multiplier);
        if (contextProfile === 'roomy') config.context_policy = {
          trigger_tokens: 50_000, target_tokens: 30_000, max_input_tokens: 64_000, summary_output_tokens: 1_024,
        };
        const started = Date.now();
        const id = `${task.id}-${multiplier}x-r${repeat}`;
        console.log(`开始 ${id}`);
        try {
          const result = await new VercelLoop(bridge, config).run([{ role: 'user', content: task.prompt }], {
            onNotice: notice => console.log(`${id}：${redact(notice)}`),
          });
          const toolEvents = result.events.filter(event => event.type === 'tool');
          let checks: any;
          if (task.reading) checks = readingChecks(task.reading, result);
          else if (task.id === 'six-step-calculation') {
            const expected = [56088, 56877, 18959, 18900, 189, 2362.5];
            const values = toolEvents.filter(event => event.name === 'calculate').map(event => event.result?.result);
            const passed = !result.error && expected.every((value, i) => values[i] === value)
              && expected.every(value => result.answer?.includes(String(value)));
            checks = { passed, expected, actual: values };
          } else {
            checks = { passed: !result.error && toolEvents.some(event => event.name === 'calculate' && event.result?.error)
              && toolEvents.some(event => event.name === 'calculate' && event.result?.result === 35)
              && /无法|不能|零|zero/i.test(result.answer ?? '') && /35/.test(result.answer ?? '') };
          }
          const row = { id, task: task.id, repeat, multiplier, configuration: config, elapsed_seconds: (Date.now() - started) / 1000,
            checks, result, committed_messages: undefined };
          rows.push(row);
          await writeFile(join(directory, `${id}.json`), redact(JSON.stringify(row, null, 2)) + '\n');
          await writeFile(join(directory, `${id}.md`), redact(result.answer ?? `未完成：${result.error}`) + '\n');
          console.log(`结束 ${id} passed=${checks.passed} requests=${result.model_requests} tools=${result.tool_calls} tokens=${result.total_tokens} compactions=${result.context_compactions.length} error=${result.error}`);
        } catch (error) {
          rows.push({ id, task: task.id, repeat, multiplier, checks: { passed: false }, harness_error: error instanceof Error ? error.name : 'UnknownError' });
          console.log(`结束 ${id} harness_error`);
        } finally { bridge.close(); }
      }));
      await save();
    }
  }
  console.log(`实验完成：${directory}`);
  await reviewSaved(directory);
  for (const multiplier of [2, 3]) {
    const subset = rows.filter(row => row.multiplier === multiplier);
    console.log(JSON.stringify({ multiplier, runs: subset.length, automatic_pass: subset.filter(row => row.checks.passed).length,
      tokens: subset.reduce((sum, row) => sum + (row.result?.total_tokens ?? 0), 0),
      compactions: subset.reduce((sum, row) => sum + (row.result?.context_compactions.length ?? 0), 0) }));
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => { console.error(redact(`预算实验失败：${error instanceof Error ? error.message : 'UnknownError'}`)); process.exitCode = 1; });
}
