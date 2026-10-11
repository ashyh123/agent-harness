# LangGraph 任务阶段恢复验证

日期：2026-10-10。本地 origin 为 `https://github.com/ashyh123/agent-harness.git`，起点 HEAD `06de7ca9d9d3be9e2fee0dd7a6f3389e21349679`。用户原有根 README 改动与 docs 文件保留，没有修改它们。没有提交、推送或部署。初轮验证为离线测试；随后用户明确授权“验证付费模型”，已完成下文真实模型验证。

## 实现与取舍

使用 TypeScript LangGraph 的 StateGraph、Annotation、条件边、interrupt/Command 和官方 SQLite checkpointer。任务执行节点调用现有 MinimalHarness，由 VercelLoop、PythonBridge、Pydantic 与 RunContext 继续完成原预算和工具逻辑；无需跨语言引入第二个模型客户端。原 Harness 入口保持，新后端通过 `npm run langgraph` 显式选择。

真实已有流程是 calculation-audit，工具收窄为 calculate。completed + needs_review 进入审批；failed_checks 或执行失败直接不交付。批准后幂等保存 delivery.md。任务、结果、配置、工具证据、审批与阶段状态保存在本地。

增加执行结果 receipt 以覆盖执行完成与检查点提交之间的进程退出；执行开始 marker 阻止结果不确定时自动重跑。幂等文件保存覆盖副作用与图提交之间的退出。本版本审批的是本地交付，不是外部系统写入，也未对 Obsidian 等现有写工具提供 exactly-once 保证。

## 修改文件

| 文件 | 用途 |
| --- | --- |
| vercel_agent/langgraph_backend.ts | 图状态、条件分支、SQLite、执行结果复用、审批、幂等交付 |
| vercel_agent/langgraph_cli.ts | start/status/resume 本地入口 |
| vercel_agent/langgraph_fixture.ts | mock 模型、真实 Harness/计算工具的共享实验夹具 |
| vercel_agent/tests/langgraph.test.ts | 8 项确定性与故障恢复测试 |
| vercel_agent/tests/fixtures/langgraph_worker.ts | 跨进程退出/恢复工作进程 |
| vercel_agent/verify_langgraph.ts、verify_langgraph_real.ts | 离线/真实模型两档预算、三次重复的配对对照与原始证据 |
| vercel_agent/package.json、package-lock.json | 固定依赖及运行命令 |
| vercel_agent/README.md、LANGGRAPH.md | 新后端入口、设计和恢复限制 |
| .gitignore | 忽略本地检查点和原始运行资料 |
| reports/langgraph-validation.md | 本报告、实际结果与简历表述 |

## 实际测试

最终 TypeScript：**114/114 通过**（原 106 + 新 8），`npm run typecheck` 通过。Python：**84/84 通过**，pip check 无损坏依赖。`git diff --check` 通过。

全量测试初次受沙箱 Unix socket 限制，出现 IPC/子进程测试失败；在允许本地 IPC 的执行环境中重跑后全部通过。没有通过修改原测试绕过失败。

新增 8 项用例：

1. 审批暂停后，关闭进程并在新进程恢复。
2. 保存 execution.json 后、图提交前，以 process.exit(73) 退出；新进程复用结果再审批。
3. delivery.md 写入后、图提交前退出；新进程恢复交付节点。
4. 一个模型请求的原预算失败，直接拒绝交付，保留一次工具调用证据。
5. 拒绝审批不交付；重复 start 与遗漏审批明确报错。
6. 执行器内部异常，结果不确定，恢复不能重新执行或重置预算。
7. 副作用 Skill 在执行之前拒绝。
8. 已有 failed_checks 判定不能进入审批。

前三项使用独立 Node 进程，真实 SQLite 检查点；断点恢复后均只存在一个 Harness 运行目录、两次模拟模型请求、一次真实 calculate。交付内容、inode 与 mtime 不变，验证没有第二次文件写入。测试覆盖进程退出；没有测试主机断电、磁盘损坏或并发恢复。

## 可复现离线对照

`cd vercel_agent && npm run verify:langgraph`。固定任务“计算123乘456”，相同 Skill、工具、配置、预算和输出；真实 SDK 与 Python 工具，仅模型 HTTP 响应 mock。两个预算档各重复三次，交替执行顺序。独立验收同时要求回答包含 56088、工具返回结果为 56088、运行完成。

本次原始证据：`reports/langgraph-runs/offline-eeEKnd/comparison.json`（Git 忽略，本机可回读）。SHA-256：`851208814122e7701db89081e90e6387bfd311dd606b0473aa7a8434e46116dc`。该目录下保留每轮完整 Harness run.json 与图检查点；克隆后运行命令生成自己的记录。

| 后端 | max_model_requests | 验收完成率 | 每轮模型请求 | 每轮工具调用 | 重复调用总数 | 耗时中位数（ms） |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 原 Harness | 8 | 3/3 | 2 | 1 | 0 | 236 |
| LangGraph | 8 | 3/3 | 2 | 1 | 0 | 239 |
| 原 Harness | 1 | 0/3 | 1 | 1 | 0 | 239 |
| LangGraph | 1 | 0/3 | 1 | 1 | 0 | 253 |

全部工具轨迹为 calculate(multiply, 123, 456) → 56088。正常预算各轮 synthetic tokens 30、故意失败档 15；这是模拟响应的计数，**不是真实模型用量**。没有模型 API 成本，成本字段为 null。耗时是本机观测，包含 Python 启动、执行及图持久化；样本少且存在冷启动/调度差异，不能声称加速、降低费用或提高真实模型成功率。合并两档为每组 3/6，其中一半专门测试预算失败，不能作为真实任务成功率。

