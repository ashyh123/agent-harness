/** 验证入口：随机选文章并调用现有 Harness/Skill，不实现另一套阅读流水线。 */
import assert from 'node:assert/strict';
import { createHash, randomInt } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MinimalHarness } from './harness.js';
import type { Configuration } from './execution_runtime.js';
import { PythonBridge, ROOT, loadLocalEnv, redact } from './bridge.js';

const candidates = [
  { vendor: 'Anthropic', urls: ['https://www.anthropic.com/engineering/building-effective-agents',
    'https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents'] },
  { vendor: 'OpenAI', urls: ['https://openai.com/index/harness-engineering/',
    'https://openai.com/index/the-next-evolution-of-the-agents-sdk/'] },
  { vendor: 'Google', urls: ['https://blog.google/innovation-and-ai/technology/developers-tools/managed-agents-gemini-api/',
    'https://blog.google/innovation-and-ai/technology/developers-tools/expanding-managed-agents-gemini-api/'] },
];

async function main() {
  loadLocalEnv();
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('请配置项目 .env');
  const seedArg = process.argv[2];
  const seed = seedArg === undefined ? randomInt(0, 2 ** 31) : Number(seedArg);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed >= 2 ** 31) throw new Error('seed 应为 0–2147483647 整数');
  let state = seed;
  const selected = candidates.map(group => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return { vendor: group.vendor, url: group.urls[state >>> 31] };
  });
  const root = join(ROOT, 'reports/obsidian-runs');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'blogs-'));
  const bridge = new PythonBridge();
  const results: any[] = [];
  const save = () => writeFile(join(directory, 'verification.json'), redact(JSON.stringify({ seed, candidates, selected, results }, null, 2)) + '\n');
  await save();
  try {
    const config = await bridge.request<Configuration>('describe');
    const harness = new MinimalHarness(bridge, config);
    for (const article of selected) {
      console.log(`验证 ${article.vendor}：${article.url}`);
      // 模拟外部采集端：先真实抓取并保存阅读文件，再把文件 ID 交给 Skill 分析。
      // 此调用不使用模型；原始抓取结果存档，不能用伪造的 fixture 替代真实正文。
      const captured = await bridge.request<any>('capture_tool', { name: 'read_webpage', arguments: { url: article.url } });
      await writeFile(join(directory, `${article.vendor}-capture.json`), redact(JSON.stringify(captured, null, 2)) + '\n');
      if (!captured.document_id || captured.error) {
        results.push({ ...article, runtime_status: 'capture_failed', error: captured.error, file_checks: [] });
        await save();
        continue;
      }
      const { record, directory: runDirectory } = await harness.run({ skill: 'obsidian-blog-reader',
        task: `外部采集端已生成阅读文件，document_id=${captured.document_id}。读取 text 格式前 4000 字符，仅基于这一范围简化核心内容，给出一个最小 Agent 优化启发和短原文证据，实际存入 Obsidian。不要分页通读，也不要重新下载；不足以判断的后文明确未覆盖。` },
        { onNotice: notice => console.log(redact(notice)) });
      const saves = record.result?.events.filter(event => event.name === 'save_obsidian_blog' && event.result?.verified === true) ?? [];
      const fileChecks = [];
      for (const event of saves) {
        const result = event.result;
        const bytes = await readFile(result.note_path);
        const original = await readFile(result.original_path, 'utf8');
        fileChecks.push({ note_path: result.note_path, original_path: result.original_path,
          source_url: result.source_url, summary_chars: result.summary_chars, source_chars: result.source_chars,
          hash_matches: createHash('sha256').update(bytes).digest('hex') === result.sha256,
          summary_present: bytes.toString().includes(event.arguments.summary),
          source_present: bytes.toString().includes(result.source_url) && original.includes(result.source_url),
          evidence_present: bytes.toString().includes(event.arguments.evidence_quote),
          document_matches_capture: result.document_id === captured.document_id && result.source_url === captured.url,
          simplified: result.summary_chars < result.source_chars });
      }
      results.push({ ...article, run_directory: runDirectory, runtime_status: record.runtime_status,
        captured_document_id: captured.document_id, captured_chars: captured.total_chars,
        task_verdict: record.task_verdict, automatic_checks: record.automatic_checks, error: record.result?.error,
        model_requests: record.result?.model_requests, tool_calls: record.result?.tool_calls,
        total_tokens: record.result?.total_tokens, file_checks: fileChecks });
      await save();
      console.log(redact(record.result?.answer ?? `未完成：${record.result?.error}`));
    }
    console.log(`验证记录：${directory}`);
    assert.equal(results.length, 3);
    for (const result of results) {
      assert.equal(result.runtime_status, 'completed', `${result.vendor} 未完成，已保存错误记录`);
      assert.equal(result.automatic_checks?.passed, true, `${result.vendor} 自动检查失败`);
      assert.ok(result.file_checks.length > 0, `${result.vendor} 没有实际保存文件`);
      assert.ok(result.file_checks.every((item: any) => item.hash_matches && item.summary_present && item.source_present
        && item.evidence_present && item.document_matches_capture && item.simplified), `${result.vendor} 文件核验失败`);
    }
    console.log('三篇实际文件与简化长度核验通过；语义准确性仍需人工核对。');
  } finally { bridge.close(); }
}
main().catch(error => {
  console.error(redact(`Obsidian 验证未通过：${error instanceof Error ? error.message : 'UnknownError'}`));
  process.exitCode = 1;
});
