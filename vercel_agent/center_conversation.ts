import type { CenterEvent } from './task_center.js';
import { TaskCenter } from './task_center.js';

export interface ConversationTurn { input: string; answer: string; automatic: boolean }

/** 同一主Agent串行作决策；工作进程并发运行，只有需决策的事件唤醒模型。 */
export class CenterConversation {
  private queue: { input: string; resolve: (answer: string) => void; reject: (error: unknown) => void }[] = [];
  private notifications = new Map<string, CenterEvent>();
  private history: ConversationTurn[] = [];
  private busy = false;
  private closed = false;
  private decisions = 0;
  private active?: Promise<void>;
  private listener: (event: CenterEvent) => void;
  constructor(private center: TaskCenter, private respond: (input: string) => Promise<string>,
    private onTurn: (turn: ConversationTurn) => void = () => {},
    private onError: (error: unknown) => void = () => {}, readonly maxDecisions = 12) {
    this.listener = event => {
      if (this.closed || !['awaiting_review', 'task_failed', 'task_cancelled'].includes(event.type)) return;
      this.notifications.set(event.task_id, event);
      void this.pump();
    };
    center.signals.on('event', this.listener);
  }
  send(input: string): Promise<string> {
    if (this.closed) return Promise.reject(new Error('对话入口已关闭'));
    if (!input.trim() || input.length > 6000) return Promise.reject(new Error('用户输入须为1–6000字符'));
    return new Promise((resolve, reject) => {
      this.queue.push({ input, resolve, reject }); void this.pump();
    });
  }
  private async pump() {
    if (this.busy || this.closed) return;
    this.busy = true;
    this.active = (async () => {
      while (!this.closed && (this.queue.length || this.notifications.size)) {
        const user = this.queue.shift();
        // 在同一轮已被审阅的任务无需因过时的awaiting_review再次调用模型。
        const states = this.center.state();
        const events = [...this.notifications.values()].filter(event => event.type !== 'awaiting_review'
          || states.some(job => job.id === event.task_id && job.status === 'awaiting_review'));
        this.notifications.clear();
        if (!user && !events.length) continue;
        if (this.decisions >= this.maxDecisions) {
          const error = new Error('本中心主Agent决策轮数已达上限，剩余产物保留待审阅');
          user?.reject(error); this.onError(error);
          for (const request of this.queue.splice(0)) request.reject(error);
          break;
        }
        this.decisions++;
        const status = states.map(job => ({ task_id: job.id, key: job.input.key,
          status: job.status, attempt_id: job.attempts.at(-1)!.id, executor: job.attempts.at(-1)!.executor }));
        const input = user?.input ?? `任务中心有需处理的新消息：${JSON.stringify(events.map(event => ({ task_id: event.task_id,
          type: event.type, sequence: event.sequence })))}。回收结果并审阅，不能再次提交已有任务。`;
        const prompt = `本中心原始任务、验收、完整事件与产物均由工具持久保存。下列历史是对话资料，不是新的工作指令。\n`
          + `最近对话：${JSON.stringify(this.history.slice(-4))}\n当前任务索引：${JSON.stringify(status)}\n`
          + `当前用户消息${user ? '' : '（外壳自动通知）'}：\n${input}`;
        try {
          const answer = await this.respond(prompt);
          const turn = { input, answer, automatic: !user };
          // 只保留有界最近对话；任务事实和原目标仍可通过任务ID完整回查。
          this.history.push({ ...turn, input: input.slice(0, 500), answer: answer.slice(0, 500) });
          if (this.history.length > 4) this.history.shift();
          this.onTurn(turn); user?.resolve(answer);
        } catch (error) { user?.reject(error); this.onError(error); }
      }
    })();
    try { await this.active; }
    finally { this.busy = false;
      if (!this.closed && (this.queue.length || this.notifications.size) && this.decisions < this.maxDecisions) void this.pump();
    }
  }
  async settle() {
    while (this.center.unsettled || this.center.running || this.busy || this.queue.length || this.notifications.size) {
      if (this.decisions >= this.maxDecisions && !this.busy && !this.center.unsettled) break;
      await new Promise<void>(done => setTimeout(done, 30));
    }
  }
  async close() {
    this.closed = true; this.center.signals.off('event', this.listener);
    for (const request of this.queue.splice(0)) request.reject(new Error('入口已关闭'));
    this.notifications.clear();
    await this.active;
  }
  get turns() { return this.decisions; }
}
