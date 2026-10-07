import { MinimalHarness } from './harness.js';
import type { Configuration } from './agent.js';
import { PythonBridge, loadLocalEnv, redact } from './bridge.js';
import { listSkills } from './skills.js';

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || (args.length === 1 && args[0] === '--list')) {
    for (const skill of await listSkills()) console.log(`${skill.name}：${skill.description}`);
    console.log('\n运行：npm run harness -- <skill名称> "任务内容"');
    return;
  }
  const [skill, ...taskParts] = args;
  const task = taskParts.join(' ').trim();
  if (!task) throw new Error('请提供任务内容');
  loadLocalEnv();
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('请先在项目 .env 填入 DEEPSEEK_API_KEY');
  const bridge = new PythonBridge();
  try {
    const config = await bridge.request<Configuration>('describe');
    const { directory, record } = await new MinimalHarness(bridge, config).run({ skill, task });
    console.log(redact(record.result?.answer ?? `运行未完成：${record.result?.error ?? record.harness_error}`));
    console.log(`\n运行状态：${record.runtime_status}；任务验收：${record.task_verdict}`);
    console.log(`结果目录：${directory}`);
    if (record.result) console.log(`模型请求 ${record.result.model_requests} 次，工具 ${record.result.tool_calls} 次，tokens ${record.result.total_tokens}`);
    if (record.runtime_status === 'failed') process.exitCode = 1;
  } finally { bridge.close(); }
}

main().catch(error => {
  console.error(redact(`Harness 启动失败：${error instanceof Error ? error.message : 'UnknownError'}`));
  process.exitCode = 1;
});
