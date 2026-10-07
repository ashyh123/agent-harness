import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { VercelLoop, type Configuration, type RunResult } from './agent.js';
import { PythonBridge, ROOT, redact } from './bridge.js';
import { loadSkill, SKILLS_ROOT, type Skill } from './skills.js';

export interface TaskInput { skill: string; task: string }
export interface HarnessRecord {
  input: TaskInput;
  skill: Skill;
  started_at: string;
  finished_at: string;
  runtime_status: 'running' | 'completed' | 'failed';
  task_verdict: 'needs_review' | 'not_completed';
  configuration: {
    model: string; tool_names: string[]; max_steps: number; max_model_requests: number;
    max_tool_calls: number; max_seconds: number; max_output_tokens: number;
  };
  result: RunResult | null;
  harness_error: string | null;
}

export class MinimalHarness {
  constructor(private readonly bridge: PythonBridge, private readonly config: Configuration,
              private readonly paths = { skills: SKILLS_ROOT, runs: join(ROOT, 'reports/harness') },
              private readonly fetcher: typeof fetch = fetch) {}

  async run(input: TaskInput): Promise<{ directory: string; record: HarnessRecord }> {
    if (!input.task.trim()) throw new Error('任务不能为空');
    const skill = await loadSkill(input.skill, this.paths.skills);
    await mkdir(this.paths.runs, { recursive: true });
    const directory = await mkdtemp(join(this.paths.runs, `${skill.name}-`));
    const record: HarnessRecord = {
      input: { ...input }, skill, started_at: new Date().toISOString(), finished_at: '',
      runtime_status: 'running', task_verdict: 'not_completed', result: null, harness_error: null,
      configuration: {
        model: this.config.model, tool_names: this.config.tools.map(tool => tool.name),
        max_steps: this.config.max_steps, max_model_requests: this.config.max_model_requests,
        max_tool_calls: this.config.max_tool_calls, max_seconds: this.config.max_seconds,
        max_output_tokens: this.config.max_output_tokens,
      },
    };
    const save = () => writeFile(join(directory, 'run.json'), redact(JSON.stringify(record, null, 2)) + '\n');
    // 请求前先留任务记录；中途被终止时，未写 finished_at 的记录可以识别为未收尾。
    await save();
    try {
      const loop = new VercelLoop(this.bridge, {
        ...this.config,
        system_prompt: `${this.config.system_prompt}\n\n当前选定 Skill：${skill.name}\n${skill.instructions}`,
      }, this.fetcher);
      // 每个任务独立上下文；Skill 不写进下一任务的历史。
      record.result = await loop.run([{ role: 'user', content: input.task }], {
        limits: {
          max_model_requests: this.config.max_model_requests,
          max_tool_calls: this.config.max_tool_calls,
          max_seconds: this.config.max_seconds,
        },
      });
      record.runtime_status = 'failed';
      if (!record.result.error && record.result.answer?.trim()) {
        record.runtime_status = 'completed';
        record.task_verdict = 'needs_review';
      }
    } catch (failure) {
      // 不转印原始网络错误、请求或堆栈。
      record.runtime_status = 'failed';
      record.harness_error = failure instanceof Error ? failure.name : 'UnknownError';
    }
    record.finished_at = new Date().toISOString();
    await save();
    const body = record.result?.answer ?? `运行未完成：${record.result?.error ?? record.harness_error}`;
    await writeFile(join(directory, 'answer.md'), redact(
      `# ${skill.name}\n\n运行状态：${record.runtime_status}\n任务验收：${record.task_verdict}\n\n${body}\n`,
    ));
    return { directory, record };
  }
}