## 真实付费模型验证（用户追加授权后）

模型配置 `deepseek-flash`，真实 API、真实 Vercel SDK 和真实 Python calculate；不使用 fixtures。两组配置完全相同，只切换任务阶段编排。原预算档 max_model_requests=8（max_steps 等其余配置不变），故意失败档仅改为 1；每档两组各重复三次，顺序交替，合计 12 轮任务。用 `npm run verify:langgraph:real` 可重复，但会再次产生模型用量。

| 后端 | max_model_requests | 验收完成率 | 每轮模型请求 | 每轮工具调用 | 每轮真实 tokens | 端到端耗时中位数（ms） | Harness 执行耗时中位数（ms） |
| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: |
| 原 Harness | 8 | 3/3 | 2 | 1 | 1804 / 1808 / 1812 | 2259 | 2035 |
| LangGraph | 8 | 3/3 | 2 | 1 | 1804 / 1804 / 1806 | 2612 | 1657 |
| 原 Harness | 1 | 0/3 | 1 | 1 | 868 / 868 / 868 | 1099 | 865 |
| LangGraph | 1 | 0/3 | 1 | 1 | 868 / 868 / 868 | 1076 | 829 |

合计 **18 次真实模型请求、12 次 calculate、16046 tokens**（prompt 14976、completion 1070）。API 报告 prompt_cache_hit_tokens 合计 11884、prompt_cache_miss_tokens 3092。保留每次 provider usage；未掌握账户实际计价和账单，不推算金额，model_cost 为 null。

逐份人工核对六份成功答案：均正确给出 123×456=56088，包含步骤/运算输入/工具结果表格，且与真实工具证据一致。全部 12 轮工具轨迹均为一次 calculate(multiply, 123, 456) → 56088；重复工具调用 0。预算不足六轮均保留计算证据，错误为“已达到每轮模型请求总数上限（含视觉工具）”，无最终答案，不被记为完成；本实验未使用视觉工具。

LangGraph 正常预算三轮均在关闭图实例后，由独立新 Node 进程批准并完成 delivery.md，再由另一新进程回读终态。三轮均只有一个 Harness 目录，模型/工具计数未变，delivery.md inode/mtime 未变。这里验证真实模型结果的跨进程审批恢复与终态回读；检查点提交前的强制进程退出测试仍采用前述 mock 模型故障注入，不能说真实模型运行已覆盖所有崩溃点。

端到端时间包含 Python 启动、图持久化和 LangGraph 组的两个恢复子进程；Harness 执行时间取 run.json 的 started_at/finished_at。两列口径不同，样本只有三次，真实服务延迟和缓存命中会变化，且未锁随机种子；不能把耗时或少量 tokens 差异归因于框架改善。正常预算两组均 3/3，只说明该固定算式流程接入后保持正确，不证明复杂任务成功率提升。

原始证据：[comparison.json](langgraph-runs/real-ulWYeA/comparison.json)（Git 忽略，本机文件），每轮完整 run.json、LangGraph SQLite、receipt 和交付文件位于同目录的独立子目录。comparison.json SHA-256：`8f5c40c58f980a6d1150615bebd1bd0e49c4bc5bd01eea8b1f3558d5ccea1a0f`。最后完成标记 finished.json 存在。真实记录额外附入 executor_elapsed_ms，来自各轮保存的实际时间戳，不是模拟延迟。

真实脚本 TypeScript 检查通过；原有 114 项 TypeScript 和 84 项 Python 的离线回归结果仍见上文。未修改执行器、工具、预算实现或原测试，未推送、部署或上传 LangSmith。

## 未验证与下一步

- 已完成固定算式的真实 DeepSeek 配对验证；尚未验证多步计算、工具错误或复杂任务。后续应扩大任务集，明确额度后再做付费实验。实际金额仍需账户账单核对。
- 未实现执行器内部的模型步/工具步恢复、共享预算跨工具步持久化、TaskCenter 队列恢复或多进程抢占。
- 外部副作用需要具体工具的幂等键/事务支持后才能扩展，不能把文件幂等经验推广为任意 API 的 exactly-once。
- LangChain core 为 LangGraph 的依赖；此次没有使用 LangChain ChatModel、Agent 或 LangSmith。可如实说明 LangGraph 使用经验，不能声称完成 LangChain 全栈迁移。
- 原 offload-recovery-validation 长文严格验收仍为 **0/4**。框架接入没有修复该问题，原上下文默认策略与评分不变。

## 可以如实写进简历

“在 Python/TypeScript Agent Harness 中引入 TypeScript LangGraph 任务阶段编排，复用现有 Vercel 模型循环、Pydantic 工具和预算控制；实现条件验收、SQLite 检查点、人工审批暂停与跨进程恢复，通过执行结果复用和幂等文件交付避免恢复时重复执行。新增 8 项确定性及进程故障注入测试，完成同任务同预算的离线及真实 DeepSeek 配对验证。”

面试可展示 LangGraph 状态/节点/条件边、为什么选择任务阶段集成、interrupt 节点重入、检查点与副作用不是一个事务、结果不确定时为何停止，以及 mock 与真实模型证据的区别。不要写“提升成功率”“生产级 exactly-once”“解决长上下文”或“模型请求中断后无损恢复”。

运行说明与官方来源见 [LANGGRAPH.md](../vercel_agent/LANGGRAPH.md)。
