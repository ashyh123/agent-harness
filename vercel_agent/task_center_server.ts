import { createServer, type Server, type Socket } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskCenter, type Submission } from './task_center.js';
import { redactTask } from './task_router.js';

/** 只在本机私有Unix socket交换单个JSON请求，不开HTTP端口。 */
export class TaskCenterServer {
  readonly token = randomBytes(32).toString('hex');
  socketPath = '';
  private temporary = '';
  private server?: Server;
  private connections = new Set<Socket>();
  constructor(private center: TaskCenter) {}
  async start() {
    this.temporary = await mkdtemp(join(tmpdir(), 'task-center-'));
    await chmod(this.temporary, 0o700);
    this.socketPath = join(this.temporary, 'ipc.sock');
    this.server = createServer(socket => {
      this.connections.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => this.connections.delete(socket));
      socket.setTimeout(15_000, () => socket.destroy());
      let buffer = Buffer.alloc(0), started = false;
      socket.on('data', chunk => {
        if (started) return;
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > 32_768) { started = true; socket.end(JSON.stringify({ error: 'IPC请求过大' }) + '\n'); return; }
        const newline = buffer.indexOf(10);
        if (newline < 0) return;
        started = true;
        void (async () => {
          try {
            const request = JSON.parse(buffer.subarray(0, newline).toString('utf8'));
            const supplied = Buffer.from(typeof request.token === 'string' ? request.token : '');
            const expected = Buffer.from(this.token);
            if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('IPC凭据无效');
            const data = await this.dispatch(request.op, request.arguments);
            socket.end(redactTask(JSON.stringify({ data })) + '\n');
          } catch (error) {
            socket.end(redactTask(JSON.stringify({ error: error instanceof Error ? error.message : '任务中心请求失败' })) + '\n');
          }
        })();
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.socketPath, () => { this.server!.off('error', reject); resolve(); });
    });
    await chmod(this.socketPath, 0o600);
    return { MINIMAL_AGENT_TASK_CENTER_SOCKET: this.socketPath, MINIMAL_AGENT_TASK_CENTER_TOKEN: this.token };
  }
  private dispatch(op: string, args: any) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('IPC参数无效');
    switch (op) {
      case 'submit_tasks': return this.center.submit(args.tasks as Submission[]);
      case 'get_task_updates': return this.center.updates(args.cursor ?? 0, args.limit ?? 10, args.task_id);
      case 'read_task_artifact': return this.center.read(args.task_id, args.attempt_id, args.path, args.offset ?? 0, args.limit ?? 3000);
      case 'review_task': return this.center.review(args.task_id, args.attempt_id, args.passed, args.reason, args.evidence ?? []);
      case 'cancel_task': return this.center.cancel(args.task_id);
      default: throw new Error('任务中心操作未注册');
    }
  }
  async close() {
    for (const socket of this.connections) socket.destroy();
    if (this.server?.listening) await new Promise<void>(resolve => this.server!.close(() => resolve()));
    if (this.temporary) await rm(this.temporary, { force: true, recursive: true });
  }
}
