import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { finished } from 'node:stream/promises';

// 注册表决定合法执行端，类型无需随每个新适配器改动。
export type AgentId = string;
export interface RouterTask {
  agent: AgentId; task: string; skill?: string; expected_files?: string[]; timeout_seconds?: number;
}
export interface TaskPaths { directory: string; workspace: string }
export interface AdapterOutcome {
  completed: boolean; answer: string | null; error: string | null;
  task_verdict?: 'needs_review' | 'failed_checks' | 'not_completed';
  usage?: Record<string, unknown> | null; session_id?: string | null;
}
export interface Launch { executable: string; args: string[]; stdin: string; env?: NodeJS.ProcessEnv; inheritProcessGroup?: boolean }
export interface AgentAdapter {
  id: AgentId; description: string;
  validate(task: RouterTask): Promise<void>;
  launch(task: RouterTask, paths: TaskPaths): Promise<Launch>;
  result(events: unknown[], paths: TaskPaths): Promise<AdapterOutcome>;
}
export interface Artifact { path: string; bytes: number; sha256: string }
export interface TaskRecord {
  id: string; agent: AgentId; task: string; skill?: string;
  started_at: string; finished_at: string | null; workspace: string; timeout_seconds: number;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled';
  task_verdict: 'needs_review' | 'failed_checks' | 'not_completed';
  exit_code: number | null; signal: string | null; error: string | null;
  answer: string | null; usage: Record<string, unknown> | null; session_id: string | null;
  artifacts: Artifact[]; skipped_paths: string[]; expected_files: string[]; missing_files: string[];
}
export const DEFAULT_TASK_ROOT = join(homedir(), 'Documents/Agent-Runs');

export function taskDate(now: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric',
    month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (type: string) => parts.find(part => part.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
// 不记录凭据；模型参数和工具循环仍属于各自执行端。
export function redactTask(text: string) {
  for (const [name, value] of Object.entries(process.env)) {
    if (/API_KEY|TOKEN|PASSWORD|SECRET/i.test(name) && value && value.length >= 8) text = text.replaceAll(value, '[REDACTED]');
  }
  return text;
}
export function validArtifactPath(path: string) {
  return !!path && !isAbsolute(path) && !path.includes('\\') && path.split('/').every(part => part && part !== '.' && part !== '..');
}
async function saveRecord(directory: string, record: TaskRecord) {
  const temporary = join(directory, 'task.json.tmp');
  await writeFile(temporary, redactTask(JSON.stringify(record, null, 2)) + '\n', { mode: 0o600 });
  await rename(temporary, join(directory, 'task.json'));
}
async function artifacts(workspace: string) {
  const files: Artifact[] = [], skipped: string[] = [];
  const ignored = new Set(['.git', 'node_modules', '.venv', '__pycache__']);
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name), path = relative(workspace, full).split(sep).join('/');
      const stat = await lstat(full);
      if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()) { skipped.push(path); continue; }
      if (stat.isDirectory()) {
        if (ignored.has(entry.name)) skipped.push(path); else await walk(full);
        continue;
      }
      if (files.length >= 2_000) throw new Error('产物超过2000个文件，未完成收录');
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(full)) hash.update(chunk);
      files.push({ path, bytes: stat.size, sha256: hash.digest('hex') });
    }
  }
  await walk(workspace);
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), skipped };
}

