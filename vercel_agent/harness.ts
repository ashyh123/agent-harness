import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LangGraphLoop } from './langgraph_loop.js';
import type { Configuration, RunResult } from './execution_runtime.js';
import { PythonBridge, ROOT, redact } from './bridge.js';
import { SKILL_CHECKS, type CheckReport } from './checks.js';
import { loadSkill, SKILLS_ROOT, type Skill } from './skills.js';
import { DEFAULT_CONTEXT_POLICY, type ContextPolicy } from './context.js';
import type { ReadingContract } from './reading_validation.js';

export interface TaskInput { skill: string; task: string; readingContract?: ReadingContract;
  readingReview?: 'structural' | 'semantic' }
export interface HarnessRecord {
  input: TaskInput;
  skill: Skill;
  started_at: string;
  finished_at: string;
  runtime_status: 'running' | 'completed' | 'failed';
  task_verdict: 'needs_review' | 'failed_checks' | 'not_completed';
  configuration: {
    model: string; tool_names: string[]; max_steps: number; max_model_requests: number;
    max_tool_calls: number; max_seconds: number; max_output_tokens: number;
    context_policy: ContextPolicy;
    temperature?: number;
  };
  result: RunResult | null;
  automatic_checks: CheckReport | null;
  harness_error: string | null;
}

function checkSection(report: CheckReport) {
  const lines = report.items.map(item => `- ${item.passed ? '通过' : '未通过'} ${item.name}：${item.detail}`);
  const missing = report.quotes.filter(quote => !quote.found_in_source)
    .map(quote => `- 第 ${quote.row} 行：\`${quote.quote}\``);
  return `\n\n---\n\n## 自动检查：${report.passed ? '通过' : '未通过'}\n\n${lines.join('\n')}\n`
    + (missing.length ? `\n未在工具原文中找到的引文：\n\n${missing.join('\n')}\n` : '')
    + `\n${report.scope}\n`;
}

export class MinimalHarness {
  constructor(private readonly bridge: PythonBridge, private readonly config: Configuration,
              private readonly paths = { skills: SKILLS_ROOT, runs: join(ROOT, 'reports/harness') },
              private readonly fetcher: typeof fetch = fetch,
              private readonly loopFactory: (bridge: PythonBridge, config: Configuration, fetcher: typeof fetch) => Pick<LangGraphLoop, 'run'>
                = (bridge, config, fetcher) => new LangGraphLoop(bridge, config, fetcher)) {}

  async run(input: TaskInput, options: { onNotice?: (notice: string) => void;
    fixtures?: Record<string, unknown> } = {}): Promise<{ directory: string; record: HarnessRecord }> {
    if (!input.task.trim()) throw new Error('任务不能为空');
    const skill = await loadSkill(input.skill, this.paths.skills);
    if (skill.name === 'task-coordinator' && process.env.MINIMAL_AGENT_ROUTING_CLASSIFIER === 'jev-exclusive') {
      const paragraphs = skill.instructions.split('\n\n');
      paragraphs[0] = '你是统一任务入口。普通聊天直接回答；用户发布工作时，判断信息是否足够，为互不依赖的任务调用submit_tasks，给唯一key、完整目标和验收条件。有依赖的步骤保持为一项任务。业务由执行端完成。';
      paragraphs[1] = '能力和复杂度完全由Jev分类服务判断，你不判断、不填写、不在任务正文附加分类建议。route默认auto；仅当用户明确指定执行端才填写对应route。代码根据Jev分类和注册表选择执行端。收到分类失败时如实说明任务未提交，不猜测分类。';
      paragraphs[2] = paragraphs[2].replace('JSON/代码文件任务可明确给出产物路径，routine执行端不具备任意文件写入能力时应选择coding/advanced。', 'JSON/代码文件任务明确给出用户要求的产物路径。');
      skill.instructions = paragraphs.join('\n\n').replace('分配理由、完成/失败/取消/待审阅', '实际调度结果、完成/失败/取消/待审阅');
    }
    if (skill.name === 'task-coordinator' && !this.config.tools.some(tool => tool.name === 'submit_tasks')) {
      throw new Error('task-coordinator需要运行中的任务中心；请用npm run person');
    }
    if (skill.name === 'person-agent' && !this.config.tools.some(tool => tool.name === 'delegate_to_codex')) {
      throw new Error('person-agent需要委派工具；请用npm run person:delegate或配置了person profile的Harness入口');
    }
    if (skill.name === 'obsidian-blog-reader' && (input.task.match(/https?:\/\/\S+/g)?.length ?? 0) > 1) {
      throw new Error('obsidian-blog-reader 每次任务处理一篇文章；多篇请逐篇调用，避免只保存第一篇就误报全部完成');
    }
    await mkdir(this.paths.runs, { recursive: true });
    const directory = await mkdtemp(join(this.paths.runs, `${skill.name}-`));
    const record: HarnessRecord = {
      input: { ...input }, skill, started_at: new Date().toISOString(), finished_at: '',
      runtime_status: 'running', task_verdict: 'not_completed', result: null, automatic_checks: null, harness_error: null,
      configuration: {
        model: this.config.model, tool_names: this.config.tools.map(tool => tool.name),
        max_steps: this.config.max_steps, max_model_requests: this.config.max_model_requests,
        max_tool_calls: this.config.max_tool_calls, max_seconds: this.config.max_seconds,
        max_output_tokens: this.config.max_output_tokens,
        context_policy: { ...DEFAULT_CONTEXT_POLICY, ...this.config.context_policy },
        temperature: this.config.temperature,
      },
    };
    const save = () => writeFile(join(directory, 'run.json'), redact(JSON.stringify(record, null, 2)) + '\n');
    // 请求前先留任务记录；中途被终止时，未写 finished_at 的记录可以识别为未收尾。
    await save();
    try {
      const loop = this.loopFactory(this.bridge, {
        ...this.config,
        system_prompt: `${this.config.system_prompt}\n\n当前选定 Skill：${skill.name}\n${skill.instructions}`,
      }, this.fetcher);
      // 每个任务独立上下文；Skill 不写进下一任务的历史。
      record.result = await loop.run([{ role: 'user', content: input.task }], {
        readingContract: input.readingContract,
        readingReview: input.readingReview,
        onNotice: options.onNotice,
        fixtures: options.fixtures,
        toolCompletion: skill.name === 'obsidian-blog-reader' ? {
          toolName: 'save_obsidian_blog',
          accepts: output => !!output && typeof output === 'object' && (output as any).verified === true
            && ['saved', 'already_saved'].includes((output as any).status),
          render: (output, arguments_) => `已保存并回读核验。\n\n来源：${output.source_url}\n\n`
            + `简化内容：${arguments_.summary}\n\n对我的 Agent 的启发：${arguments_.takeaway}\n\n`
            + `保存路径：${output.note_path}\n\n实际阅读范围见笔记；网页完整性仍未验证，语义内容需人工核对。`,
        } : undefined,
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
        const check = SKILL_CHECKS[skill.name];
        if (check) {
          record.automatic_checks = check(record.result.answer, record.result.events);
          // 程序检查只能否决；全部通过仍需人工验收。
          if (!record.automatic_checks.passed) record.task_verdict = 'failed_checks';
        }
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
      `# ${skill.name}\n\n运行状态：${record.runtime_status}\n任务验收：${record.task_verdict}\n\n${body}\n`
      + (record.automatic_checks ? checkSection(record.automatic_checks) : ''),
    ));
    return { directory, record };
  }
}
