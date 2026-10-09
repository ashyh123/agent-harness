/** 只在路由器创建的任务进程中执行；已有Harness保留原模型、工具和预算。 */
import { writeFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { MinimalHarness } from './harness.js';
import { PythonBridge, loadLocalEnv, redact } from './bridge.js';
import type { Configuration } from './agent.js';
import { SKILLS_ROOT } from './skills.js';
import { harnessEnvironment, harnessConfiguration } from './person_profile.js';

async function main() {
  const workspace = process.env.MINIMAL_AGENT_ROUTER_WORKSPACE;
  if (!workspace || !isAbsolute(workspace) || process.cwd() !== workspace) throw new Error('需要独立任务工作目录');
  const skill = process.argv[2];
  let task = '';
  for await (const chunk of process.stdin) task += chunk;
  loadLocalEnv();
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('请在项目.env配置DEEPSEEK_API_KEY');
  // 路由任务生成的快照和可选Obsidian vault也留在本次目录。
  const bridge = new PythonBridge({ ...harnessEnvironment(skill, workspace),
    MINIMAL_AGENT_WEBPAGE_STORE_DIR: join(workspace, 'webpage-snapshots'),
    MINIMAL_AGENT_OBSIDIAN_VAULT: join(workspace, 'obsidian') }, workspace);
  try {
    const config = harnessConfiguration(await bridge.request<Configuration>('describe'), skill);
    const { record } = await new MinimalHarness(bridge, config,
      { skills: SKILLS_ROOT, runs: join(workspace, 'harness') }).run({ skill, task }, {
      onNotice: notice => console.log(JSON.stringify({ type: 'harness.notice', message: redact(notice) })),
    });
    await writeFile(join(workspace, 'result.md'), redact(record.result?.answer ?? `未完成：${record.result?.error ?? record.harness_error}`));
    console.log(redact(JSON.stringify({ type: 'harness.result', runtime_status: record.runtime_status,
      task_verdict: record.task_verdict, answer: record.result?.answer ?? null,
      error: record.result?.error ?? record.harness_error,
      usage: record.result ? { model_requests: record.result.model_requests,
        tool_calls: record.result.tool_calls, total_tokens: record.result.total_tokens,
        delegated: record.result.events.filter(event => event.type === 'tool' && event.name === 'delegate_to_codex'
          && event.result?.task_id && !event.result.reused).map(event => ({ task_id: event.result.task_id,
            agent: event.result.agent, status: event.result.status, usage: event.result.usage })) } : null })));
    if (record.runtime_status === 'failed') process.exitCode = 1;
  } finally { bridge.close(); }
}
main().catch(error => {
  console.log(redact(JSON.stringify({ type: 'harness.result', runtime_status: 'failed', task_verdict: 'not_completed',
    answer: null, error: error instanceof Error ? error.message : 'UnknownError' })));
  process.exitCode = 1;
});
