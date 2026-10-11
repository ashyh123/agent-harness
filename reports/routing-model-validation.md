# Jev 与 DeepSeek 路由对照（2026-10-11）

> 历史实验记录：对应的一次性对照脚本已清理，文中旧运行命令不再是可用入口。当前回归验证使用 `npm test`；当前路由对照使用 `python3 vercel_agent/verify_hybrid_repeated.py --exclusive`（仓库根目录，真实付费调用）。

结论：暂不替换默认路由判断。Jev 在此小样本分类测试中更快、分类 API 更便宜，但提交／分配结果与预标注的匹配率较低。它可以继续作为限定范围的分类候选；这次没有证明它能够替代主 Agent 的任务拆解与结果审阅。

## 设计与范围

- 使用 TypeSafe skill 与实时官方文档，固定 Jev `jev-1.13.0`、DeepSeek `deepseek-flash`；Codex 使用现有 CLI 配置。
- 16 项任务，每项每组重复两次，共 64 次真实分类请求。四个相同判断：能力、复杂度、用户指定执行端、是否可提交。测试前保存任务与预期标签，模型看不到预期标签。
- 相同任务状态与候选执行端、同一 `selectExecutor` 规则。两种 API 格式不同，但判断问题的语义相同。无重试，无根据结果调整提示词。
- 4 类真实任务（计算、CSV 聚合、博客证据提取、Python JSON→CSV），每项每组两次，共 16 条完整任务流程。使用真实 TaskCenter/TaskRouter、现有 LangGraph DeepSeek worker 与 Codex CLI；同一模型、工具、上下文策略、预算、外部程序验收与升级规则。
- 总任务 360 秒、每次执行最多 180 秒、最多两次尝试；DeepSeek worker 使用现有 task-executor 预算（model8/tool8/steps5/output1024）。
- 此处只替换窄分类组件，未使用完整 task-coordinator 主模型的开放式拆解／语义审阅。程序验收替代主模型审阅，两组相同。
- 首轮验收错误地要求 CSV 的 score 必须是字符串，误拒绝合法数值。保留首轮全部记录，修正为语义验收并增加回归测试后，复用原 64 条分类结果，重新执行全部 16 条流程。下面执行数据全部来自修正后独立批次。

## 分类结果

匹配率包含提交、澄清、拆解、不可分配以及执行端选择，不等于纯能力分类准确率。16 个不同任务的两次重复也不等于 32 个独立样本。

| 指标 | DeepSeek | Jev |
|---|---:|---:|
| 与预标注结果匹配 | 29/32 (90.62%) | 22/32 (68.75%) |
| 平均分类耗时 | 799.0 ms | 327.4 ms |
| 32 次分类估算成本 | $0.00224280 | $0.00160541 |
| 输入／输出 token | 18732 / 623 | 38224 / 5334 |

Jev 平均分类耗时降低 59.0%，分类 API 费用降低 28.4%。两组缓存与服务端实现不同，不能推广到所有任务或峰值时段。

逐项对照两组结果：能力、复杂度、用户指定执行端三个字段均为 32/32 一致；是否可提交（action）仅 25/32 一致。这只是两模型之间的一致性，不能当作对真实标签的准确率。
主要问题是 Jev 的 action 判定：完整英文计算任务两次均要求澄清；明确指定不兼容执行端、Codex 不可用时也要求澄清，而预期由代码报告无法分配。能力判断通常正确，不代表发生了越权执行。三家厂商博客案例未指定厂商，预标注认为可执行，但澄清也有合理性；该标签具有主观性，两组均出现偏差，不能把全部标签不匹配理解为模型错误。

## 修正后实际执行

| 指标 | DeepSeek 分类 | Jev 分类 |
|---|---:|---:|
| 验收完成 | 8/8 (100.0%) | 7/8 (87.5%) |
| 平均耗时：分类＋执行 | 22.47 s | 17.74 s |
| 已知 API 估算成本合计 | $0.004443 | $0.004501 |
| 全流程实际金额 | 未知（含 Codex） | 未知（含 Codex） |
| DeepSeek 执行输入／输出 token | 75636 / 3057 | 90869 / 2998 |
| Codex 输入／输出 token | 498836 / 3550 | 314632 / 3080 |
| 执行尝试 / Codex 尝试 | 12 / 6 | 10 / 4 |

耗时为复用分类请求的实测耗时加上本轮执行实测耗时，包含工具、启动、失败、升级与验收；不是同一连续 HTTP 会话的端到端计时。已知 API 费用包含这八项的分类和所有 DeepSeek 执行请求，不重复加上完整分类批次。Codex 订阅／计费金额未获得，不能填成零。输入 token 包含缓存；不要跨厂商把 token 总数当成相同成本。

四类执行任务两组每次选择的执行端完全相同。因此执行差异来自 worker 输出与服务波动、缓存及升级，无法归因于路由更优秀。8 次每组也不足以证明长期完成率差异。

