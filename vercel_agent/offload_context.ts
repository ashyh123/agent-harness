import type { ModelMessage } from 'ai';
import { estimateInput, type ContextPolicy } from './context.js';

/** 借鉴OMP shake的本地替换；复用已存在的网页快照，不增加工具或摘要请求。 */
export function offloadContext(messages: ModelMessage[], policy: ContextPolicy,
  instructions: string, tools: unknown, reserve: number) {
  const reduced = structuredClone(messages);
  const before = estimateInput(messages, instructions, tools, reserve);
  const replaced: { call_id: string; document_id: string; original_chars: number; preview_chars: number }[] = [];
  // 最新助手发出的整批工具结果尚未被下一次模型请求观察，必须完整保留。
  // 即使该批次超过keep_recent_tokens也不先删正文；越过硬容量时交给恢复层。
  let newestAssistant = reduced.length - 1;
  while (newestAssistant >= 0 && reduced[newestAssistant].role !== 'assistant') newestAssistant--;
  const latest = reduced[newestAssistant];
  const protectedFrom = latest?.role === 'assistant' && Array.isArray(latest.content)
    && latest.content.some(part => part.type === 'tool-call') ? newestAssistant : reduced.length;
  // 从旧到新处理；小结果、失败结果、图像、用户指令和助手决定都不改动。
  for (const message of reduced.slice(0, protectedFrom)) {
    if (estimateInput(reduced, instructions, tools, reserve) <= policy.target_tokens) break;
    if (message.role !== 'tool') continue;
    for (const part of message.content) {
      if (estimateInput(reduced, instructions, tools, reserve) <= policy.target_tokens) break;
      if (part.type !== 'tool-result' || !['read_webpage', 'read_saved_webpage'].includes(part.toolName)) continue;
      const output = part.output;
      if (output.type !== 'json' && output.type !== 'text') continue;
      let value: any;
      try { value = output.type === 'text' ? JSON.parse(output.value) : output.value; } catch { continue; }
      if (value?.error || typeof value?.content !== 'string'
          || !/^[0-9a-f]{64}$/.test(value.document_id ?? '')
          || !['text', 'markdown'].includes(value.content_format)) continue;
      const points = Array.from(value.content) as string[];
      if (!points.length || points.length <= 1500 && !value.content_offloaded) continue;
      // 给近期证据留下原文头尾；容量不足时再缩小预览。索引按返回内容码点计数。
      let candidate: any;
      for (const cap of [1500, 600, 0].filter(cap => cap < points.length)) {
        const head = Math.floor(cap * 0.6), tail = cap - head;
        candidate = { ...value, content: head || tail
          ? points.slice(0, head).join('') + '\n[中间内容已移出上下文，须回查后才能引用]\n' + points.slice(-tail).join('') : '',
          truncated: true, source_result_truncated: value.source_result_truncated ?? value.truncated, content_offloaded: true,
          preview_ranges: cap && !value.content_offloaded ? [[0, head], [points.length - tail, points.length]] : [],
          preview_scope: value.content_offloaded ? '预览再次缩减，不能据此推断原文覆盖范围；精确引用须回查。' : '区间仅指原工具返回内容；网页预览可能拼接脚注，不能当作快照连续范围。',
          recall: { tool: 'read_saved_webpage', arguments: { document_id: value.document_id,
            content_format: value.content_format, offset: part.toolName === 'read_saved_webpage' ? value.offset : 0,
            limit: 1500 } },
          recall_note: '完整提取文本在已有快照；只回查任务所缺的短范围。原end_offset/next_offset不是本预览的覆盖范围。原网页完整性未验证。' };
        part.output = output.type === 'text' ? { ...output, value: JSON.stringify(candidate) }
          : { ...output, value: candidate };
        if (estimateInput(reduced, instructions, tools, reserve) <= policy.target_tokens) break;
      }
      replaced.push({ call_id: part.toolCallId, document_id: value.document_id,
        original_chars: points.length, preview_chars: Array.from(candidate.content).length });
    }
  }
  const after = estimateInput(reduced, instructions, tools, reserve);
  // target是维护目标，max_input才是本地硬边界；不能把目标未达误报为容量超限。
  // 无收益不提交替换；由调用方决定续跑或进入下一种维护方式，避免反复空转。
  const progressed = after < before;
  const accepted = progressed ? reduced : messages;
  const acceptedSize = progressed ? after : before;
  return { messages: accepted, before, after: acceptedSize, replaced: progressed ? replaced : [],
    target_met: acceptedSize <= policy.target_tokens, requires_fallback: acceptedSize > policy.max_input_tokens };
}
