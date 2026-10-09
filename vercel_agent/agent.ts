import { createDeepSeek } from '@ai-sdk/deepseek';
import { ToolLoopAgent, generateText, isStepCount, jsonSchema, tool, Output, NoObjectGeneratedError,
  type JSONSchema7, type ModelMessage, type ToolSet } from 'ai';
import { BridgeError, PythonBridge } from './bridge.js';
import { CONTEXT_INSTRUCTION, SUMMARY_INSTRUCTION, ContextError, DEFAULT_CONTEXT_POLICY,
  compactedMessages, estimateInput, type ContextPolicy } from './context.js';
import { planWorkingContext, workingMessages, workingSummaryInput, parseWorkingState,
  WORKING_SUMMARY_INSTRUCTION } from './working_context.js';
import { offloadContext } from './offload_context.js';

export interface Configuration {
  tools: { name: string; description: string; parameters: JSONSchema7 }[];
  system_prompt: string; compact_retry_prompt: string; compact_notice: string; model: string;
  max_steps: number; max_model_requests: number; max_tool_calls: number; max_seconds: number; max_output_tokens: number;
  context_policy?: Partial<ContextPolicy>;
  temperature?: number;
}
export interface RunResult {
  answer: string | null; error: string | null; model_requests: number; tool_calls: number;
  outer_requests: number; total_tokens: number; events: any[]; sdk_steps: any[];
  compact_retry_used: boolean; output_truncated: boolean;
  context_compactions: { input_estimated_tokens: number; output_estimated_tokens: number;
    strategy?: ContextPolicy['strategy']; method?: 'local_offload' | 'summary_fallback'; target_met?: boolean; kept_recent_estimated_tokens?: number; protected_fact_count?: number;
    offloaded_results?: { call_id: string; document_id: string; original_chars: number; preview_chars: number }[] }[];
  notices: string[];
  context_policy: ContextPolicy;
  completion_source: 'model' | 'verified_tool' | null;
}
class RunStopped extends Error {}

export interface ToolCompletion {
  toolName: string;
  accepts: (output: unknown) => boolean;
  render: (output: any, input: any) => string;
}

export class VercelLoop {
  constructor(public readonly bridge: PythonBridge, public readonly config: Configuration,
              private readonly fetcher: typeof fetch = fetch) {}

  async run(messages: ModelMessage[], options: { fixtures?: Record<string, unknown>; limits?: Record<string, number>; maxRetries?: number;
    onNotice?: (notice: string) => void; toolCompletion?: ToolCompletion } = {}): Promise<RunResult> {
    const limits = { max_steps: this.config.max_steps, max_model_requests: this.config.max_model_requests,
      max_tool_calls: this.config.max_tool_calls, max_seconds: this.config.max_seconds, ...options.limits };
    await this.bridge.request('start', { fixtures: options.fixtures, limits });
    let working: ModelMessage[] = [...messages];
    const sdkSteps: any[] = [];
    const contextCompactions: RunResult['context_compactions'] = [];
    const notices: string[] = [];
    const policy = { ...DEFAULT_CONTEXT_POLICY, ...this.config.context_policy };
    const instructions = `${this.config.system_prompt}\n\n${CONTEXT_INSTRUCTION}`;
    let modelKind = 'vercel';
    let compact = false;
    let fatal: Error | undefined;
    let answer: string | null = null;
    let error: string | null = null;
    let completionSource: RunResult['completion_source'] = null;

    // HTTP 中间层计入共享预算并记录原始用量，不承担 SDK 的工具循环。
    const countedFetch: typeof fetch = async (input, init) => {
      if (fatal) throw fatal;
      let reservation: { event_id: number; remaining_seconds: number };
      try {
        reservation = await this.bridge.request('begin_model', { kind: modelKind });
      } catch (failure) {
        if (failure instanceof BridgeError && failure.code === 'budget_exceeded') fatal = failure;
        throw failure;
      }
      let response: Response;
      let body: any;
      try {
        const timeout = AbortSignal.timeout(Math.max(1, Math.floor(Math.min(30, reservation.remaining_seconds) * 1000)));
        response = await this.fetcher(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
        body = await response.clone().json();
      } catch (failure) {
        await this.bridge.request('end_model', { event_id: reservation.event_id, error_type: (failure as Error).name });
        throw failure;
      }
      const choice = body.choices?.[0];
      const discarded = choice?.finish_reason === 'length' ? (choice.message?.tool_calls?.length ?? 0) : 0;
      await this.bridge.request('end_model', {
        event_id: reservation.event_id, usage: body.usage ?? null, finish_reason: choice?.finish_reason ?? null,
        ...(response.ok ? {} : { error_type: 'HTTPError', status_code: response.status }),
        ...(discarded ? { discarded_tool_calls: discarded } : {}),
      });
      // 与手写版一致：截断的工具调用整条丢弃，防止 SDK 尝试执行它。
      if (discarded) {
        delete choice.message.tool_calls;
        return new Response(JSON.stringify(body), { status: response.status, headers: { 'content-type': 'application/json' } });
      }
      return response;
    };
    const provider = createDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY ?? 'offline-test-key', fetch: countedFetch });
    const tools: ToolSet = Object.fromEntries(this.config.tools.map(definition => [definition.name, tool({
      description: definition.description,
      inputSchema: jsonSchema<Record<string, unknown>>(definition.parameters, {
        validate: async value => {
          const result = await this.bridge.request('validate_tool', { name: definition.name, arguments: value });
          return result.valid ? { success: true, value: result.value } : {
            success: false, error: new Error(`工具参数不符合原工具库要求：${JSON.stringify(result.errors ?? [])}`),
          };
        },
      }),
      execute: async (input, { toolCallId }) => {
        try { return await this.bridge.request('call_tool', { name: definition.name, arguments: input, tool_call_id: toolCallId }); }
        catch (failure) { fatal = failure as Error; throw failure; }
      },
    })]));