async function execute(launch: Launch, paths: TaskPaths, timeout: number, signal?: AbortSignal,
  onEvent?: (event: unknown) => void) {
  const events: unknown[] = [];
  const output = createWriteStream(join(paths.directory, 'events.jsonl'), { flags: 'wx', mode: 0o600 });
  const stderr = createWriteStream(join(paths.directory, 'stderr.log'), { flags: 'wx', mode: 0o600 });
  let stopped: 'timed_out' | 'cancelled' | null = null, protocolError: string | null = null;
  let exitCode: number | null = null, exitSignal: string | null = null;
  let killFinished: Promise<void> | undefined;
  let logBytes = 0;
  const ownsProcessGroup = process.platform !== 'win32' && !launch.inheritProcessGroup;
  const child = spawn(launch.executable, launch.args, {
    cwd: paths.workspace, env: launch.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'],
    detached: ownsProcessGroup, shell: false,
  });
  const kill = (kind?: typeof stopped) => {
    stopped ??= kind ?? null;
    const send = (name: NodeJS.Signals) => {
      try { if (child.pid && ownsProcessGroup) process.kill(-child.pid, name); else child.kill(name); }
      catch { /* 进程组已经结束。 */ }
    };
    send('SIGTERM');
    // 主进程退出也不能取消后续强制终止：它启动的子进程可能仍然存活。
    killFinished ??= new Promise(done => setTimeout(() => { send('SIGKILL'); done(); }, 1_000));
  };
  const onAbort = () => kill('cancelled');
  const timer = setTimeout(() => kill('timed_out'), timeout * 1000);
  output.on('error', () => { protocolError = '执行日志写入失败'; kill(); });
  stderr.on('error', () => { protocolError = '错误日志写入失败'; kill(); });
  createInterface({ input: child.stdout }).on('line', line => {
    const clean = redactTask(line); logBytes += Buffer.byteLength(clean);
    if (logBytes > 64 * 1024 * 1024) { protocolError = '执行日志超过64MiB上限'; kill(); return; }
    try { const event = JSON.parse(clean); events.push(event); output.write(JSON.stringify(event) + '\n');
      try { onEvent?.(event); } catch { /* 观察者失败不能改变执行端的协议判断。 */ }
    }
    catch { protocolError = '执行端stdout不是合法JSONL'; output.write(JSON.stringify({ type: 'router.invalid_output', text: clean }) + '\n'); }
  });
  createInterface({ input: child.stderr }).on('line', line => {
    const clean = redactTask(line); logBytes += Buffer.byteLength(clean);
    if (logBytes > 64 * 1024 * 1024) { protocolError = '执行日志超过64MiB上限'; kill(); return; }
    stderr.write(clean + '\n');
  });
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  child.stdin.on('error', () => { /* 启动失败或提前退出，交由退出记录处理。 */ });
  child.stdin.end(launch.stdin);
  await new Promise<void>(done => {
    child.on('error', failure => { protocolError = `执行端启动失败：${(failure as NodeJS.ErrnoException).code ?? failure.name}`; });
    child.on('close', (code, name) => { exitCode = code; exitSignal = name; done(); });
  });
  clearTimeout(timer);
  if (killFinished) await killFinished;
  // 一次任务不保留后台子进程；嵌套Codex继承父进程组，由最外层统一清理。
  if (child.pid && ownsProcessGroup) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 进程组已结束。 */ }
  }
  signal?.removeEventListener('abort', onAbort);
  output.end(); stderr.end();
  await Promise.all([finished(output), finished(stderr)]);
  return { events, stopped, protocolError, exitCode, exitSignal };
}

export class TaskRouter {
  private adapters: Map<AgentId, AgentAdapter>;
  readonly root: string;
  constructor(adapters: AgentAdapter[], root = DEFAULT_TASK_ROOT, private readonly clock = () => new Date()) {
    this.adapters = new Map(adapters.map(adapter => [adapter.id, adapter]));
    if (this.adapters.size !== adapters.length) throw new Error('Agent注册名称重复');
    if (!isAbsolute(root)) throw new Error('收录根目录必须是绝对路径');
    this.root = resolve(root);
  }
  agents() { return [...this.adapters.values()].map(({ id, description }) => ({ id, description })); }

