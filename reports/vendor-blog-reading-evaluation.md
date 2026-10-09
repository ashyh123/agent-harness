# 官方博客阅读验证（2026-10-08）

目标：验证现有 Demo 能否读取与工具设计、任务验收和 Harness 有关的官方博客，再考虑如何用阅读结果指导优化。

## 方法与边界

- 使用现有 Vercel loop、Python 工具库与 webpage-reader Skill，未修改业务代码或系统提示词。
- 四篇各运行一次，每篇独立上下文，真实 API 请求与真实 read_webpage；不向模型提供参考答案，不重跑筛选成功样本。
- 预先保存问题和复核标准；要求三行表格，每行一个连续原文引文，英文引文合计最多 20 词，注明 URL 与覆盖范围。
- 自动检查核对读取成功、引文逐字匹配和来源 URL；随后由 Coding Agent 对照官方网页及工具实际返回文本复核。此复核不是独立人工评审，也没有另外调用 LLM 评分器。
- 四次单样本不足以估计稳定成功率。正文截断为工具的 10,000 字符上限，并非模型回答 token 上限。

## 输入与结果

| 官方文章 | 与当前项目的关系 | 实际读取 | 自动检查 | 内容复核 |
|---|---|---|---|---|
| [Writing effective tools for agents — with agents](https://www.anthropic.com/engineering/writing-tools-for-agents)（Anthropic，2025-09-11） | 工具接口与返回内容 | 部分正文：10,000 字符，截断 | 通过（3/3 引文匹配） | 部分完成；事实有依据，但完整原则清单没有进入工具结果 |
| [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)（Anthropic，2026-01-09） | 任务结果与验收方式 | 部分正文：10,000 字符，截断且缺少列表 | 未通过（2/3 引文匹配） | 未完成；第一个问题答非所问，后两个问题信息不足 |
| [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)（Anthropic，2025-11-26） | 跨会话状态与完成验证 | 部分正文：10,000 字符，末尾表格截断 | 通过（6/6 引文匹配） | 主要内容通过；输出格式未通过 |
| [Advancing computer use with Ironclad](https://openai.com/index/advancing-computer-use-with-ironclad/)（OpenAI，2026-10-06） | 真实工作流、细分标准及结论限定 | 失败：HTTP 403 | 未通过（无正文、无原文引文） | 阅读任务未完成；失败处理合理 |

## 每篇的验证记录

### Anthropic：Writing effective tools for agents — with agents

正确说明 Agent 的非确定性、原型与评估迭代、工具数量及无关上下文问题。三段引文共 20 词，符合输出要求。官方网页开头已有原则列表，但工具结果只保留引导句，列表项目缺失；后半部分又被截断。因此不能据这次输出学习完整工具设计原则。

本次模型请求 2 次，工具调用 1 次，总 tokens 5240。

[Agent 实际答案](</Users/ashyh666/Documents/ChatGPT/hugging face + 最小agent demo/reports/harness/webpage-reader-BYNfH0/answer.md>) · [完整运行记录](</Users/ashyh666/Documents/ChatGPT/hugging face + 最小agent demo/reports/harness/webpage-reader-BYNfH0/run.json>)

### Anthropic：Demystifying evals for AI agents

官方页面给出 transcript/outcome 定义，但定义列表未进入工具文本。模型用“评分对象涉及二者”代替定义，没有回答两者区别。代码评分表保留，模型评分表只有表头、人工评分只有标题；研究型 Agent 专节位于截断之后。模型如实指出部分缺失，但把工具元数据 truncated: true 放入原文证据列，自动检查正确拒绝。当前文本仍明确列出三类评分器，答案概括也不充分。

本次模型请求 2 次，工具调用 1 次，总 tokens 5385。

[Agent 实际答案](</Users/ashyh666/Documents/ChatGPT/hugging face + 最小agent demo/reports/harness/webpage-reader-vXWo81/answer.md>) · [完整运行记录](</Users/ashyh666/Documents/ChatGPT/hugging face + 最小agent demo/reports/harness/webpage-reader-vXWo81/run.json>)

### Anthropic：Effective harnesses for long-running agents

回答覆盖压缩不足、初始化/后续编码分工、功能清单、逐项推进、Git/日志交接及浏览器端到端测试，且限定跨上下文长编码任务，符合官方正文。明确报告截断与覆盖未验证。不过任务要求每行一段引文、合计最多 20 个英文词，实际六段、32 词；自动检查没有检测数量和字数，所以自动通过不等于完全验收。

本次模型请求 2 次，工具调用 1 次，总 tokens 5483。

[Agent 实际答案](</Users/ashyh666/Documents/ChatGPT/hugging face + 最小agent demo/reports/harness/webpage-reader-OrzlhO/answer.md>) · [完整运行记录](</Users/ashyh666/Documents/ChatGPT/hugging face + 最小agent demo/reports/harness/webpage-reader-OrzlhO/run.json>)

### OpenAI：Advancing computer use with Ironclad

只调用一次目标 URL，遇到 403 后明确无法读取，没有调用已有知识伪造原文。来源地址在答案中出现，但自动检查要求工具成功返回的来源 URL，因此该项仍未通过。其他历史运行曾读取到此页，本次结果只能说明当前访问受阻，不能断言这个网站永远不可读取。

本次模型请求 2 次，工具调用 1 次，总 tokens 3146。

[Agent 实际答案](</Users/ashyh666/Documents/ChatGPT/hugging face + 最小agent demo/reports/harness/webpage-reader-AIWBXY/answer.md>) · [完整运行记录](</Users/ashyh666/Documents/ChatGPT/hugging face + 最小agent demo/reports/harness/webpage-reader-AIWBXY/run.json>)

## 从本次失败得到的优化方向

1. 先修复提取质量。官方页面的列表、表格单元格在截断前也可能缺失；保留网页关键结构比单纯加长返回文本更重要。应把本次两篇 Anthropic 页面变成提取回归样本，检查定义、原则列表和评分表关键单元格是否保留。
2. 再解决长文章覆盖。提供分段读取或按章节继续读取，保留是否还有未读内容的明确标记。不能把开头 10,000 字符总结包装成整篇总结。
3. 区分证据与状态。正文不可得时，证据列应说明无可用原文；截断等工具元数据不应伪装成文章引文。
4. 补充任务级验收。现有逐字检查无法判断是否回答问题、是否覆盖关键事实，也没有检查引文段数/字数。Harness 案例说明引文全匹配仍能违反明确的任务格式。
5. 保留访问失败样本。403 是网络/访问层问题，不是模型不懂文章；当前如实拒绝是合理行为，后续可评估合法可用的另一种读取方式。

建议下一步优先处理列表/表格提取与分段读取，再复跑这些固定问题。当前证据没有支持先加 RAG 或扩大工具数量。此轮只验证读取，没有验证跨篇综合建议或优化方案的质量。

## 可复用材料

- [网址、问题与预先设定的复核标准](</Users/ashyh666/Documents/ChatGPT/hugging face + 最小agent demo/reports/vendor-blog-reading-cases.json>)
- [运行索引与自动检查结果](</Users/ashyh666/Documents/ChatGPT/hugging face + 最小agent demo/reports/vendor-blog-reading-runs.json>)
- 原始正文、模型答案和事件在每次 Harness 的 run.json 中；reports/harness 为 Git 忽略的本地运行产物，克隆仓库不会携带这些文件。

本次合计：8 次模型请求、4 次工具调用、19,254 tokens。