    const prepareContext = async (current: ModelMessage[]) => {
      if (fatal) throw fatal;
      let size = estimateInput(current, instructions, this.config.tools, this.config.max_output_tokens);
      if (size < policy.trigger_tokens) return current;
      if (policy.strategy === 'artifact_offload') {
        const reduction = offloadContext(current, policy, instructions, this.config.tools, this.config.max_output_tokens);
        if (reduction.replaced.length) {
          contextCompactions.push({ input_estimated_tokens: size, output_estimated_tokens: reduction.after,
            strategy: policy.strategy, method: 'local_offload', target_met: reduction.target_met,
            offloaded_results: reduction.replaced });
          const notice = `说明：${reduction.replaced.length}个网页结果已本地移出至原有快照；保留短预览和回查信息，上下文约${reduction.after} tokens（估算）。${reduction.target_met ? '已达到维护目标。' : '尚未达到维护目标；该目标不是硬容量限制。'}未调用摘要模型。`;
          notices.push(notice); options.onNotice?.(notice);
        }
        if (!reduction.requires_fallback) return reduction.messages;
        // 本地移出仍越过硬边界才升级到现有摘要恢复；仍共享预算，不重跑工具。
        current = reduction.messages;
        size = reduction.after;
      }
      const plan = policy.strategy === 'working_memory'
        ? planWorkingContext(current, policy, instructions, this.config.tools, this.config.max_output_tokens) : undefined;
      const summaryInstruction = plan ? WORKING_SUMMARY_INSTRUCTION : SUMMARY_INSTRUCTION;
      const summaryInput = plan ? workingSummaryInput(plan) : current;
      if (estimateInput([{ role: 'user', content: JSON.stringify(summaryInput) }], summaryInstruction, [], policy.summary_output_tokens) > policy.max_input_tokens) {
        throw new ContextError('输入超过本地安全容量，无法通过一次摘要安全压缩；请缩小本次输入');
      }
      const minimum = estimateInput(plan ? workingMessages(plan, plan.previous) : compactedMessages(current, ''),
        instructions, this.config.tools, this.config.max_output_tokens);
      const summaryTarget = policy.strategy === 'artifact_offload'
        ? Math.min(policy.max_input_tokens, Math.max(policy.target_tokens, minimum + policy.summary_output_tokens))
        : policy.target_tokens;
      if (minimum >= summaryTarget) throw new ContextError(policy.strategy === 'artifact_offload'
        ? '必须保留的任务、指令和来源索引超过硬容量，无法安全恢复'
        : '必须保留的任务、指令和来源索引过大，无法压缩到目标容量');
      // Skill/工具 Schema 占用越多，摘要可用空间越少；不能固定生成长摘要再期望它塞得下。
      const free = summaryTarget - minimum;
      const summaryCharacters = Math.max(1, Math.min(600, Math.floor(free * 2 / 3 * 0.7)));
      const summaryOutputTokens = Math.min(policy.summary_output_tokens, Math.max(64, Math.floor(free * 0.6)));
      const summaryInstructions = plan
        ? `${summaryInstruction}\n新增状态保持简短，生成上限 ${summaryOutputTokens} tokens；优先关键事实与缺口，不重复长URL或文档ID。`
        : `${summaryInstruction}\n本次摘要必须不超过 ${summaryCharacters} 个字符；用短句保留继续任务必需的事实和缺口，不复述系统/Skill 指令，不重复长 URL 或文档 ID。`;
      // 至少留出摘要和继续执行各一次，避免花完最后一次请求只得到内部摘要。
      await this.bridge.request('ensure_model_capacity', { requests: 2 });
      const notify = (notice: string) => { notices.push(notice); options.onNotice?.(notice); };
      notify(`说明：累计上下文约 ${size} tokens（估算）达到阈值，正在自动压缩；原网页快照可回查，压缩计入本轮预算。`);
      modelKind = 'vercel_context_compaction';
      let summary;
      try {
        summary = await generateText({
          model: provider(this.config.model), system: summaryInstructions,
          prompt: JSON.stringify(summaryInput), maxOutputTokens: summaryOutputTokens, maxRetries: 0,
          temperature: this.config.temperature,
          output: plan ? Output.json() : undefined,
          providerOptions: { deepseek: { thinking: { type: 'disabled' } } },
        });
      } catch (failure) {
        if (plan && NoObjectGeneratedError.isInstance(failure)) {
          throw new ContextError('上下文摘要没有完整生成：任务状态不是完整合法的 JSON，未提交压缩结果');
        }
        throw failure;
      } finally { modelKind = compact ? 'vercel_compact_retry' : 'vercel'; }
      if (summary.finishReason !== 'stop' || !summary.text.trim()) {
        throw new ContextError('上下文摘要没有完整生成，本轮停止；未提交残缺摘要');
      }
      const state = plan ? parseWorkingState(summary.text, plan) : undefined;
      const reduced = plan && state ? workingMessages(plan, state) : compactedMessages(current, summary.text);
      const after = estimateInput(reduced, instructions, this.config.tools, this.config.max_output_tokens);
      if (after > summaryTarget || after >= size) throw new ContextError(`摘要未压缩到目标容量（估算 ${after}，目标 ${summaryTarget}），本轮停止`);
      contextCompactions.push({ input_estimated_tokens: size, output_estimated_tokens: after, strategy: policy.strategy, ...(policy.strategy === 'artifact_offload' ? { method: 'summary_fallback' as const, target_met: after <= policy.target_tokens } : {}),
        ...(plan && state ? { kept_recent_estimated_tokens: plan.recent_estimated_tokens, protected_fact_count: state.facts.length } : {}) });
      notify(`说明：上下文已自动压缩至约 ${after} tokens（估算）；保留当前任务、来源和回查位置，摘要可能遗漏细节。`);
      return reduced;
    };
    const makeAgent = () => new ToolLoopAgent({
      model: provider(this.config.model), instructions,
      temperature: this.config.temperature,
      tools, toolOrder: this.config.tools.map(tool => tool.name),
      // 默认保留对比基线；可按本轮开启 SDK 的模型请求重试。
      stopWhen: [isStepCount(limits.max_steps), ({ steps }) => !!options.toolCompletion &&
        !!steps.at(-1)?.toolResults.some(result => result.toolName === options.toolCompletion!.toolName
          && options.toolCompletion!.accepts(result.output))], maxRetries: options.maxRetries ?? 0,
      maxOutputTokens: this.config.max_output_tokens, providerOptions: { deepseek: { thinking: { type: 'disabled' } } },
      allowSystemInMessages: true,
      prepareStep: async ({ messages: current }) => {
        working = await prepareContext(current);
        return { messages: working };
      },
      onStepEnd: async step => {
        // SDK 的观察回调会吞掉异常，不能依靠在这里 throw 来停止循环。
        try {
          for (const call of step.toolCalls) {
            if (call.invalid) await this.bridge.request('invalid_tool', { name: call.toolName, tool_call_id: call.toolCallId });
          }
        } catch (failure) {
          fatal ??= failure as Error;
        }
        sdkSteps.push({ finish_reason: step.finishReason, tool_names: step.toolCalls.map(call => call.toolName),
                        tool_errors: step.content.filter(part => part.type === 'tool-error').length });
        if (step.finishReason !== 'length') working = [...working, ...step.response.messages];
      },
    });

