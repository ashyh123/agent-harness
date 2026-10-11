# Jev 限定分类的完整主 Agent 对照

> 历史实验记录：对应的一次性对照脚本已清理，文中旧运行命令不再是可用入口。当前回归验证使用 `npm test`；当前路由对照使用 `python3 vercel_agent/verify_hybrid_repeated.py --exclusive`（仓库根目录，真实付费调用）。

2026-10-11。结论：完成接入，保持为可切换实验，不足以设为默认。

Jev 只在主 Agent 已决定 submit_tasks 后覆盖 capability/complexity。主 Agent 继续负责缺失信息判断、拆解、提交、验收条件、指定 route 和产物审阅。原主 Agent 仍提供两字段作为异常回退，因此此方案增加分类请求，并未省去原模型的一整次请求。同一提交参数缓存分类结果。

## 固定实验

新任务：计算 (37+58)*16；汇总 CSV A12/B18/A30；解释 managed-agents 的 brain/hands 分离并引用原文；Python 将带前导零 ID 的 JSON 转 CSV 并统计。博客用了既有来源但新问题。每组四项、每项一次，交替两组顺序；没有重复统计精度保证。任务清单在运行前保存。两组同样的主模型、执行端、工具、预算、Skill、真实提交和真实模型审阅，未用程序替代审阅。完整耗时包括进程启动、提交、分类、执行、升级、审阅和关闭。

Jev 固定 jev-1.13.0；主模型及 routine worker 使用现有 deepseek-flash；Codex 使用本机现有 CLI 配置。沿用主 Agent 每轮 model12/tool16/180秒、默认任务360秒、最多两次执行尝试以及整个入口900秒。各轮预算沿用原入口，并非全任务共享12次请求。

## 汇总

| 指标 | 原方案 | Jev 两字段 |
|---|---:|---:|
| 主 Agent 审阅完成 | 4 | 4 |
| 平均秒 | 35.17947363550775 | 34.0803946457454 |
| 已知 API 美元 | 0.009461813999999999 | 0.00812385 |
| DeepSeek 输入 token | 163745 | 148850 |
| DeepSeek 输出 token | 7636 | 6408 |
| Codex 输入 token | 316335 | 280595 |
| Codex 输出 token | 3000 | 2952 |
| Jev 请求数 | 0 | 4 |
| 完整账单金额 | 未知 | 未知 |

已知费用包含所有主 Agent 和 DeepSeek worker 的模型事件，以及 Jev 调用；包括失败及升级前消耗。按 2026-10-11 周日非高峰标价与实际缓存用量估算。Codex 只有用量，金额未知，不能记为零。来源：[DeepSeek](https://api-docs.deepseek.com/quick_start/pricing/) 和 [TypeSafe](https://docs.typesafe.ai/models)。

| 任务 | 原方案秒 | Jev秒 | 原方案执行链 | Jev执行链 |
|---|---:|---:|---|---|
| math | 11.02 | 24.97 | deepseek | codex |
| data | 48.98 | 14.23 | deepseek → codex | deepseek |
| blog | 44.97 | 47.43 | deepseek → codex | deepseek → codex |
| code | 35.74 | 49.70 | codex | codex |

## 独立复核与判断

四类任务两组产物均经额外复核：计算1520；CSV合计60/平均20；博客主要逐字引文在已存原文快照中精确匹配，解释涵盖模型与harness、沙箱工具及独立session；脚本产物保留007/008，统计30/15/2，CLI日志有成功Python执行。此复核在任务结束后进行，不改变两组主 Agent 的审阅流程；不等于通用事实正确性证明。

Jev 把数学任务误判为 coding：主 Agent 的任务描述含“写入 result.md”，分类器未获得“外壳自动保存该文件”的上下文，因而触发 Codex。该任务原方案11.02秒，Jev24.97秒。数据任务原方案升级一次，Jev没有升级；这是同样选择DeepSeek后的执行波动，不能归因于分类更好。博客两组均升级；代码两组均Codex。

整体平均耗时下降约3.1%、已知费用下降约14.1%，但收益来自单次执行波动与升级差异，且未获得Codex账单。不能证明总成本更低。此次未基于结果调整分类提示词再混算数据。若继续优化，应补充外壳与工具能力上下文，在新保留任务集重复测量；更重要的是防止简单任务因产物保存描述而升级。

## 文件与复现

- 原始批次：reports/routing-model-runs/hybrid-new（Git忽略）。
- 汇总：reports/jev-hybrid-summary.json。
- 接入：vercel_agent/jev_submission.ts、task_center_server.ts、person_cli.ts。
- 启用：MINIMAL_AGENT_ROUTING_CLASSIFIER=jev npm run person -- "任务"（vercel_agent目录）。
- 新建批次：从根目录运行 python3 vercel_agent/verify_hybrid.py（会产生真实用量）。
- 原方案不设置该环境变量。
