# 正文与 Markdown 同时使用：实现和验证（2026-10-08）

HTML 网页使用召回优先的提取方式，同一次提取生成 Markdown 和 text，保存为同一份文档快照。模型默认读 Markdown；核对跨加粗或链接的措辞时，可以按同一个 document_id 回读 text。程序转换，不让模型改写原文。

## 实现

- [提取与转换](</Users/ashyh666/Documents/ChatGPT/hugging face + 最小agent demo/tool_library/network.py>)：`extract_article()` 调用 `bare_extraction(favor_recall=True)`，得到一棵结构树；`xmltotxt` 从同一棵树生成两个视图。使用项目锁定的 Trafilatura 2.3.0 转换器。文本副本解开链接节点，保留链接文字；Markdown 保留链接目标和加粗。
- [快照与回查](</Users/ashyh666/Documents/ChatGPT/hugging face + 最小agent demo/tool_library/webpage_store.py>)：新版快照 v2 保存两种格式；旧版 v1 快照仍可以读取 text。回读默认返回快照默认格式，可选择 content_format。不同格式的 offset 和 next_offset 分别计算，返回 available_formats 中的各格式长度。
- [工具注册](</Users/ashyh666/Documents/ChatGPT/hugging face + 最小agent demo/tools.py>)：同一个 read_saved_webpage 增加可选 content_format；没有新增 Loop 分支。
- [网页 Skill](</Users/ashyh666/Documents/ChatGPT/hugging face + 最小agent demo/skills/webpage-reader/SKILL.md>)：阅读 Markdown、需要时回查 text；切换格式重新定位。自动验收不放宽引文匹配，也不把未读快照内容当作证据。

格式与提取完整性分别处理。Markdown 有结构，不意味着所有内容已提取；text 也仍保留列表和表格组织。两个视图均为提取结果，不是原始 HTML。完整性仍标记 not_verified。

## 真实网页对比

同一份 HTML 分别跑旧提取参数与新实现，检查此前遗漏的具体内容；没有调用模型改写。对比完整提取结果，避免把前 10,000 字符截断误算成提取遗漏。

| 样本 | 旧配置找到的指定内容 | 新实现 text 找到的指定内容 | Markdown 字符 | text 字符 |
|---|---|---|---|---|
| tools | 1/3 | 3/3 | 21,575 | 20,301 |
| evals | 0/3 | 3/3 | 40,194 | 38,429 |

- [工具设计文章](https://www.anthropic.com/engineering/writing-tools-for-agents)：工具选择原则、命名原则、token 效率原则。
- [评估文章](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)：outcome 定义、trial 定义、模型评分表中的人工校准要求。

六处指定内容从 1/6 到 6/6，只证明这些具体遗漏得到了修复，不代表整页或任意网站完整读取。召回优先的结果更长，也可能混入冗余内容。可回读全部快照，首次预览仍最多 10,000 字符。

## 一次真实 Agent 运行

问题：区分 transcript 和 outcome，并核对 outcome 定义的原文。

实际顺序为 read_webpage 返回 Markdown → read_saved_webpage 选择 text → 模型回答。答案正确区分完整运行记录与环境中的最终状态，并用实际预订是否存在解释两者差别。引文自动检查 2/2 通过；runtime_status=completed，task_verdict=needs_review。

使用 3 次模型请求、2 次工具调用、12,030 tokens。只有一次运行，没有重跑筛选输出。

输出仍不够简短：模型给出了两段长引文，超出任务要求的一段原文证据。当前自动检查不检查篇幅或引文数量，因此不能把引文匹配通过等同于输出要求全通过。

[实际答案](</Users/ashyh666/Documents/ChatGPT/hugging face + 最小agent demo/reports/harness/webpage-reader-AJ1gox/answer.md>) · [完整运行记录](</Users/ashyh666/Documents/ChatGPT/hugging face + 最小agent demo/reports/harness/webpage-reader-AJ1gox/run.json>) · [对比与运行索引](</Users/ashyh666/Documents/ChatGPT/hugging face + 最小agent demo/reports/webpage-format-validation.json>)

## 程序验证

- Python：43 项测试通过。新增测试覆盖真实提取器保留标题、列表、嵌套表格内容、加粗、链接；两个格式来自同一快照且分别切片，另一份全文不进入有界结果；旧快照兼容与非法格式拒绝。
- SDK/Harness：29 项测试通过。新增引文测试确认 Markdown 中跨格式标记的引文不会直接通过，实际回读 text 后可以通过，改写仍拒绝。
- TypeScript 类型检查通过。

当前边界：没有浏览器渲染、HTTP 403 替代读取、自动压缩、全文完整性证明。下一步继续用固定内容检查提取质量，并从真实任务失败中补充验收条件。

实现依据：[Trafilatura 官方说明](https://trafilatura.readthedocs.io/en/latest/usage-python.html)。官方提供召回优先、结构化提取与 Markdown 输出；本项目通过同一次提取生成两种视图，减少分别提取造成的内容差异。
