# 搜索可靠性修复与验证

日期：2026-10-08。当前已进一步改用 Tavily 官方 SDK 的 keyless 模式优先搜索；下文第一轮 Yahoo 方案及失败证据保留，最新修复见末尾。此前网页快照与 Markdown 改动仍保留在工作区。

## 原因与选择

直接调用原搜索路径复现 `DDGSException: No results found`。观察同一 DDGS 请求得到 HTTP 202，响应包含 DuckDuckGo 人机验证页面。DDGS 把没有可提取结果的服务响应包装为通用异常，原工具又包装为 `execution_error`，模型随后重复搜索耗尽工具预算。

使用当前固定的 `ddgs==9.16.0`，实测 Brave、Google、Mojeek 的所选查询失败；Yahoo 返回 Anthropic 与 OpenAI 官方地址。因此使用已有 Yahoo backend，不安装依赖、不使用付费 API 或搜索密钥。参考：[DDGS 官方仓库](https://github.com/deedy5/ddgs)。这些是本机少量即时样本，不能推断所有用户、网络和查询的长期可用率。

## 改动

- `tool_library/network.py`：DuckDuckGo → Yahoo，每个引擎最多一次，每次最多 5 秒并按剩余时间缩短；返回实际 provider 和安全的 attempts。过滤非 HTTP(S)、含账号密码及 Bing 广告跳转地址。DDGS 异常不当作正常零结果。
- `runtime.py`：每轮保存失败引擎，在本轮剩余调用中跳过；新一轮重新尝试。停止重复 HTTP 请求，不绕过工具调用计数。
- `tools.py`：工具描述说明备用来源、摘要不等于正文，以及 `search_unavailable` 后停止重复搜索。
- 全部不可用时返回安全的 `search_unavailable`、`retryable=false`；不回传原始异常文字。它是可告知模型的业务失败，预算异常仍向应用层传递。
- `tests/test_search_reliability.py`：7 个离线回归场景，包括故障切换、同轮跳过、新轮恢复、全失败与脱敏、正常空结果、时间预算及无效/广告 URL。
- `vercel_agent/verify_search.ts`：真实搜索和模型验证；确保至少成功读取两篇不同页面，阅读输入 URL 来自本轮搜索，答案引用实际来源。记录独立保存，不覆盖 `vercel-last-run.json`。

一次 `web_search` 仍是一项工具调用，内部最多两次引擎请求；attempts 展示实际尝试。已有 8 次工具调用、5 次外层模型请求和 90 秒步骤启动预算保持生效。DDGS 自己的等待和进行中请求不构成严格的整体墙钟超时。

## 验证

离线：50 项 Python 测试、29 项 SDK/Harness 测试、TypeScript 类型检查和 `git diff --check` 通过。

直接工具验证：第一项 Anthropic 查询由 DuckDuckGo 失败切换 Yahoo 成功；随后 OpenAI 查询跳过 DuckDuckGo，由 Yahoo 成功。结果标明来源。

真实模型执行保存了两次试验，没有删去失败记录：

| 记录目录 | 模型请求 | 工具调用 | tokens | 结果 |
| --- | --- | --- | --- | --- |
| `reports/search-reliability-runs/search-Ri2KU8` | 3 | 4 | 10507 | 搜索和两个网页读取成功，但第二个 URL 是模型猜测的，并非搜索返回；其“访问官网获得”说法没有对应记录。因此不接受它作为完整搜索验收。最初验证器漏掉此条件，随后收紧。 |
| `reports/search-reliability-runs/search-PCnXxi` | 3 | 4 | 11050 | 收紧任务说明和来源验收后，两次搜索都经 Yahoo 成功，两个阅读输入均来自搜索结果，未超预算。 |

第二次读取：

- https://www.anthropic.com/engineering/building-effective-agents
- https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/

人工对照实际工具文本，简述的工作流/Agent 区别、简单可组合模式、模型/工具/指令三组件和优先扩展单 Agent 能力均有文本支持。第二项是官方工程指南，不是严格意义上的博客文章；若要求内容类型必须为博客，还需额外验收，当前来源检查不能自动判别体裁。两页均为有界提取，`truncated=true`、完整性未验证；答案如实说明覆盖限制。答案使用英文，中文任务的语言一致性仍有改进空间。

Yahoo 在第一次模型任务的另一个查询上仍出现过 DDGSException。故本次证明故障切换可用和失败行为有界，未证明永不失败。服务全部失败时应交付明确失败，不能编造资料或猜地址来伪装搜索成功。

复现：在 `vercel_agent` 执行 `npm run verify:search`。会产生 DeepSeek 用量，每次保留独立证据。运行中的 Agent 需要退出并重新执行 `npm run chat`，才能加载更新的 Python 工具和描述。

## 第二轮：Tavily 官方 SDK，免费且无需密钥

用户在第一轮改动后再次执行，最新 CLI 记录显示 DuckDuckGo 与 Yahoo 都失败；第二项搜索被本轮失败状态拦下。2 次模型请求、2 次工具调用、3357 tokens，诚实报告未完成，但搜索能力并未恢复。第一轮单次成功不能作为稳定可用的证明。

扩展检查：Bing RSS 返回 HTTP 200 但包含无关结果，未采用；若干 SearXNG 公共实例返回 429 或聚合引擎访问失败，未作为默认服务。没有把 HTTP 成功等同于搜索有效。

查阅官方资料后找到 Tavily 的免费 keyless 模式，支持 search/extract、无需 API key，有共享速率限制。官方来源：[Tavily Python SDK](https://github.com/tavily-ai/tavily-python#keyless-mode)、[官方 SDK 源码](https://github.com/tavily-ai/tavily-python/blob/master/tavily/tavily.py)。先用公开 HTTP 接口实测两个失败查询，都返回相关官方文章；再安装固定 `tavily-python==0.8.5` 并核对实际源码。

Vercel 的 [工具目录](https://ai-sdk.dev/resources/tools/tavily) 有 `@tavily/ai-sdk` / `tavilySearch`。核对 `npm view @tavily/ai-sdk version peerDependencies dependencies --json`：最新 0.5.0，只声明 `ai: ^5.0.0 || ^6.0.0`，依赖 `@tavily/core: ^0.7.2`。本项目是 AI SDK 7.0.130，所以不强行安装，也不为一个搜索工具降级 Loop。

最终接法：现有 Vercel ToolLoopAgent → 共享 web_search → 官方 Tavily Python SDK。Python 手写 Loop 同样复用。Tavily 主用，失败再尝试 DuckDuckGo、Yahoo，每次工具最多三项服务请求，每项启动前检查剩余时间。SDK 管理服务请求和解析，项目仍负责预算、输出裁切、故障切换和验收。

显式 `TavilyClient(api_key="")` 禁止 SDK 读取环境中的 Tavily key，强制 keyless。固定 basic、include_answer=false、include_raw_content=false，不返回服务生成的 answer；只映射真实搜索字段。keyless 限流异常被安全转换，合法的 retry_after_seconds 留在 attempts；不等待并反复请求。SDK 会给缺失 results 自动补空列表，因此额外核对成功响应 query 字段，降低错误响应被误当成零结果的风险。

增加 4 个使用真实 Tavily SDK、模拟 HTTP 传输的回归测试：无凭据主用及 bounded snippets、限流备用及同轮跳过、无效响应、全部三项服务失败和脱敏。当前全部 54 项 Python、29 项 SDK/Harness 测试、TypeScript 类型检查通过。

直接工具验证采用用户相同的两个查询及 max_results=5，均由 tavily/keyless 返回相关官方来源，不触发 DDGS。

完整模型验证记录：`reports/search-reliability-runs/search-fT5Bbx`。3 次模型请求、4 次工具调用、14719 tokens；两次搜索的 provider 均为 tavily、attempts 均仅一次 ok。两次阅读输入均来自本轮搜索；答案给出了实际来源和简述，流程验收通过。阅读内容仍裁切，语义覆盖与引文正确性不由本脚本自动保证；第二项仍是工程指南，严格博客体裁不在检查范围。保留本次完整答案与来源，未改写模型交付物。

人工补充核对：答案中的 Anthropic 三条原则以及 OpenAI 失败阈值/人工介入，在实际搜索摘要中有对应措辞，但不在本轮裁切后的正文预览中。模型确实读了两篇正文，来源获取流程成立；如果验收要求每个结论都必须在实际阅读的正文范围内验证，还须回查快照相关段落，当前验证器没有执行这项语义验收。

Tavily keyless 有速率限制，免费接入不表示永远可用。达到限制时仍应停止或进入有界备用路径，不能假装任务完成。此实现不使用 Tavily 付费凭据，也没有改变 DeepSeek 模型调用收费。
