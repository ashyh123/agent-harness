# OpenAI 博客阅读：第一版样例与实跑

核对日期：2026-10-08（Asia/Shanghai）。从 [OpenAI 新闻目录](https://openai.com/news/) 和 [研究目录](https://openai.com/news/research/) 选取近期、适合模型与 Agent 阅读任务的五篇文章；不是全部新闻按时间排序的前五篇。正文链接均已打开核对。

## 候选文章

| 日期 | 文章 | 适合检查什么 |
| --- | --- | --- |
| 2026-10-07 | [GPT-6 and Intelligent UI for everyone](https://openai.com/index/gpt-6-for-everyone/) | 区分功能、可用范围、逐步开放和未来计划 |
| 2026-10-06 | [Advancing computer use with Ironclad](https://openai.com/index/advancing-computer-use-with-ironclad/) | 研究评测结果、比较条件、脚注限定 |
| 2026-10-06 | [Sharing AI progress in mathematics](https://openai.com/index/sharing-ai-progress-in-mathematics/) | 区分研究结果公开与模型公开；识别外链资料依赖 |
| 2026-10-02 | [A model guide for the GPT-6 family](https://openai.com/index/practical-guide-building-gpt-6/) | 长文中的模型选择、流程和工程建议 |
| 2026-09-29 | [Introducing GPT-6.1 Sol](https://openai.com/index/introducing-gpt-6-1-sol/) | 区分模型定价、任务成本、评测指标与适用范围 |

最后一篇的发布日期由官方目录核对；指南在目录中的标题是 A practical guide to building with GPT-6，正文标题如表中所示。

## 第一版产出流程

```text
用户提供一个 URL 和问题
  → Harness 显式加载 webpage-reader
  → 模型调用 read_webpage
  → 工具下载并提取正文
  → 模型输出四项事实表及来源
  → Harness 保存 answer.md 和 run.json
  → 对照原文及脚注人工验收
```

固定问题：发布了什么、面向哪些任务、报告了什么效果及评测条件、有哪些限制和不可推出的结论。厂商自述需要标明归属，原文没有说明的内容不能自行补齐。

本轮复用原 Skill 和工具，没有新增博客专用工具或改变预算。正文证据要求连续短引文，全部英文直接引文合计最多 20 词。

## Ironclad 首次实跑

使用真实 DeepSeek 模型和真实网页读取。调用 1 次 read_webpage、3 次模型请求，共 7322 tokens；首次最终输出触及长度上限，随后复用网页结果自动精简。

- [实际答案](harness/webpage-reader-eMm9mN/answer.md)
- [完整运行记录](harness/webpage-reader-eMm9mN/run.json)

这些原始记录位于本地 Git 忽略目录；其他检出不一定具有上述文件。

运行正常结束，Harness 标记 `completed / needs_review`。人工验收结论：**尚未通过完整阅读与证据要求**。

| 检查项 | 观察 |
| --- | --- |
| 实际读取指定网页 | 通过，读取一次，并未用搜索摘要替代 |
| 回答四项问题 | 已生成对应四行，主要内容可用 |
| 区分研究与产品、标明厂商报告 | 已做基本区分 |
| 评测限定 | 遗漏了耗时为模拟估计这一重要限定 |
| 资料完整性 | 工具返回中没有脚注；答案却因 truncated=false 声称读取完整 |
| 逐字引文 | 第一条引文将原文句首 Our 改为 our，不满足严格逐字匹配 |

官方页面脚注说明：评测仅覆盖 11 个研究任务；耗时是模拟估计，不是测得的客户节省时间。文章还给出了训练/评测资料来源的限制。脚注没有出现在本次工具返回中；正文自身也出现了“模拟时间”的限定，但最终回答仍遗漏了它。[来源](https://openai.com/index/advancing-computer-use-with-ironclad/)

## 这次失败定位到哪里

`tool_library/network.py` 先用 Trafilatura 提取内容，再执行 `content[:MAX_WEB_CHARS]`。`truncated` 只比较提取后文本与 10000 字符上限，不能证明网页所有重要内容均被提取。

因此这里同时存在两个问题：输入资料缺少脚注，以及模型对正文已有的限定和完整性标记理解不准确。本次没有检查原始 HTML 与提取器之间的具体丢失位置，不能进一步断言脚注缺失的底层原因。

下一项有证据支持的改进是：让读取结果保留重要补充内容、明确提取完整性的不确定性，并验收结论有没有保留评测限定。当前报告保存失败基线，供修复后对照。
