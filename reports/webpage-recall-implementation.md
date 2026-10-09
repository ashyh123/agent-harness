# 网页原文回查：实现与验证（2026-10-08）

已实现：在模型上下文之外保存网页提取文本，使用文档 ID 和字符范围回读。保存的是裁切前的提取文本和识别出的补充脚注，不是原始 HTML，也未证明整页完整提取。

## 改了什么

- `tool_library/webpage_store.py`：快照的完整写入、内容生成的 ID、按范围回读、损坏与缺失处理。默认路径为 `reports/webpage-snapshots/`，已加入 Git 忽略。
- `tool_library/network.py`：网页成功提取后、裁切前先保存快照，预览增加 `document_id` 和 `total_chars`；原有 10,000 字符返回限制及脚注预留继续生效。
- `tools.py`：注册 `read_saved_webpage(document_id, offset=0, limit=4000)`，最多返回 10,000 字符；两种 Loop 自动共享新工具，不改变 SDK 的核心循环。
- `skills/webpage-reader/SKILL.md`：已有 ID 时回查；继续读取使用 next_offset，保留证据位置，缺资料时报告未读范围。
- `vercel_agent/checks.ts`：回读的原文也参与逐字引文和来源 URL 检查，只检查本轮实际取回的范围。
- `vercel_agent/verify_recall.ts`：可重复运行真实模型回查实验，结果索引保留路径、用量及功能检查，不重复存储整段原文。

## 验证方式

1. 通过现有 Python 桥接实际读取 [Anthropic Managed Agents](https://www.anthropic.com/engineering/managed-agents)，保存提取文本快照。
2. 关闭这个工具进程，创建新进程与全新的模型消息列表。
3. 新任务仅提供文章标题、文档 ID、相关段落位置和问题，不提供原文、旧工具消息或参考答案。
4. 真实模型自行提出 read_saved_webpage 调用，工具从磁盘取回内容，模型再回答。
5. 第二个独立任务用不存在的 ID，检查取不到资料时是否如实说明。

验证程序提前定位相关段落，并把位置作为精简工作记录保留。因此这是“已知文档及位置，移除旧上下文后还能回查”的实验，不是任意段落的自主搜索测试；没有自动压缩，没有恢复完整会话或之前的预算。不得把这次验证称为自动压缩已完成。

## 实际结果

真实网页快照 12,552 字符，首次预览截断。文档 ID：`2c1754980998fb61eb46b57f33b5ceafce4b569978cefd7ed7b570578d27051a`。

| 场景 | 真实工具行为 | 模型请求 | 工具调用 | tokens | 验收 |
|---|---|---|---|---|---|
| 原文回查 | 从位置 8214 请求 6000 字符，实际返回 4338 字符至快照末尾；未重新下载 | 2 | 1 | 5205 | 功能通过；引文检查 3/3 通过，仍待完整验收 |
| 不存在的 ID | 返回 snapshot_not_found | 2 | 1 | 3890 | 失败处理合理；阅读交付物未完成，failed_checks |

正例回答正确解释按需创建执行容器，并保留作者报告的 p50 TTFT 约降低 60%、p95 超过 90% 的近似限定；正确将指标解释为首次响应延迟，未写成任务成功率。以上是对厂商自报文章的转述，不是独立性能测量。

负例明确无法判断，没有编造时间测量条件，也没有猜测另一个文档 ID。

正例仍有两个格式问题：三列表格分隔行写成四列；第一段引文六个词，超过任务要求的每段五词。当前自动检查没有检查这两项，不能把 needs_review 当作任务全通过。

[正例实际答案](</Users/ashyh666/Documents/ChatGPT/hugging face + 最小agent demo/reports/harness/webpage-reader-ok8Wyc/answer.md>) · [正例运行记录](</Users/ashyh666/Documents/ChatGPT/hugging face + 最小agent demo/reports/harness/webpage-reader-ok8Wyc/run.json>)

[负例实际答案](</Users/ashyh666/Documents/ChatGPT/hugging face + 最小agent demo/reports/harness/webpage-reader-ThdjYa/answer.md>) · [负例运行记录](</Users/ashyh666/Documents/ChatGPT/hugging face + 最小agent demo/reports/harness/webpage-reader-ThdjYa/run.json>)

[结果索引](</Users/ashyh666/Documents/ChatGPT/hugging face + 最小agent demo/reports/webpage-recall-validation.json>)

两次模型任务合计 9,095 tokens、4 次模型请求、2 次本地回读；另外有一次用于建立快照的真实网页请求。没有重跑筛选成功输出。

## 程序检查

- Python：41 项测试全部通过。覆盖裁切尾部/长脚注回读、分页重组、严格参数、缺失/损坏/符号链接快照、工具预算。
- SDK/Harness：28 项测试全部通过。新集成测试使用真实 SDK 和真实 Python 工具，模拟模型 HTTP 响应；验证旧工具进程关闭、旧消息移除后，工具结果仍按 call ID 进入下一次模型请求并参与验收。
- TypeScript 类型检查和 git diff --check 通过。
- 真实模型验证包含一个正例与一个负例，不构成稳定成功率评估。

## 接下来

现阶段可以先用这些 ID 回查资料，观察模型是否重复读同一段、是否漏读、是否错误解释内容。需要先解决网页提取遗漏及更严格的格式验收，再决定何时加入自动上下文压缩。

快照和 Harness 原始记录保存在本地，克隆仓库不会携带；脚本会重新生成快照。不存在的快照无法通过摘要重建原文。当前没有完整会话恢复、会话事件流查询、后台任务或 RAG。
