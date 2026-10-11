import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));

export class BridgeError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

export class PythonBridge {
  private child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();

  constructor(env: NodeJS.ProcessEnv = process.env, cwd = ROOT) {
    this.child = spawn(join(ROOT, '.venv/bin/python'), ['-u', join(ROOT, 'vercel_agent/tool_bridge.py')], {
      cwd, env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const rejectAll = () => {
      for (const request of this.pending.values()) request.reject(new BridgeError('bridge_closed', 'Python 工具桥接已结束'));
      this.pending.clear();
    };
    this.child.on('error', rejectAll);
    this.child.on('exit', rejectAll);
    // 协议错误只报告类型，不转印可能含有请求数据的 stderr。
    this.child.stderr.resume();
    createInterface({ input: this.child.stdout }).on('line', line => {
      try {
        const reply = JSON.parse(line);
        const pending = this.pending.get(reply.id);
        if (!pending) return;
        this.pending.delete(reply.id);
        if (reply.ok) pending.resolve(reply.data);
        else pending.reject(new BridgeError(reply.error.code, reply.error.message));
      } catch { rejectAll(); this.child.kill(); }
    });
  }

  request<T = any>(op: string, fields: Record<string, unknown> = {}): Promise<T> {
    if (this.child.exitCode !== null || this.child.killed) return Promise.reject(new BridgeError('bridge_closed', 'Python 工具桥接不可用'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ ...fields, id, op }) + '\n', error => {
        if (error) { this.pending.delete(id); reject(new BridgeError('bridge_closed', '无法写入工具桥接')); }
      });
    });
  }

  close() { this.child.kill(); }
}

export function loadLocalEnv() {
  try { process.loadEnvFile(join(ROOT, '.env')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

export function redact(text: string) {
  for (const name of ['DEEPSEEK_API_KEY', 'TYPESAFE_API_KEY']) {
    const key = process.env[name];
    if (key) text = text.replaceAll(key, '[REDACTED]');
  }
  return text;
}
