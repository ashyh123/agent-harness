import { createDeepSeek } from '@ai-sdk/deepseek';
import { ToolLoopAgent, isStepCount, jsonSchema, tool, type JSONSchema7, type ModelMessage, type ToolSet } from 'ai';
import { BridgeError, PythonBridge } from './bridge.js';

export interface Configuration {
  tools: { name: string; description: string; parameters: JSONSchema7 }[];
  system_prompt: string; compact_retry_prompt: string; compact_notice: string; model: string;
  max_steps: number; max_model_requests: number; max_tool_calls: number; max_seconds: number; max_output_tokens: number;
}
export interface RunResult {
  answer: string | null; error: string | null; model_requests: number; tool_calls: number;
  outer_requests: number; total_tokens: number; events: any[]; sdk_steps: any[];
  compact_retry_used: boolean; output_truncated: boolean;
}
class RunStopped extends Error {}

export class VercelLoop {
  constructor(public readonly bridge: PythonBridge, public readonly config: Configuration,
              private readonly fetcher: typeof fetch = fetch) {}

  async run(messages: ModelMessage[], options: { fixtures?: Record<string, unknown>; limits?: Record<string, number>; maxRetries?: number } = {}): Promise<RunResult> {
    await this.bridge.request('start', options);
    const accepted: ModelMessage[] = [];
    const sdkSteps: any[] = [];
    let compact = false;
    let fatal: Error | undefined;
    let answer: string | null = null;
    let error: string | null = null;

    // HTTP 中间层计入共享预算并记录原始用量，不承担 SDK 的工具循环。
    const countedFetch: typeof fetch = async (input, init) => {
      if (fatal) throw fatal;
      let reservation: { event_id: number; remaining_seconds: number };
      try {
        reservation = await this.bridge.request('begin_model', { kind: compact ? 'vercel_compact_retry' : 'vercel' });
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
          return result.valid ? { success: true, value: result.value } : { success: false, error: new Error('工具参数不符合原工具库要求') };
        },
      }),
      execute: async (input, { toolCallId }) => {
        try { return await this.bridge.request('call_tool', { name: definition.name, arguments: input, tool_call_id: toolCallId }); }
        catch (failure) { fatal = failure as Error; throw failure; }
      },
    })]));

    const makeAgent = () => new ToolLoopAgent({
      model: provider(this.config.model), instructions: this.config.system_prompt,
      tools, toolOrder: this.config.tools.map(tool => tool.name),
      // 默认保留对比基线；可按本轮开启 SDK 的模型请求重试。
      stopWhen: isStepCount(this.config.max_steps), maxRetries: options.maxRetries ?? 0,
      maxOutputTokens: this.config.max_output_tokens, providerOptions: { deepseek: { thinking: { type: 'disabled' } } },
      allowSystemInMessages: true,
      prepareStep: () => { if (fatal) throw fatal; return {}; },
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
        if (step.finishReason !== 'length') accepted.push(...step.response.messages);
      },
    });

    try {
      let result = await makeAgent().generate({ messages: [...messages] });
      if (fatal) throw fatal;
      if (result.finishReason === 'length') {
        compact = true;
        result = await makeAgent().generate({ messages: [...messages, ...accepted, { role: 'system', content: this.config.compact_retry_prompt }] });
        if (fatal) throw fatal;
      }
      if (result.finishReason === 'length') throw new RunStopped('自动精简重试仍达到输出上限，本轮未完成');
      if (result.finishReason === 'tool-calls') throw new RunStopped('SDK 停在工具步骤，尚无最终答案，本轮未完成');
      if (!result.text.trim()) throw new RunStopped('模型没有返回完整文本答案');
      answer = (compact ? this.config.compact_notice : '') + result.text;
      // 只有成功才提交本轮历史；通知和用户看到的回答保持一致。
      const last = accepted.at(-1);
      if (last?.role === 'assistant') accepted[accepted.length - 1] = { role: 'assistant', content: answer };
      messages.push(...accepted);
    } catch (failure) {
      const e = (fatal ?? failure) as Error & { statusCode?: number };
      error = e instanceof RunStopped || e instanceof BridgeError ? e.message : `${e.name}${e.statusCode ? `，HTTP ${e.statusCode}` : ''}`;
    }
    const trace = await this.bridge.request('trace');
    return { ...trace, answer, error, total_tokens: trace.events.reduce((sum: number, event: any) => sum + (event.usage?.total_tokens ?? 0), 0),
             sdk_steps: sdkSteps, compact_retry_used: compact,
             output_truncated: trace.events.some((event: any) => event.finish_reason === 'length' || event.status === 'incomplete') };
  }
}
