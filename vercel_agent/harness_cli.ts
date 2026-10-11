import { MinimalHarness } from './harness.js';
import type { Configuration } from './execution_runtime.js';
import { PythonBridge, loadLocalEnv, redact } from './bridge.js';
import { listSkills } from './skills.js';
import { harnessEnvironment, harnessConfiguration } from './person_profile.js';
import { readFile } from 'node:fs/promises';
import { validateReadingContract, type ReadingContract } from './reading_validation.js';

async function main() {
  const args = process.argv.slice(2);
  // 旧命令别名仍接受，但不再用于选择后端。
  if (args[0] === '--langgraph') args.shift();
  const noCritic = args[0] === '--no-critic';
  if (noCritic) args.shift();
  let readingContract: ReadingContract | undefined;
  if (args[0] === '--contract') {
    args.shift();
    const file = args.shift();
    if (!file) throw new Error('请提供阅读约定JSON文件');
    readingContract = JSON.parse(await readFile(file, 'utf8'));
    validateReadingContract(readingContract!);
  }
  if (noCritic && !readingContract) throw new Error('--no-critic需要--contract');
  if (!args.length || (args.length === 1 && args[0] === '--list')) {
    for (const skill of await listSkills()) console.log(`${skill.name}：${skill.description}`);
    console.log(`\n运行：npm run harness -- <skill名称> "任务内容"`);
    return;
  }
  const [skill, ...taskParts] = args;
  let task = taskParts.join(' ').trim();
  if (!task) throw new Error('请提供任务内容');
  if (readingContract) task += `\n阅读约定：${JSON.stringify(readingContract)}。
用search_saved_webpage定位，并用read_saved_webpage按text回读证据；不要求全文阅读。
最终只输出JSON：{"facts":[{"id":"原问题ID","answer":"中文答案","quote":"连续逐字原文"}],"source_url":"约定来源","reading_scope":"targeted","page_completeness":"not_verified"}。
每个问题恰好回答一次，引文为${readingContract.min_quote_chars??12}–${readingContract.max_quote_chars??100}字符。`;
  loadLocalEnv();
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('请先在项目 .env 填入 DEEPSEEK_API_KEY');
  const bridge = new PythonBridge(harnessEnvironment(skill));
  try {
    const config = harnessConfiguration(await bridge.request<Configuration>('describe'), skill);
    if (readingContract) config.tools = config.tools.filter(tool =>
      ['search_saved_webpage', 'read_saved_webpage'].includes(tool.name));
    const harness = new MinimalHarness(bridge, config);
    const { directory, record } = await harness.run({ skill, task, readingContract,
      readingReview:noCritic?'structural':undefined }, {
      onNotice: notice => console.log(redact(notice)),
    });
    console.log(redact(record.result?.answer ?? `运行未完成：${record.result?.error ?? record.harness_error}`));
    console.log(`\n运行状态：${record.runtime_status}；任务验收：${record.task_verdict}`);
    for (const item of record.automatic_checks?.items ?? []) {
      console.log(redact(`自动检查 ${item.passed ? '通过' : '未通过'} ${item.name}：${item.detail}`));
    }
    console.log(`结果目录：${directory}`);
    if (record.result) console.log(`模型请求 ${record.result.model_requests} 次，工具 ${record.result.tool_calls} 次，tokens ${record.result.total_tokens}`);
    if (record.runtime_status === 'failed') process.exitCode = 1;
  } finally { bridge.close(); }
}

main().catch(error => {
  console.error(redact(`Harness 启动失败：${error instanceof Error ? error.message : 'UnknownError'}`));
  process.exitCode = 1;
});
