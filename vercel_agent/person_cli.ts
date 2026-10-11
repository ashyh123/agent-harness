import { jevSubmissionClassifier } from './jev_submission.js';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { PythonBridge, loadLocalEnv, redact } from './bridge.js';
import { TaskRouter, DEFAULT_TASK_ROOT, taskDate, redactTask } from './task_router.js';
import { createTaskAdapters, findCodex } from './task_adapters.js';
import { TaskCenter, executorProfiles } from './task_center.js';
import { TaskCenterServer } from './task_center_server.js';
import { CenterConversation } from './center_conversation.js';
import { MinimalHarness } from './harness.js';
import { SKILLS_ROOT } from './skills.js';
import { COORDINATOR_SKILL, harnessConfiguration, harnessEnvironment } from './person_profile.js';
import type { Configuration } from './execution_runtime.js';
import { completedTaskPaths, renderCompletedTaskPaths } from './center_presentation.js';

async function main() {
  loadLocalEnv();
  process.env.MINIMAL_AGENT_ROUTING_CLASSIFIER ??= 'jev-exclusive';
  if (!['baseline', 'jev', 'jev-exclusive'].includes(process.env.MINIMAL_AGENT_ROUTING_CLASSIFIER)) throw new Error('无效的路由分类模式');
  if (process.env.MINIMAL_AGENT_ROUTING_CLASSIFIER !== 'baseline' && !process.env.TYPESAFE_API_KEY) throw new Error('请先在项目.env配置TYPESAFE_API_KEY，或显式选择baseline模式');
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('请先在项目.env配置DeepSeek密钥');
  const directory = join(process.env.MINIMAL_AGENT_TASK_ROOT ?? DEFAULT_TASK_ROOT, 'center', taskDate(new Date()), randomUUID());
  const availableCodex = await findCodex().then(() => true, () => false);
  const center = new TaskCenter(directory, new TaskRouter(createTaskAdapters(), join(directory, 'executions')),
    executorProfiles(true, availableCodex));
  await center.initialize();
  const classifier = ['jev', 'jev-exclusive'].includes(process.env.MINIMAL_AGENT_ROUTING_CLASSIFIER ?? '')
    ? jevSubmissionClassifier(async record => { await appendFile(join(directory, 'jev-classifications.jsonl'), JSON.stringify(record) + '\n'); }) : undefined;
  const server = new TaskCenterServer(center, classifier);
  let ipc: Awaited<ReturnType<TaskCenterServer['start']>>;
  try { ipc = await server.start(); } catch (error) { await server.close(); throw error; }
  const bridge = new PythonBridge({ ...harnessEnvironment(COORDINATOR_SKILL), ...ipc, MINIMAL_AGENT_TASK_COORDINATION: '1' });
  let config: Configuration;
  try { config = harnessConfiguration(await bridge.request<Configuration>('describe'), COORDINATOR_SKILL); }
  catch (error) { bridge.close(); await server.close(); await center.shutdown(); throw error; }
  const harness = new MinimalHarness(bridge, config, { skills: SKILLS_ROOT, runs: join(directory, 'main-agent') });
  const records: unknown[] = [];
  const reportedTasks = new Set<string>();
  let shuttingDown = false, errors = false;
  let terminal: ReturnType<typeof createInterface> | undefined;
  let logs: Promise<void> = Promise.resolve();
  const conversation = new CenterConversation(center, async input => {
    const { record } = await harness.run({ skill: COORDINATOR_SKILL, task: input }, {
      onNotice: notice => console.log(redact(notice)),
    });
    records.push(record);
    if (record.runtime_status === 'failed') throw new Error(record.result?.error ?? record.harness_error ?? '主Agent本轮失败');
    return record.result?.answer ?? '主Agent未返回回答';
  }, turn => {
    const newlyCompleted = center.state().filter(job => job.status === 'completed' && !reportedTasks.has(job.id));
    newlyCompleted.forEach(job => reportedTasks.add(job.id));
    const renderedAnswer = turn.answer + renderCompletedTaskPaths(newlyCompleted);
    console.log(redactTask(`\n${turn.automatic ? '主Agent收到任务消息' : '主Agent'}：\n${renderedAnswer}\n`));
    logs = logs.then(() => appendFile(join(directory, 'conversation.jsonl'), redactTask(JSON.stringify({ ...turn, rendered_answer: renderedAnswer })) + '\n', { mode: 0o600 }))
      .catch(() => { errors = true; });
  }, error => { errors = true; console.error(redactTask(String(error instanceof Error ? error.message : '主Agent失败'))); });
  center.signals.on('event', event => {
    if (['task_running', 'task_upgraded', 'awaiting_review', 'task_failed', 'task_cancelled'].includes(event.type)) {
      console.log(`[${event.task_id.slice(0, 8)}] ${event.type}`);
    }
  });
  console.log(`任务中心：${directory}\n并发上限：2；现有执行端：${center.profiles.filter(item => item.available).map(item => item.id).join('、')}`);
  console.log('近期对话只保留预览；完整对话另存文件，任务原目标、验收与产物可按ID回查。');
  const interrupt = () => {
    if (shuttingDown) return;
    shuttingDown = true; terminal?.close(); bridge.close(); void center.shutdown();
  };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  // 整个演示入口也有总时限，避免主Agent未审阅时无限等候。
  const timer = setTimeout(() => { errors = true; console.error('本中心运行已达900秒上限'); interrupt(); }, 900_000);
  try {
    const input = process.argv.slice(2).join(' ').trim();
    if (input) {
      try { await conversation.send(input); } catch { errors = true; /* 已提交任务继续运行，完成消息可触发下一轮审阅。 */ }
      await conversation.settle();
    } else {
      console.log('输入任务即可发布；任务运行期间可继续输入。/tasks 查看，/cancel <任务ID> 取消，/exit 退出。');
      terminal = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
      terminal.setPrompt('你 > '); terminal.prompt();
      for await (const line of terminal) {
        if (shuttingDown || line.trim() === '/exit') { terminal.close(); break; }
        if (line.trim() === '/tasks') console.log(JSON.stringify((await center.updates()).tasks, null, 2));
        else if (line.startsWith('/cancel ')) {
          try { console.log(await center.cancel(line.slice(8).trim())); } catch (error) { console.error((error as Error).message); }
        } else if (line.trim()) void conversation.send(line.trim()).catch(() => {});
        terminal.prompt();
      }
    }
  } finally {
    clearTimeout(timer); process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    // 先保存状态：awaiting_review不是完成，退出后保留其产物而取消活动进程。
    const beforeClose = center.state();
    await center.shutdown(); bridge.close(); await conversation.close(); await server.close();
    await logs;
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'summary.json'), redactTask(JSON.stringify({
      tasks: center.state(), status_before_close: beforeClose.map(job => ({ task_id: job.id, status: job.status })),
      decision_turns: conversation.turns, parent_runs: records, errors,
      complete_paths: completedTaskPaths(beforeClose),
      scope: '结构验收和主Agent审阅，不保证事实正确；本版不自动恢复先前中心或接管已有会话。',
    }, null, 2)), { mode: 0o600 });
    const unfinished = beforeClose.filter(job => job.status !== 'completed');
    console.log(`记录：${join(directory, 'summary.json')}\n任务 ${beforeClose.length} 项；主Agent审阅通过 ${beforeClose.length - unfinished.length} 项。`);
    if (errors || unfinished.length) process.exitCode = 2;
  }
}
main().catch(error => { console.error(redactTask(error instanceof Error ? error.message : '任务中心启动失败')); process.exitCode = 1; });
