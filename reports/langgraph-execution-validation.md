# LangGraph 直接执行模型与工具：真实任务对照

2026-10-10，本机真实 DeepSeek API 共 24 次运行。**两组严格验收都为 6/12；未证明 LangGraph 提升任务完成率或效率，保留原 Vercel 循环为默认。** LangGraph 总 token 多 8.68%，平均耗时多 1.85%。

## 这次实际替换了什么

`langgraph_loop.ts` 使用 StateGraph 直接执行 prepare_context → model → tools → prepare_context 的循环；model 无工具调用时进入 finish，输出截断回到上下文准备后精简重试。model 节点每次用 generateText 发起一个模型步骤；移除 SDK tool.execute，工具只在 tools 节点经 PythonBridge 执行。没有从图节点调用 VercelLoop、ToolLoopAgent 或整轮 MinimalHarness。

原来的 langgraph_backend.ts 仍是外层执行/审批/交付图，两者是不同入口。此次 MinimalHarness 只复用 Skill 注入、运行记录和验收框架，通过 loopFactory 选择执行器。agent.ts 抽出共享 createExecutionRuntime，保留相同 provider、计数 Fetch、工具 schema、参数验证和上下文策略，原循环继续由 ToolLoopAgent 编排。LangGraph 不会自动增加工具能力或阅读策略。

图内消息包含真实 toolCallId 对应的工具结果。普通工具错误返回模型修正；预算错误使本轮停止；截断重试复用已成功的工具观察。graph_nodes 留下实际节点轨迹。此次内部图未接入 checkpointer，不声称模型步/工具步的崩溃恢复、并行加速或跨进程预算持久化。

## 控制条件与计量

- 模型均为 deepseek-flash，temperature=0，thinking disabled，SDK 请求重试=0；无模型或工具 mock，无付费模型裁判。
- 工具名称、描述、schema、顺序完全一致：read_webpage、read_saved_webpage、calculate、read_data、query_data。实际阅读固定磁盘快照，数据处理使用真实 Python 工具。
- 两组均使用 2 倍基线执行/输出预算：10 外层请求、16 总模型请求、16 工具尝试、180 秒、每次输出 1024 tokens。摘要、重试、无效调用均计入原预算；没有新增总 token 硬上限。
- 共用原 legacy 上下文策略：trigger=12000、target=8500、max_input=64000、summary_output=1024、recent=2000，未为某一组放宽压缩阈值。
- 每题每组 3 轮，交替先后顺序；每轮新任务上下文。两篇博客固定同一 text 快照并保存 SHA-256，隔离网络抓取变化。JSON/CSV 为相同内联测试数据。
- 12 对首个模型请求的规范化内容哈希全部一致（model/messages/tools/temperature/max_tokens/thinking），未记录认证头。后续请求由各自生成内容决定，不强制一致。
- tokens 为供应商 usage.prompt_tokens + completion_tokens，包括上下文摘要请求；不把估算值当计费用量。耗时为整轮本机端到端墙钟时间，含桥接准备、图编译、模型网络、工具和日志；不是纯框架 CPU 开销。报告均值和中位数，样本较小，API 延迟、缓存及模型采样会波动。

## 各任务结果

下表 tokens 与耗时为每次运行均值；通过数为各自三轮的严格验收。

|任务|原 Harness 通过|LangGraph 通过|原 tokens|图 tokens|原耗时/s|图耗时/s|
|---|---:|---:|---:|---:|---:|---:|
|长博客三项事实核对|0/3|0/3|16347|14540|6.698|5.464|
|完整快照读取与引文核对|0/3|0/3|11602|11691|5.147|5.150|
|嵌套 JSON 筛选/统计/CSV 转换|3/3|3/3|22466|28946|9.401|10.703|
|CSV 空值报错恢复/统计/排序|3/3|3/3|19062|20328|7.398|7.856|

|全部 12 次/组|原 Harness|LangGraph|
|---|---:|---:|
|严格通过|6/12|6/12|
|正常返回答案|12/12|12/12|
|总 tokens|208430|226514|
|总模型请求|48|51|
|总工具尝试|54|60|
|上下文摘要次数|6|6|
|相同参数重复工具尝试|3|6|
|平均耗时/s|7.161|7.293|
|中位耗时/s|7.050|6.503|

## 逐类验收与人工复核