  async run(input: RouterTask, options: { signal?: AbortSignal; onStatus?: (record: TaskRecord, directory: string) => void;
    onEvent?: (event: unknown) => void } = {}) {
    const adapter = this.adapters.get(input.agent);
    if (!adapter) throw new Error('请选择已注册的Agent：' + [...this.adapters.keys()].join('、'));
    if (!input.task.trim()) throw new Error('任务不能为空');
    const expected = [...new Set(input.expected_files ?? [])];
    if (!expected.every(validArtifactPath)) throw new Error('期望文件须为工作目录内的相对路径，不能含..或绝对路径');
    const timeout = input.timeout_seconds ?? 300;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 3_600) throw new Error('超时须为1–3600秒的整数');
    await adapter.validate(input);
    const now = this.clock(), id = randomUUID();
    const directory = join(this.root, input.agent, taskDate(now), id);
    await mkdir(join(directory, 'workspace'), { recursive: true, mode: 0o700 });
    // macOS的/var等目录存在别名；传给执行端的目录须与实际cwd一致。
    const workspace = await realpath(join(directory, 'workspace'));
    const paths = { directory, workspace };
    const record: TaskRecord = { id, agent: input.agent, task: input.task,
      ...(input.skill === undefined ? {} : { skill: input.skill }),
      started_at: now.toISOString(), finished_at: null, workspace, timeout_seconds: timeout,
      status: 'queued', task_verdict: 'not_completed', exit_code: null, signal: null, error: null,
      answer: null, usage: null, session_id: null, artifacts: [], skipped_paths: [], expected_files: expected, missing_files: [] };
    await saveRecord(directory, record);
    await writeFile(join(directory, 'prompt.txt'), redactTask(input.task) + '\n', { mode: 0o600 });
    try {
      const launch = await adapter.launch(input, paths);
      record.status = 'running'; await saveRecord(directory, record); options.onStatus?.(record, directory);
      const execution = await execute(launch, paths, timeout, options.signal, options.onEvent);
      record.exit_code = execution.exitCode; record.signal = execution.exitSignal;
      const outcome = await adapter.result(execution.events, paths);
      record.answer = outcome.answer ? redactTask(outcome.answer) : null;
      record.usage = outcome.usage ?? null; record.session_id = outcome.session_id ?? null;
      if (execution.stopped) { record.status = execution.stopped; record.error = execution.stopped === 'timed_out' ? '执行超时，已终止任务进程组' : '任务已取消'; }
      else if (execution.protocolError || execution.exitCode !== 0 || !outcome.completed || !record.answer?.trim()) {
        record.status = 'failed'; record.error = execution.protocolError ?? outcome.error ?? `执行端退出码${execution.exitCode}，未获得完整结果`;
      } else { record.status = 'completed'; record.task_verdict = outcome.task_verdict ?? 'needs_review'; }
    } catch (failure) {
      record.status = 'failed'; record.error = failure instanceof Error ? redactTask(failure.message) : '执行端异常';
    }
    try {
      const collected = await artifacts(workspace);
      record.artifacts = collected.files; record.skipped_paths = collected.skipped;
      record.missing_files = expected.filter(path => !collected.files.some(file => file.path === path));
      if (record.status === 'completed' && record.missing_files.length) record.task_verdict = 'failed_checks';
    } catch (failure) {
      record.status = 'failed'; record.task_verdict = 'not_completed'; record.error = failure instanceof Error ? failure.message : '产物收录失败';
    }
    record.finished_at = this.clock().toISOString();
    await writeFile(join(directory, 'answer.md'), record.answer ?? `任务未完成：${record.error}`, { mode: 0o600 });
    await writeFile(join(directory, 'artifacts.json'), JSON.stringify({ files: record.artifacts,
      skipped_paths: record.skipped_paths, missing_files: record.missing_files }, null, 2) + '\n', { mode: 0o600 });
    await saveRecord(directory, record); options.onStatus?.(record, directory);
    return { record, directory };
  }

  async runs(limit = 20) {
    const records: { directory: string; record: TaskRecord }[] = [];
    for (const agent of this.adapters.keys()) {
      const agentRoot = join(this.root, agent);
      const dates = await readdir(agentRoot).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return []; throw error;
      });
      for (const date of dates.filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort().reverse()) {
        for (const id of await readdir(join(agentRoot, date))) {
          if (!/^[0-9a-f-]{36}$/.test(id)) continue;
          const directory = join(agentRoot, date, id);
          try { records.push({ directory, record: JSON.parse(await readFile(join(directory, 'task.json'), 'utf8')) }); }
          catch { /* 未完整初始化的目录不冒充任务记录。 */ }
        }
        if (records.filter(row => row.record.agent === agent).length >= limit) break;
      }
    }
    return records.sort((a, b) => b.record.started_at.localeCompare(a.record.started_at)).slice(0, limit);
  }
}
