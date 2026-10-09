/** 真实网页和真实模型验证自动上下文压缩；独立存档，不覆盖交互入口的记录。 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelMessage } from 'ai';
import { VercelLoop, type Configuration } from './agent.js';
import { PythonBridge, ROOT, loadLocalEnv, redact } from './bridge.js';

async function main() {
  loadLocalEnv();
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('请先配置项目 .env');
  const root = join(ROOT, 'reports/context-compaction-runs');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'context-'));
  const prompt = process.argv.slice(2).join(' ').trim() ||
    '请读取 https://www.anthropic.com/engineering/managed-agents 和 https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents 两篇博客正文。每篇用两句话说明对最小 Agent 的借鉴，附实际来源，并如实说明正文覆盖范围。不要只根据搜索摘要声称读过全文。';
  const bridge = new PythonBridge();
  try {
    const configuration = await bridge.request<Configuration>('describe');
    const messages: ModelMessage[] = [{ role: 'user', content: prompt }];
    const result = await new VercelLoop(bridge, configuration).run(messages, {
      onNotice: notice => console.log(redact(notice)),
    });
    await writeFile(join(directory, 'run.json'), redact(JSON.stringify({ prompt, configuration,
      ...result, committed_messages: messages }, null, 2)) + '\n');
    await writeFile(join(directory, 'answer.md'), redact(result.answer ?? `未完成：${result.error}`) + '\n');
    console.log(redact(result.answer ?? result.error ?? '没有答案'));
    console.log(`记录：${directory}`);
    console.log(JSON.stringify({ model_requests: result.model_requests, tool_calls: result.tool_calls,
      total_tokens: result.total_tokens, context_compactions: result.context_compactions }, null, 2));
    assert.equal(result.error, null, '运行失败；原始记录已保留');
    assert.ok(result.context_compactions.length > 0, '本次资料量没有触发自动压缩');
    const summaryEvents = result.events.filter(event => event.kind === 'vercel_context_compaction');
    assert.equal(summaryEvents.length, result.context_compactions.length);
    assert.ok(result.model_requests <= configuration.max_model_requests);
    assert.ok(result.outer_requests <= configuration.max_steps);
    assert.ok(messages.some(message => typeof message.content === 'string' && message.content.includes('minimal_agent_context_v1')));
    const reads = result.events.filter(event => event.type === 'tool' && event.name === 'read_webpage' && !event.result?.error);
    assert.ok(reads.length > 0, '没有成功读取实际网页');
    assert.equal(new Set(reads.map(event => event.arguments.url)).size, reads.length, '压缩后重复下载同一网页');
    console.log('自动压缩与预算计数通过；摘要和最终结论仍需人工核对。');
  } finally { bridge.close(); }
}
main().catch(error => {
  console.error(redact(`上下文验证未通过：${error instanceof Error ? error.message : 'UnknownError'}`));
  process.exitCode = 1;
});