| 任务 | 轮次 | 分类器 | 执行端 | 完成 | 尝试数 | 分类＋执行 s | 已知 $ |
|---|---:|---|---|---|---:|---:|---:|
| math | 1 | deepseek | deepseek | 通过 | 1 | 4.771 | 0.000238 |
| math | 1 | jev | deepseek | 通过 | 1 | 3.404 | 0.000195 |
| csv | 1 | deepseek | deepseek | 通过 | 2 | 31.356 | 0.001230 |
| csv | 1 | jev | deepseek | 未通过 | 2 | 38.445 | 0.000607 |
| blog | 1 | deepseek | deepseek | 通过 | 2 | 35.817 | 0.001217 |
| blog | 1 | jev | deepseek | 通过 | 1 | 8.547 | 0.001177 |
| code | 1 | deepseek | codex | 通过 | 1 | 26.754 | 0.000109 |
| code | 1 | jev | codex | 通过 | 1 | 23.413 | 0.000053 |
| math | 2 | jev | deepseek | 通过 | 1 | 3.529 | 0.000184 |
| math | 2 | deepseek | deepseek | 通过 | 1 | 3.586 | 0.000183 |
| csv | 2 | jev | deepseek | 通过 | 2 | 31.371 | 0.001124 |
| csv | 2 | deepseek | deepseek | 通过 | 2 | 28.621 | 0.000672 |
| blog | 2 | jev | deepseek | 通过 | 1 | 7.096 | 0.001107 |
| blog | 2 | deepseek | deepseek | 通过 | 2 | 25.330 | 0.000760 |
| code | 2 | jev | codex | 通过 | 1 | 26.108 | 0.000053 |
| code | 2 | deepseek | codex | 通过 | 1 | 23.540 | 0.000034 |

## 验收和局限

计算检查输出含 156 且 DeepSeek 实际 calculate 返回 156；CSV 检查纯 JSON、sum60、mean20、降序和前导零 ID，DeepSeek 还检查 query_data 求和记录；博客检查来源 URL、p50=60、p95>90、不是总体成功率、连续原文引用匹配既有正文快照，DeepSeek 还检查读取工具返回。代码检查四个文件、CSV 精确转义、统计数值以及 CLI command_execution/script.py 记录。
观察到 CSV 的数据计算正确但附加说明导致格式验收失败；部分 Codex 升级拒绝任务，因为没有用户指定的 read_data/query_data 工具。执行端能力标签过粗、任务绑定具体工具、输出约束与任务执行 Skill 的报告要求可能冲突，这些问题不能靠替换分类器解决。
这些是有限程序验收，计算未严格限制答案只能为 156，Codex 博客读取路径未与 DeepSeek 工具轨迹完全同构，脚本运行证据的自动检查也较粗；不能视为通用成功证明。CLI 原始轨迹保留供复核。

## 成本口径与原始记录

2026-10-11 是周日，DeepSeek 使用非高峰标价估算：每百万缓存命中输入 $0.003、未命中 $0.15、输出 $0.6；Jev 输入 $0.042、输出免费。来源：[DeepSeek 定价](https://api-docs.deepseek.com/quick_start/pricing/)、[TypeSafe 模型与定价](https://docs.typesafe.ai/models)。这是实际 usage 对应的标价估算，并非账户账单。

额外消耗：被弃用的首轮执行已知 API 约 $0.007604，Jev 接口健康检查 $0.00001399；Codex 金额仍未知。复用分类不重复计费。本次所有分类、两轮实际执行与接口健康检查的已知 API 估算消耗合计 $0.019414872，另有未知 Codex 金额。

- 首轮（验收修订前）：`/Users/ashyh666/Documents/ChatGPT/hugging face + 最小agent demo/reports/routing-model-runs/jev-deepseek-tWMXgA`
- 本轮（验收修订后）：`/Users/ashyh666/Documents/ChatGPT/hugging face + 最小agent demo/reports/routing-model-runs/jev-deepseek-3NsKLH`
- `routing-model-summary.json` 保存汇总；原始目录被 Git 忽略，保留本地明细。

## 建议

保留当前默认主 Agent 和分配规则。若继续尝试 Jev，先只承担能力／复杂度判断，把可用性、权限和强制执行端规则继续放在代码中；提交条件不足的判断设置回退，使用新的保留测试集验收。不能凭本次的分类费用优势声称整体 Agent 已降本或主 Agent 已替换。

当前博客程序验收依赖本机已保存的 managed-agents 正文快照（reports/webpage-snapshots/2c1754980998fb61eb46b57f33b5ceafce4b569978cefd7ed7b570578d27051a.json）；新克隆需先准备该基准，不能直接无条件重放。

复现：在 `vercel_agent` 运行 `npm run verify:routing`（会调用真实付费 API 与 Codex）。修订验收重跑可用 `-- --reuse-classifications <原始批次目录>`；只允许完全相同任务、判断问题与候选配置。

## 代码验证

130 项 TypeScript 测试全部通过，TypeScript 类型检查与 git diff --check 通过。凭据值扫描未发现本次代码、报告或原始实验记录包含 API key。默认生产入口没有接入该实验分类器。
