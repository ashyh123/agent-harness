# Jev 外壳能力上下文修复：三轮完整对照

2026-10-11。结论：本批 result.md 误分类未再出现；任务效果持平，未证明降本或提速。保持可选实验开关，不自动切换默认策略。

## 修改

`jev_submission.ts` 在 state 中加入 expected_files 和 runtime_capabilities，并修改 capability 问题：外壳自动把最终回答写入 result.md，不需要编程。calculate 可算术；read_data/query_data 可处理现有数据；网页工具可读取和回查证据。生成额外文件、修改文件、编写运行脚本仍属 coding，要求把代码写进 result.md 也不能借此降级。此处是依据当前实现整理的能力摘要，今后需随工具变化维护。依据 [TypeSafe state 文档](https://docs.typesafe.ai/concepts/state)，任务与运行状态一起提供给分类器。

Jev 仍只覆盖能力与复杂度。原 DeepSeek 主 Agent 保留资料充分性、拆解、提交、指定 route、验收条件和结果审阅；异常回退及分类缓存沿用已有实现。原模型仍生成回退分类，因此不能假定这一步省去模型请求。

## 实验约束

四项新任务，每组每项重复3次，共24条真实完整流程，交替先后顺序，串行运行。计算(84-29)*7；JSON汇总14/22/36；阅读managed-agents的harness/session与沙箱恢复（新问题，同一既有网页）；Python输出带004/009的CSV及36/18/2统计。清单和验收事实在调用前写入manifest，未在中途修改任务或分类指令。

Jev固定jev-1.13.0，DeepSeek沿用deepseek-flash，Codex沿用本机CLI配置。两组同工具、模型、预算、Skill和真实主模型审阅。主Agent每轮model12/tool16/180秒，任务与worker预算沿用现有入口；Codex原生循环不受DeepSeek请求次数预算控制。完整计时含启动、模型、工具、失败升级、回读审阅和关闭；费用包含所有可观测主Agent与worker用量。

## 结果

| 指标 | 原方案 | Jev补充上下文 |
|---|---:|---:|
| 主Agent审阅及独立产物复核 | 12/12 | 12/12 |
| 平均完整耗时秒 | 31.792 | 32.750 |
| 已知API美元 | 0.03002131 | 0.03017138 |
| DeepSeek输入token | 522,488 | 490,623 |
| DeepSeek输出token | 25,034 | 25,463 |
| Codex输入token | 683,683 | 655,827 |
| Codex输出token | 7,970 | 7,338 |
| 含Codex的完整账单 | 未知 | 未知 |

Jev平均耗时高约3.0%，已知API费用高约0.5%。四个不同任务的重复不等于12个独立任务，也不足以建立统计等效或显著差异。不能据此断言Jev普遍更差，但没有得到切换默认方案的效率证据。

| 任务 | 原方案三轮平均秒 | Jev三轮平均秒 |
|---|---:|---:|
| math | 21.30 | 13.12 |
| data | 16.45 | 23.74 |
| blog | 50.16 | 55.16 |
| code | 39.26 | 38.98 |

Jev调用12次，无异常回退；分类平均542.1毫秒，分类费用合计$0.00051408。三次math、三次data、三次web、三次coding均符合预期，且均与原主模型提供的两字段一致。保存result.md的9次非编程任务没有误判；3次额外文件生成仍为coding。原先具体误判案例未在本批重复，是新的相同边界任务。

由于所有分类与原主模型一致，本批执行端选择未因Jev带来额外优势。数学原方案、数据Jev方案各有一次较长执行；升级和模型生成波动足以影响总均值。修复分类边界与证明全流程性能提升是两个不同结论。

## 独立验收

在真实主Agent审阅之后额外复核，不回写并影响运行：计算385；数据合计72、平均24、最大36；CSV列值与前导零、原顺序、统计JSON的指定字段以及CLI成功Python执行记录；博客引文与已存正文逐字匹配，并人工阅读六份解释，确认session日志恢复、工具错误与条件性沙箱重建的描述正确。程序化数值检查与关键词检查本身不证明任意解释正确，人工复核范围仅上述任务。

费用按2026-10-11周日非高峰标价和实际usage估算，缓存命中单独计费；包含失败和升级之前的消耗。Jev费用也计入。Codex仅有token用量，未获得实际账单，不计作零，不宣称总成本下降。[DeepSeek定价](https://api-docs.deepseek.com/quick_start/pricing/) / [Jev定价](https://docs.typesafe.ai/models)。

## 证据与复现

- 原始批次：`reports/routing-model-runs/hybrid-context-8_fo0x8y`（Git忽略）。
- 汇总：`reports/jev-context-summary.json`；逐产物核对：`reports/jev-context-audit.json`。
- 入口：仓库根目录执行 `python3 vercel_agent/verify_hybrid_repeated.py`，会调用真实API及Codex并生成独立批次。
- 仍可用 `MINIMAL_AGENT_ROUTING_CLASSIFIER=jev` 选择新策略；默认保持原方案。
- 本批无凭据被写入报告；自动检查结果另附。

验证：132项TypeScript测试通过，类型检查和git diff --check通过；本批报告及原始记录的凭据值扫描无匹配。