1. **长博客事实核对：两组均 0/3。** Demystifying evals 快照共 38,429 字符，要求核对初期评测任务数量/来源、pass^k、SQL 预订状态。两组均只读取 [0,20000)，经历一次摘要后结束；第一项关键原文从 offset=20387 开始，实际从未读到。模型如实说需要回查，却没有继续调用工具。其余两项事实与逐字引文正确。没有耗尽预算，没有输出截断，不能把失败简单归因于预算不足、压缩丢失或图框架。缺的是“问题证据尚缺→继续读取”的任务控制与验收回路。

2. **完整快照：严格 0/3，但事实与覆盖检查两组均 3/3。** Managed agents 共 12,552 字符，两组真实覆盖 [0,12552)，getSession/getEvents 与 p50约60%、p95超过90%的 TTFT事实和否定成功率解释正确、引文确实存在。全部严格失败在部分引文超过提示要求的100字符。人工复核也发现个别答案泛称快照含参考文献，没有要求逐节概括（sections=[]），所以这一题不能证明全部章节语义总结或原网页抓取完整性。逐字证据正确和格式合规分别报告，没有事后放宽验收。

3. **JSON→CSV：两组 3/3。** 对嵌套 /data/rows 筛选 east 且 amount>=100，用真实查询求 sum=300、mean=150，数值降序导出 name/amount。逐字比对正确的逗号和双引号转义。存在 missing_column 报错与重复查询：query_data 从原始根对象查询，不继承解析预览的 JSON Pointer；模型之后补路径才完成。LangGraph两次运行尝试更多错误查询，解释其较高用量；不是完成率提高。

4. **CSV恢复：两组 3/3。** 必须先执行带空值的全量求和并观察 non_numeric，再排除空字符串；正确 sum=60、mean=20，保留001/002前导零与note中的逗号/换行，按数值降序返回。检查实际错误在修正求和之前，最终答案与实际工具产物一致；部分运行还有SDK参数错误修正。

阅读验收直接复用已有 readingChecks/targetedChecks，数据验收匹配精确期望与工具证据，无模型裁判。检查通过仍不是所有语义自动认证；上面复核了全部12份博客答案和全部12份数据答案。评测产生本机日志，不向 Obsidian 写入或改业务文件。

## 判断与下一步

本实验回答的是“相同任务策略下替换内部循环编排是否更好”，没有证据支持现在淘汰原循环。新图已可真正执行所有本地 Skill，适合下一步显式添加证据检查/修正分支；若加此策略，需再做独立对照，不能用本轮数据预先宣称提升。优先解决未回答的问题证据检查、读区间覆盖、短引文格式和JSON Pointer参数理解，再讨论迁移默认。

## 复现与证据

在 vercel_agent 运行（使用已配置 DeepSeek key，真实评测会产生用量）：

```sh
npm run harness:langgraph -- --list
npm run harness:langgraph -- calculation-audit "计算123乘456"
npm run harness -- calculation-audit "计算123乘456"
npm run verify:execution-graph -- 3
npm run typecheck
npm test
```

评测依赖本机已有 reports/webpage-snapshots 的两个指定快照；快照与原始运行日志按原规则 Git 忽略。脚本读取相同快照并先验证源事实存在，缺失时停止，不换新网页悄悄改变任务。其他机器需准备同ID材料，不能保证网络实时下载得到相同内容。

- 实现：../vercel_agent/langgraph_loop.ts、agent.ts、harness.ts、harness_cli.ts。
- 对照脚本：../vercel_agent/verify_execution_graph.ts。
- 可提交摘要：[langgraph-execution-summary.json](langgraph-execution-summary.json)，含24次指标、答案、验收、错误与首请求哈希。
- 原始完整运行目录：`/Users/ashyh666/Documents/ChatGPT/hugging face + 最小agent demo/reports/langgraph-runs/execution-U3wn9c`，comparison.json 包含真实events；finished.json确认24轮结束。
- 类型检查通过；131项测试全部通过，其中新增17项针对真实LangGraph节点执行的离线HTTP响应测试，覆盖参数错误、未知工具、预算、截断恢复、重试和超时；不是用离线模拟tokens替代本轮真实usage。

参考：LangGraph官方[工作流与Agent](https://docs.langchain.com/oss/javascript/langgraph/workflows-agents)中的模型/工具循环；本文性能结论来自本机实测，不是框架官方承诺。