    try {
      if (!['legacy', 'working_memory', 'artifact_offload'].includes(policy.strategy)
          || ![policy.trigger_tokens, policy.target_tokens, policy.max_input_tokens, policy.summary_output_tokens,
            policy.keep_recent_tokens].every(value => Number.isSafeInteger(value) && value > 0)
          || policy.target_tokens >= policy.trigger_tokens || policy.trigger_tokens >= policy.max_input_tokens) {
        throw new ContextError('上下文容量配置无效：应满足 target < trigger < max_input');
      }
      let result = await makeAgent().generate({ messages: [...messages] });
      if (fatal) throw fatal;
      if (result.finishReason === 'length') {
        compact = true;
        modelKind = 'vercel_compact_retry';
        result = await makeAgent().generate({ messages: [...working, { role: 'system', content: this.config.compact_retry_prompt }] });
        if (fatal) throw fatal;
      }
      if (result.finishReason === 'length') throw new RunStopped('自动精简重试仍达到输出上限，本轮未完成');
      const completedTool = options.toolCompletion && result.steps.at(-1)?.toolResults.find(part =>
        part.toolName === options.toolCompletion!.toolName && options.toolCompletion!.accepts(part.output));
      if (completedTool) {
        const call = result.steps.at(-1)!.toolCalls.find(part => part.toolCallId === completedTool.toolCallId);
        answer = (compact ? this.config.compact_notice : '') + options.toolCompletion!.render(completedTool.output, call?.input);
        completionSource = 'verified_tool';
        // 已验收的工具产物可作为运行终点；宿主返回真实收据，无需模型再口头确认。
        working.push({ role: 'assistant', content: answer });
      } else {
        if (result.finishReason === 'tool-calls') throw new RunStopped('SDK 停在工具步骤，尚无最终答案，本轮未完成');
        if (!result.text.trim()) throw new RunStopped('模型没有返回完整文本答案');
        answer = (compact ? this.config.compact_notice : '') + result.text;
        completionSource = 'model';
      }
      // 只有成功才提交本轮历史；通知和用户看到的回答保持一致。
      if (compact) working = working.filter(message => !(message.role === 'system' && message.content === this.config.compact_retry_prompt));
      const last = working.at(-1);
      if (last?.role === 'assistant') working[working.length - 1] = { role: 'assistant', content: answer };
      messages.splice(0, messages.length, ...working);
    } catch (failure) {
      const e = (fatal ?? failure) as Error & { statusCode?: number };
      error = e instanceof RunStopped || e instanceof BridgeError || e instanceof ContextError ? e.message : `${e.name}${e.statusCode ? `，HTTP ${e.statusCode}` : ''}`;
    }
    const trace = await this.bridge.request('trace');
    return { ...trace, answer, error, total_tokens: trace.events.reduce((sum: number, event: any) => sum + (event.usage?.total_tokens ?? 0), 0),
             sdk_steps: sdkSteps, compact_retry_used: compact,
             context_compactions: contextCompactions, notices, context_policy: policy,
             completion_source: completionSource,
             output_truncated: trace.events.some((event: any) => event.finish_reason === 'length' || event.status === 'incomplete') };
  }
}
