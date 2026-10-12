/** LangGraph owns the model -> tools -> model cycle. No ToolLoopAgent here. */
import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import { generateText, type ModelMessage } from 'ai';
import { createExecutionRuntime, type Configuration, type RunResult, type ToolCompletion } from './execution_runtime.js';
import { PythonBridge, BridgeError } from './bridge.js';
import { ContextError } from './context.js';
import { blogSaveGuard } from './blog_evidence.js';
import { checkReading, checkCritic, CRITIC_INSTRUCTIONS, validateReadingContract,
  ReadingValidationError, type ReadingContract, type ReadingValidation } from './reading_validation.js';

const State = Annotation.Root({
  messages: Annotation<ModelMessage[]>(),
  calls: Annotation<any[]>(),
  text: Annotation<string>(),
  evidence: Annotation<any[]>(),
  route: Annotation<'tools' | 'retry' | 'done'>(),
});

export class LangGraphLoop {
  constructor(public readonly bridge: PythonBridge, public readonly config: Configuration,
    private readonly fetcher: typeof fetch = fetch) {}

  async run(messages: ModelMessage[], options: { fixtures?: Record<string, unknown>; limits?: Record<string, number>;
    maxRetries?: number; onNotice?: (notice: string) => void; toolCompletion?: ToolCompletion;
    readingContract?: ReadingContract; readingReview?: 'structural' | 'semantic';
    beforeTool?: (call: { toolName: string; input: any }, runtime: ReturnType<typeof createExecutionRuntime>)
      => Promise<{ code: string; message: string } | null> } = {}): Promise<RunResult> {
    if (options.readingContract) validateReadingContract(options.readingContract);
    if (options.readingContract && options.toolCompletion)
      throw new ReadingValidationError('阅读验收不能与工具收据提前结束同时启用');
    const limits = { max_steps: this.config.max_steps, max_model_requests: this.config.max_model_requests,
      max_tool_calls: this.config.max_tool_calls, max_seconds: this.config.max_seconds, ...options.limits };
    await this.bridge.request('start', { fixtures: options.fixtures, limits });
    const runtime = createExecutionRuntime(this.bridge, this.config, this.fetcher, options);
    const guard = blogSaveGuard(this.bridge, this.config);
    const policy = runtime.policy;
    const sdkSteps: any[] = [];
    let compact = false;
    let answer: string | null = null;
    let error: string | null = null;
    let completionSource: RunResult['completion_source'] = null;
    // This trace is node evidence, not a persistent checkpoint or a crash recovery promise.
    const nodes: string[] = [];
    const validations: ReadingValidation[] = [];
    const repair = (state: typeof State.State, issues: string[]) => ({
      messages: [...state.messages, { role: 'user' as const,
        content: `Harness验收未通过：${JSON.stringify(issues)}。不要直接报告结束。缺证据用search_saved_webpage定位并read_saved_webpage回读；修正答案或格式后重新输出全部问题的JSON。复用成功工具结果，不重启任务。所有修正仍受原预算限制。` }],
      route: 'retry' as const,
    });
    const graph = new StateGraph(State)
      .addNode('prepare_context', async state => {
        nodes.push('prepare_context');
        return { messages: await runtime.prepareContext(state.messages) };
      })
      .addNode('model', async state => {
        nodes.push('model');
        const input = compact ? [...state.messages, { role: 'system' as const, content: this.config.compact_retry_prompt }]
          : state.messages;
        const result = await generateText({ model: runtime.provider(this.config.model), system: runtime.instructions,
          messages: input, tools: runtime.tools, toolOrder: this.config.tools.map(t=>t.name),
          maxOutputTokens: this.config.max_output_tokens, maxRetries: options.maxRetries ?? 0,
          temperature: this.config.temperature, providerOptions: { deepseek: { thinking: { type: 'disabled' } } },
          allowSystemInMessages: true });
        if (runtime.fatal) throw runtime.fatal;
        sdkSteps.push({ finish_reason: result.finishReason, tool_names: result.toolCalls.map(c=>c.toolName),
          tool_errors: result.toolCalls.filter((c:any)=>c.invalid).length });
        if (result.finishReason === 'length') {
          if (compact) throw new Error('自动精简重试仍达到输出上限，本轮未完成');
          compact = true; runtime.setCompact();
          // Discard the incomplete assistant turn, reusing all successful tool observations.
          return { route: 'retry' as const, calls: [], text: '' };
        }
        // Tool results are exclusively created by the graph's tools node.
        const additions = result.response.messages.filter(m=>m.role==='assistant');
        return { messages: [...state.messages,...additions], calls: result.toolCalls,
          text: result.text, route: result.toolCalls.length ? 'tools' as const : 'done' as const };
      })
      .addNode('tools', async state => {
        nodes.push('tools');
        const outputs: any[] = [];
        for (const call of state.calls) {
          let output;
          if (call.invalid || !this.config.tools.some(t=>t.name===call.toolName)) {
            output = await this.bridge.request('invalid_tool', { name: call.toolName, arguments: call.input, tool_call_id: call.toolCallId });
          } else {
            let rejection;
            try {
              rejection = await guard(call, runtime);
              if (!rejection) rejection = await options.beforeTool?.(call, runtime);
            }
            finally { runtime.setModelKind(compact ? 'vercel_compact_retry' : 'vercel'); }
            output = await this.bridge.request(rejection ? 'reject_tool' : 'call_tool', {
              name: call.toolName, arguments: call.input, tool_call_id: call.toolCallId,
              ...(rejection ? { rejection } : {}),
            });
          }
          outputs.push({ type: 'tool-result', toolCallId: call.toolCallId, toolName: call.toolName,
            output: { type: 'json', value: output } });
          if (options.toolCompletion && call.toolName===options.toolCompletion.toolName
            && options.toolCompletion.accepts(output)) {
            answer = options.toolCompletion.render(output,call.input);
            completionSource = 'verified_tool';
          }
        }
        return { messages: [...state.messages, { role: 'tool' as const, content: outputs }],
          route: answer ? 'done' as const : 'retry' as const };
      })
      .addNode('finish', state => {
        nodes.push('finish');
        if (!answer) {
          if (!state.text?.trim()) throw new Error('模型没有返回完整文本答案');
          answer = state.text; completionSource = 'model';
        }
        if (compact && !options.readingContract) answer = this.config.compact_notice + answer;
        else if (compact) {
          // Structured task output stays JSON; notices travel through the separate notice channel.
          runtime.notices.push(this.config.compact_notice.trim());
          options.onNotice?.(this.config.compact_notice.trim());
        }
        return { messages: [...state.messages.filter(m=>!(m.role==='system' && m.content===this.config.compact_retry_prompt)),
          ...(completionSource==='verified_tool' ? [{role:'assistant' as const,content:answer!}] : [])] };
      })
      .addNode('validate', async state => {
        nodes.push('validate');
        const trace = await this.bridge.request('trace');
        const checked = checkReading(state.text, options.readingContract!, trace.events);
        validations.push(checked.validation);
        if (!checked.validation.passed) return repair(state, checked.validation.issues);
        return { evidence: checked.evidence, route: 'done' as const };
      })
      .addNode('critic', async state => {
        nodes.push('critic');
        runtime.setModelKind('reading_critic');
        let result;
        try {
          result = await generateText({ model: runtime.provider(this.config.model), system: CRITIC_INSTRUCTIONS,
            prompt: JSON.stringify(state.evidence), maxOutputTokens: this.config.max_output_tokens,
            temperature: this.config.temperature, maxRetries: 0,
            providerOptions: { deepseek: { thinking: { type: 'disabled' } } } });
        } finally { runtime.setModelKind(compact ? 'vercel_compact_retry' : 'vercel'); }
        const checked = result.finishReason === 'stop' ? checkCritic(result.text, options.readingContract!)
          : {stage:'semantic' as const,passed:false,issues:['独立核对输出未完成，不能视为通过']};
        validations.push(checked);
        return checked.passed ? { route: 'done' as const } : repair(state, checked.issues);
      })
      .addEdge(START,'prepare_context').addEdge('prepare_context','model')
      .addConditionalEdges('model',s=>s.route==='tools' ? 'tools' : s.route==='retry' ? 'prepare_context'
        : options.readingContract ? 'validate' : 'finish')
      .addConditionalEdges('validate',s=>s.route==='retry' ? 'prepare_context'
        : options.readingReview==='structural' ? 'finish' : 'critic')
      .addConditionalEdges('critic',s=>s.route==='retry' ? 'prepare_context' : 'finish')
      .addConditionalEdges('tools',s=>s.route==='done' ? 'finish' : 'prepare_context')
      .addEdge('finish',END).compile();
    try {
      if (!['legacy','working_memory','artifact_offload'].includes(policy.strategy)
        || ![policy.trigger_tokens,policy.target_tokens,policy.max_input_tokens,policy.summary_output_tokens,policy.keep_recent_tokens]
          .every(v=>Number.isSafeInteger(v) && v>0)
        || policy.target_tokens>=policy.trigger_tokens || policy.trigger_tokens>=policy.max_input_tokens) {
        throw new ContextError('上下文容量配置无效：应满足 target < trigger < max_input');
      }
      const state = await graph.invoke({ messages:[...messages],calls:[],text:'',route:'retry',evidence:[] },
        { recursionLimit: limits.max_steps*6+12 });
      if (answer) {
        const history=[...state.messages];
        if(history.at(-1)?.role==='assistant') history[history.length-1]={role:'assistant',content:answer};
        messages.splice(0,messages.length,...history);
      }
    } catch (failure) {
      const e=(runtime.fatal??failure) as Error & {statusCode?:number};
      error=e instanceof BridgeError || e instanceof ContextError || e instanceof ReadingValidationError ? e.message :
        ['自动精简重试仍达到输出上限，本轮未完成','模型没有返回完整文本答案'].includes(e.message) ? e.message
        : `${e.name}${e.statusCode ? `，HTTP ${e.statusCode}` : ''}`;
      answer=null; completionSource=null;
    }
    const trace=await this.bridge.request('trace');
    return {...trace,answer,error,total_tokens:trace.events.reduce((s:number,e:any)=>s+(e.usage?.total_tokens??0),0),
      sdk_steps:sdkSteps,compact_retry_used:compact,context_compactions:runtime.contextCompactions,
      notices:runtime.notices,context_policy:policy,completion_source:completionSource,
      graph_nodes:nodes,
      ...(options.readingContract ? {reading_validation:validations,
        reading_review:options.readingReview??'semantic'} : {}),
      output_truncated:trace.events.some((e:any)=>e.finish_reason==='length'||e.status==='incomplete') };
  }
}
