import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createTaskAdapters } from './task_adapters.js';
import { TaskRouter, DEFAULT_TASK_ROOT, redactTask, type AgentId } from './task_router.js';

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    agent: { type: 'string' }, skill: { type: 'string' }, root: { type: 'string' },
    'task-file': { type: 'string' }, expect: { type: 'string', multiple: true },
    timeout: { type: 'string' }, limit: { type: 'string' }, help: { type: 'boolean' }, json: { type: 'boolean' },
  } });
  const router = new TaskRouter(createTaskAdapters(), values.root ?? process.env.MINIMAL_AGENT_TASK_ROOT ?? DEFAULT_TASK_ROOT);
  const [command = 'agents', ...parts] = positionals;
  if (values.help) {
    console.log('npm run router -- agents\nnpm run router -- run --agent codex "任务" --expect report.md\n'
      + 'npm run router -- run --agent harness --skill calculation-audit "任务"\nnpm run router -- runs');
    return;
  }
  if (command === 'agents') {
    if (values.json) { console.log(JSON.stringify({ agents: router.agents(), root: router.root })); return; }
    for (const agent of router.agents()) console.log(`${agent.id}：${agent.description}`);
    console.log(`收录目录：${router.root}`); return;
  }
  if (command === 'runs') {
    const limit = Number(values.limit ?? 20);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('--limit须为1–100');
    const records = await router.runs(limit);
    if (values.json) { console.log(redactTask(JSON.stringify(records))); return; }
    for (const { record, directory } of records) console.log(redactTask(`${record.started_at} ${record.agent} ${record.status} / ${record.task_verdict}\n${record.task.slice(0, 80)}\n${directory}\n`));
    if (!records.length) console.log('暂无任务记录'); return;
  }
  if (command !== 'run') throw new Error('命令只能是agents、run或runs');
  if (!values.agent) throw new Error('请用--agent手动选择harness或codex');
  if (values['task-file'] && parts.length) throw new Error('任务文字和--task-file二选一');
  let task = '';
  if (values['task-file'] === '-') { for await (const chunk of process.stdin) task += chunk; }
  else task = values['task-file'] ? await readFile(values['task-file'], 'utf8') : parts.join(' ');
  const abort = new AbortController();
  const onInterrupt = () => abort.abort();
  process.on('SIGINT', onInterrupt); process.on('SIGTERM', onInterrupt);
  try {
    const { record, directory } = await router.run({ agent: values.agent as AgentId, task, skill: values.skill,
      timeout_seconds: Number(values.timeout ?? 300), expected_files: values.expect }, {
      signal: abort.signal,
      onStatus: values.json ? undefined : (record, directory) => console.log(`任务 ${record.id}：${record.status}\n${directory}`),
    });
    if (values.json) console.log(redactTask(JSON.stringify({ record, directory })));
    else {
      console.log(redactTask(record.answer ?? `未完成：${record.error}`));
      console.log(`\n执行：${record.status}；验收：${record.task_verdict}；文件：${record.artifacts.length}`);
      if (record.missing_files.length) console.log(`缺少期望文件：${record.missing_files.join('、')}`);
      console.log(`工作目录：${record.workspace}`);
    }
    if (record.status !== 'completed') process.exitCode = 1;
    else if (record.task_verdict === 'failed_checks') process.exitCode = 2;
  } finally { process.off('SIGINT', onInterrupt); process.off('SIGTERM', onInterrupt); }
}
main().catch(error => { console.error(redactTask(`任务入口失败：${error instanceof Error ? error.message : 'UnknownError'}`)); process.exitCode = 1; });
