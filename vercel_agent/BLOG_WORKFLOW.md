# 博客固定工作流与 Agent loop

在项目根目录配置 `.env`，进入 `vercel_agent` 后运行：

```sh
# 默认固定工作流（blog:workflow为显式别名）
npm run blog -- "https://博客地址"
# 自主回查与修正
npm run blog:agent -- "https://博客地址"
```

两者使用同一 DeepSeek 模型、Python 工具、共享预算及 Obsidian 保存工具。固定工作流使用 LangGraph 的线性图，不调用通用 Agent loop：

1. `read`：代码调用 `read_webpage`，保留正文预览与快照 ID；Markdown 页面自动回读同一快照的 text 前10000字符，避免Markdown链接打断逐字引文，不重新下载。读取失败不请求模型。
2. `summarize`：AI SDK 请求一次模型，生成 summary、takeaway、quote_index 三字段 JSON，不向模型提供工具调用协议。程序从本轮原文提取连续片段，长度上限取自保存工具 schema（目前220字符），保留合法的200–220字符完整句子。候选编号和原文位于输出schema描述中，模型只返回编号，程序检查整数和范围后复制对应原文为 evidence_quote，再交给原保存工具。这防止模型拼接或改写引文，但不保证支持关系。DeepSeek使用schema提示注入兼容模式，应用仍检查字段与参数，安全容量估算包含候选schema。
3. `validate`：代码检查非空字段、引文在实际读取内容中、摘要短于原文及原保存工具的参数限制。不能证明语义准确。
4. `review_evidence`：一次独立模型请求核对主要事实、重要限定、推论标记和引文对核心结论的直接支持。模型必须给出 core_match，把摘要中的具体结论绑定到输入 evidence_quote；程序检查结论是摘要逐字片段，不能换用正文的其他引文。绝对说法还须有 risk_checks 的原文依据，程序检查片段真实性、风险项覆盖和每项判定，即使整体 summary_facts 支持，也不能覆盖风险项的否定判定。短引文无需覆盖所有并列要点。核对不全、服务或预算有问题则拒绝保存；片段匹配本身仍不能证明逻辑正确。
5. `save`：代码调用 `save_obsidian_blog`，得到文件写入、回读和 hash 收据后结束。

两个博客CLI在保存成功后另行执行共同概念整理，生成Obsidian的“博客→概念→博客”链接。这是独立的额外请求阶段，失败不会撤销原笔记，费用单独显示；库调用和配对基准不隐式执行。已有笔记用 `npm run blog:index -- "/absolute/path/to/阅读笔记.md"`，详见 [OBSIDIAN_KNOWLEDGE.md](OBSIDIAN_KNOWLEDGE.md)。

结构化输出无效、截断、检查失败、保存失败或超出共享预算均结束，不自动修正或重试，不把失败当成功。正常两次模型请求（摘要＋证据核对），Markdown页面三次工具调用、纯文本两次；若输入达到原上下文维护阈值，维护请求仍计入预算。输入超过安全容量时停止。

`blog_agent.ts`（`blog:agent`入口）保留原本的模型选工具与回查、修正能力。它每次保存前也执行相同的证据核对；未通过时把拒绝原因反馈给模型，拒绝保存计入工具尝试。它可能为了引文或关键限定进行更多读取，成本更高；一次真实测试曾修正超长引文后成功保存。固定工作流适用于已给 URL 的常规摘要，Agent loop 适用于需要自主查找、追问或多步修正的任务。

## 配对复测

OMP原生循环与原LangGraph博客Harness的独立配对结果及方法见 [OMP_COMPARISON.md](OMP_COMPARISON.md)。该实验共用业务工具和验收，并非在OMP外面包装原Loop。

```sh
npm run verify:blog-workflow -- --prepare
# 核对输出目录内 manifest.json 的冻结正文、预算和预先定义的验收标准
npm run verify:blog-workflow -- /absolute/path/to/prepared-directory
```

准备步骤尝试抓取 Anthropic、OpenAI、Google 三篇真实博客；失败时只使用已有、来源 URL 相同的快照，并在 manifest 标注。每篇每组运行三次，顺序交替，使用 temperature=0、新上下文和相同预算上限。预算是相同上限，不要求两组花完相同请求数。固定工作流不需要把工具描述发送给模型，这是所比较的设计差异。

每组共用冻结的 `read_webpage` 预览，Agent 可进一步回查同一快照。摘要范围是实际读取范围，不要求全文完整性。除读取重放外，保存和核验均实际执行。测试笔记写入现有 Obsidian vault 下的 `工作流对照/<日期>/<批次>/<任务>`，不覆盖日常笔记。

计时覆盖工作流或 Agent 的运行，包括模型、工具和文件写入；不包含两组共用的网页预处理、Python 启动及后续语义复核。记录实际 API usage 的 input/output/total tokens，包含失败尝试。Agent 的 Harness 日志开销包含在其时间中；该差异未单独归因。

当前两组执行时都启用保存前核对，核对 API 请求包含在各自预算与计时中。它不是离线盲评，模型仍可能误判。此前未启用核对的对照数据不能冒充当前版本性能。`results.json` 的离线 semantic_review 初始为 pending。必须逐条对照冻结原文检查：摘要事实、关键限定、推论标记和引文支持关系；不能用字符串匹配自动宣称内容准确。摘要建议长度另作诊断，不把所有遗漏都当作事实错误。小样本结论仅适用于这些快速摘要任务，未覆盖付费页面、扫描 PDF、全文长论文或大规模统计稳定性。

默认CLI以 `reports/blog-workflow/last-run.json` 覆盖保存最近一次运行，包含失败候选与核对结果，避免积累每次运行目录。对照记录留在 Git 忽略的 `reports/blog-workflow/`。复测调用真实 API 并实际写入测试笔记。

核对审阅代码在 `blog_evidence.ts`，模型审阅事件记录为 `blog_review`，API 用量记录为 `blog_evidence_review`。固定工作流失败时保留候选 draft 和 evidence_review，便于定位；CLI 不会凭候选摘要声称保存成功。

## 学习 Demo 验收

这一版按“来源可追溯、主要事实可靠、真实保存、失败明确”的范围收尾。验收结果与简历表述边界见 [BLOG_DEMO_RELEASE.md](../docs/BLOG_DEMO_RELEASE.md)。

```sh
# 使用上方 --prepare 生成的本机 manifest 和原文快照
npm run verify:blog-acceptance -- /absolute/path/to/manifest.json
```

运行同模型和预算下的六次固定流程保存，并用五个故意错误的候选检查实际模型拒绝行为。结果写入 Git 忽略的 reports，笔记隔离存放于 Obsidian 的 `版本验收/<批次>`。候选只被核对，错误控制不调用保存；正常保存和共享Loop拒绝保存另有离线集成测试。语义复核初始为 pending，需对照原文后才能宣称内容验收通过。
