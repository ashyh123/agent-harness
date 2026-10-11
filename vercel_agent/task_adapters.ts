import { constants } from 'node:fs';
import { access, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT } from './bridge.js';
import { loadSkill } from './skills.js';
import { redactTask, type AgentAdapter } from './task_router.js';

function executorEnvironment() {
  const env = { ...process.env };
  // 执行端不能递归提交中心任务，也不能取得主Agent的本地IPC凭据。
  delete env.TYPESAFE_API_KEY;
  delete env.MINIMAL_AGENT_TASK_CENTER_SOCKET;
  delete env.MINIMAL_AGENT_TASK_CENTER_TOKEN;
  delete env.MINIMAL_AGENT_TASK_COORDINATION;
  return env;
}

export async function findCodex(configured = process.env.MINIMAL_AGENT_CODEX_BIN) {
  const candidates = configured ? [configured] : [
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean).map(directory => join(directory, process.platform === 'win32' ? 'codex.exe' : 'codex')),
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
  ];
  for (const path of candidates) {
    if (!isAbsolute(path)) continue;
    try { await access(path, constants.X_OK); return path; } catch { /* 尝试下一个已知位置。 */ }
  }
  throw new Error('未找到Codex CLI；可用MINIMAL_AGENT_CODEX_BIN指定可执行文件的绝对路径');
}

export function createTaskAdapters(options: { codexBinary?: string } = {}): AgentAdapter[] {
  return [{
    id: 'harness', description: 'DeepSeek + LangGraph Harness；须指定本地Skill。',
    validate: async task => { if (!task.skill) throw new Error('harness执行端需要--skill'); await loadSkill(task.skill); },
    launch: async (task, paths) => ({ executable: process.execPath,
      args: [join(ROOT, 'vercel_agent/node_modules/tsx/dist/cli.mjs'),
        fileURLToPath(new URL('./router_worker.ts', import.meta.url)), task.skill!],
      stdin: task.task,
      env: { ...executorEnvironment(), MINIMAL_AGENT_ROUTER_WORKSPACE: paths.workspace },
    }),
    result: async events => {
      const event: any = [...events].reverse().find((event: any) => event?.type === 'harness.result');
      return { completed: event?.runtime_status === 'completed', answer: event?.answer ?? null,
        error: event?.error ?? 'Harness未返回结果', task_verdict: event?.task_verdict ?? 'not_completed',
        usage: event?.usage ?? null };
    },
  }, {
    id: 'codex', description: '本机Codex CLI；使用现有登录，在独立工作目录执行。',
    validate: async task => { if (task.skill) throw new Error('--skill仅用于harness；Codex使用自己的配置'); await findCodex(options.codexBinary); },
    launch: async (task, paths) => {
      const env = executorEnvironment();
      delete env.DEEPSEEK_API_KEY;
      return { executable: await findCodex(options.codexBinary),
        inheritProcessGroup: process.env.MINIMAL_AGENT_CODEX_SUBTASK === '1',
        args: ['--no-daemon', '--ask-for-approval', 'never', 'exec', '--sandbox', 'workspace-write',
          '--skip-git-repo-check', '--ephemeral', '--json', '--color', 'never',
          '--output-last-message', join(paths.directory, 'last-message.txt'), '--cd', paths.workspace, '-'],
        env,
        stdin: `当前任务在独立工作目录中执行。生成的文件都保存到当前工作目录，用相对路径；不要修改工作目录之外的文件。\n`
          + `只执行当前任务，不启动其他Agent，不发送消息或对外发布。完成后如实说明结果、文件路径和未完成事项。\n\n用户任务：\n${task.task}`,
      };
    },
    result: async (events, paths) => {
      const data = events as any[];
      const failed = data.find(event => event?.type === 'turn.failed' || event?.type === 'error');
      const completed = [...data].reverse().find(event => event?.type === 'turn.completed');
      const final = await readFile(join(paths.directory, 'last-message.txt'), 'utf8').catch(() => null);
      if (final !== null) await writeFile(join(paths.directory, 'last-message.txt'), redactTask(final), { mode: 0o600 });
      const fallback = [...data].reverse().find(event => event?.type === 'item.completed' && event.item?.type === 'agent_message')?.item?.text;
      return { completed: !!completed && !failed, answer: final?.trim() || fallback || null,
        error: failed ? 'Codex报告执行失败；详见events.jsonl和stderr.log' : !completed ? 'Codex未返回turn.completed' : null,
        usage: completed?.usage ?? null,
        session_id: data.find(event => event?.type === 'thread.started')?.thread_id ?? null };
    },
  }];
}
