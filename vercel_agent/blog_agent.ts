import { MinimalHarness } from './harness.js';
import type { Configuration } from './execution_runtime.js';
import { PythonBridge } from './bridge.js';

export const BLOG_TOOLS = new Set(['read_webpage', 'read_saved_webpage', 'search_saved_webpage', 'save_obsidian_blog']);

/** Dedicated single-article agent; the shared LangGraph owns every model/tool turn. */
export class BlogAgent {
  private harness: MinimalHarness;
  constructor(bridge: PythonBridge, config: Configuration,
    paths?: ConstructorParameters<typeof MinimalHarness>[2], fetcher: typeof fetch = fetch) {
    const tools = config.tools.filter(tool => BLOG_TOOLS.has(tool.name));
    for (const name of BLOG_TOOLS) if (!tools.some(tool => tool.name === name))
      throw new Error(`博客 Agent 缺少工具：${name}`);
    this.harness = new MinimalHarness(bridge, { ...config, tools }, paths, fetcher);
  }

  async run(url: string, onNotice?: (notice: string) => void,
    options: { fixtures?: Record<string, unknown> } = {}) {
    const source = new URL(url);
    if (!['http:', 'https:'].includes(source.protocol) || source.username || source.password)
      throw new Error('请提供一个不含账号密码的 HTTP(S) 博客地址');
    const result = await this.harness.run({ skill: 'obsidian-blog-reader',
      task: `读取这篇博客，简化核心内容、提炼一个 Agent 改进启发，并实际保存到 Obsidian。来源：${source.href}` }, { onNotice, ...options });
    const receipt = [...(result.record.result?.events ?? [])].reverse().find(event => event.type === 'tool'
      && event.name === 'save_obsidian_blog' && event.result?.verified === true)?.result ?? null;
    const saved = result.record.runtime_status === 'completed'
      && result.record.automatic_checks?.passed === true
      && result.record.result?.completion_source === 'verified_tool' && !!receipt;
    return { ...result, saved, receipt };
  }
}
