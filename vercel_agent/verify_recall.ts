/** 真实网页 + 真实模型；人为移除旧上下文验证回查，不声称实现自动 compaction。 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MinimalHarness } from './harness.js';
import type { Configuration } from './agent.js';
import { PythonBridge, ROOT, loadLocalEnv, redact } from './bridge.js';

async function main() {
  loadLocalEnv();
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('请先在项目 .env 填入 DEEPSEEK_API_KEY');
  const url = 'https://www.anthropic.com/engineering/managed-agents';
  const seed = new PythonBridge();
  let page: any;
  try {
    page = await seed.request('capture_tool', { name: 'read_webpage', arguments: { url } });
    assert.ok(page.document_id, '网页读取失败，未生成快照；本次验证无法继续');
  } finally { seed.close(); }
  const store = process.env.MINIMAL_AGENT_WEBPAGE_STORE_DIR ?? join(ROOT, 'reports/webpage-snapshots');
  // 验证程序定位测试段落；只将位置交给模型，不将正文或参考答案交给模型。
  const saved = JSON.parse(await readFile(join(store, `${page.document_id}.json`), 'utf8'));
  const marker = saved.content.indexOf('time-to-first-token');
  assert.ok(marker >= 0, '提取文本缺少预设验证段落；不能用模型知识代替原文');
  const offset = Math.max(0, marker - 1200);
  const cases = [
    { id: 'recall', task: `工作记录已人为精简，原来的网页工具结果不在当前上下文中。只保留：标题 ${page.title}；document_id ${page.document_id}；相关段落从字符位置 ${offset} 起。请回查保存的原文，回答三个问题：什么架构调整减少了启动等待？p50 与 p95 的首 token 延迟降低多少？这些指标表示首次响应延迟还是任务完成率？用三行简短事实表，每行一个不超过五个英文词的连续原文引文，保留近似限定并给来源 URL。` },
    { id: 'missing', task: `工作记录只保留 document_id ${'0'.repeat(64)}；原文已经不在当前上下文中。请回查该快照，说明报告中的时间究竟是模拟估计还是实测；没有原文就明确说明无法判断，不猜测文档 ID 或用已有知识补齐。` },
  ];
  const results = [];
  for (const input of cases) {
    const bridge = new PythonBridge();
    try {
      const config = await bridge.request<Configuration>('describe');
      const run = await new MinimalHarness(bridge, config).run({ skill: 'webpage-reader', task: input.task });
      const record = run.record;
      const toolEvents = record.result?.events.filter(event => event.type === 'tool') ?? [];
      const recalled = toolEvents.filter(event => event.name === 'read_saved_webpage');
      const featureCheckPassed = record.runtime_status === 'completed' && toolEvents.length === 1
        && recalled.length === 1 && (input.id === 'recall'
          ? recalled[0].result.document_id === page.document_id && record.automatic_checks?.passed === true
          : recalled[0].result.error?.code === 'snapshot_not_found' && record.task_verdict === 'failed_checks');
      // 这里只保存索引及检查；原始工具文本已在独立 run.json 中，不重复复制。
      results.push({ id: input.id, directory: run.directory, input: record.input,
        runtime_status: record.runtime_status, task_verdict: record.task_verdict,
        model_requests: record.result?.model_requests, tool_calls: record.result?.tool_calls,
        total_tokens: record.result?.total_tokens, automatic_checks: record.automatic_checks,
        feature_check_passed: featureCheckPassed,
      });
      await writeFile(join(ROOT, 'reports/webpage-recall-validation.json'), redact(JSON.stringify({
        method: '真实网页和模型；关闭原工具进程，新建上下文。人为精简工作记录，不是自动压缩或会话恢复。',
        source: { url, title: page.title, document_id: page.document_id, total_chars: page.total_chars,
                  initial_preview_truncated: page.truncated, saved_range_offset: offset },
        results,
      }, null, 2)) + '\n');
      console.log(`${input.id}：${run.record.runtime_status} / ${run.record.task_verdict}；结果目录：${run.directory}`);
      console.log(redact(run.record.result?.answer ?? run.record.result?.error ?? '未返回答案'));
      assert.ok(featureCheckPassed, `${input.id} 未通过回查功能检查；记录已保存，仍需检查答案语义`);
    } finally { bridge.close(); }
  }
}

main().catch(error => {
  console.error(redact(`回查验证未完成：${error instanceof Error ? error.message : 'UnknownError'}`));
  process.exitCode = 1;
});
