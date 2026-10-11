# LangGraph 与原 Harness 多步任务对照

日期：2026-10-10。结论：当前接入方式没有显示任务完成率或 token 效率提升；图阶段恢复与交付控制成立，但执行器预算仍是共同限制。

## 对照范围与方法

比较原 MinimalHarness 与 LangGraph 任务阶段外壳；两组内部都是同一个 VercelLoop、DeepSeek provider、PythonBridge 和 calculate。不是两种独立模型循环的比较，不代表 LangGraph 框架的普遍性能。现有图只允许 calculation-audit，因此本次复杂度来自多步依赖、并行可计算分支与错误恢复，没有验证博客长文、网页搜索、JSON/CSV 解析或多工具编排。

真实 deepseek-flash 模型与真实 Python 工具；每项每组重复三次，按重复轮次交换执行顺序，顺序运行，不并发。两组使用相同 Skill、完整任务、temperature=0、模型和配置：max_steps=5、max_model_requests=8、max_tool_calls=8、max_seconds=90、max_output_tokens=512，legacy 上下文阈值12000、目标8500、硬容量64000。没有为 LangGraph 单独扩大预算。temperature=0 不保证服务完全确定。

运行前固定答案与验收：最后一行JSON字段正确，最终数值有真实工具证据、运行完成；错误任务要求实际触发一次除零且随后继续成功计算。reference_intermediate_path 为参考计算路径的附加检查，不将其他正确结合顺序判为失败。人工核对18份成功答案及工具轨迹，数值、单位与错误说明一致。算术验证不是通用语义评分器。

LangGraph 自动批准仅用于已通过固定实验验收的本地 delivery.md；正常交互入口的人工审批规则不变。本次关闭、重开图实例后恢复审批，仍在同一OS进程；不冒称新的跨进程崩溃测试。另跑现有8项 LangGraph 测试全部通过，其中包含原有独立进程恢复用例。

## 逐任务结果

| 任务 | 后端 | 验收通过 | 平均真实 tokens | 总耗时中位数秒 | 模型请求每轮 | 工具调用每轮 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 营业额、增长率与净余额 | 原 Harness | 3/3 | 6927.0 | 6.213 | 5 | 7 |
| 营业额、增长率与净余额 | LangGraph | 3/3 | 6920.3 | 5.742 | 5 | 7 |
| 库存加权单价与剩余数量 | 原 Harness | 3/3 | 5571.7 | 4.968 | 4 | 7 |
| 库存加权单价与剩余数量 | LangGraph | 3/3 | 5571.0 | 4.821 | 4 | 7 |
| 除零错误后继续执行 | 原 Harness | 3/3 | 5966.0 | 5.236 | 5 | 4 |
| 除零错误后继续执行 | LangGraph | 3/3 | 5966.0 | 5.600 | 5 | 4 |
| 九步依赖预算边界 | 原 Harness | 0/3 | 5867.0 | 4.991 | 5 | 5 |
| 九步依赖预算边界 | LangGraph | 0/3 | 5867.0 | 5.179 | 5 | 5 |

三项正常任务每组9/9通过；九步预算边界每组0/3，不把人为超预算任务混入正常完成率。合并总计每组9/12，仅适用于本次构造任务集。

## 正常任务汇总

| 指标 | 原 Harness | LangGraph |
| --- | ---: | ---: |
| 验收通过 | 9/9 | 9/9 |
| 累计真实 tokens | 55394 | 55372 |
| 累计模型请求 | 42 | 42 |
| 累计工具调用 | 54 | 54 |
| 总耗时中位数秒 | 5.236 | 5.410 |
| 执行器耗时中位数秒 | 4.995 | 5.131 |

token差异仅22个（约0.04%），不能解释为节省。两组请求/工具次数相同。总耗时包含Python启动、Harness运行、图启动持久化；LangGraph还含恢复审批、本地交付和终态回读，未包含人类等待时间。执行器耗时由run.json时间戳计算。样本小、服务延迟与缓存未隔离，不能将耗时差异归因为框架加速或减速。

## 失败、恢复与上下文

九步边界均实际执行前五步：100+20=120，乘3=360，减60=300，除5=60，加7=67；随后max_steps=5触发停止，错误“SDK 停在工具步骤，尚无最终答案，本轮未完成”。每轮5次模型请求、5次工具调用、5867 tokens。请求总预算8尚未耗尽，先碰到了外层步数5。最终目标140未完成，LangGraph均not_delivered；没有伪造最终结果或绕过限制。

全部24轮没有上下文压缩，重复工具调用0。九次LangGraph正常结果恢复后模型/工具计数不变，delivery.md回放的inode/mtime不变。预算边界不交付。当前图将整次Harness作为一个execute节点，所以无法从Loop内部第六步续跑，也不会自动规划、增加预算或改变原来的工具策略。

## 用量与验证

24轮累计模型请求114次、工具138次、真实tokens 145968；prompt 132686，completion 13282。保留provider usage及缓存字段；未推算账户实际金额。

TypeScript typecheck通过；现有LangGraph测试8/8通过；git diff --check通过。仅新增对照脚本和本报告/汇总，没有改执行器、工具、默认预算或LangGraph后端，没有commit/push。

## 原始证据与复现

```sh
cd vercel_agent
node --import tsx verify_langgraph_complex.ts
node --import tsx verify_langgraph_complex.ts --stress-only
```

以上会使用已有DeepSeek账号产生真实模型用量。每次新建独立目录，逐轮保存证据。报告链接目标为本机已完成记录，原始目录在Git忽略范围内，不会随仓库克隆。

- [complex-GlcNuf/comparison.json](langgraph-runs/complex-GlcNuf/comparison.json), SHA-256 `84980b99d1f781853bc2196e70c4371f47c36678a35f0244aa865c1fd4f6a3c4`。包含完整配置、答案、轨迹、实际用量、验收和恢复信息；各轮完整run.json与图检查点保存在同目录。

- [complex-ZanUm7/comparison.json](langgraph-runs/complex-ZanUm7/comparison.json), SHA-256 `98f6702b9224f095cd32840e0c69a617310c5cda150e1b9336f21389c67291ee`。包含完整配置、答案、轨迹、实际用量、验收和恢复信息；各轮完整run.json与图检查点保存在同目录。

## 判断

暂不因速度、tokens或完成率而替换原Harness；当前LangGraph可继续承担持久化任务阶段、审批与本地交付。如果目标是改善复杂任务求解，应先把计划、工具执行、核验和恢复拆成可检查的执行阶段，再使用包含阅读、数据和故障的固定任务集与原循环对照；仅给原执行器加外壳不足以改变求解能力。

官方语义参考：[持久化](https://docs.langchain.com/oss/javascript/langgraph/persistence)、[interrupt与节点重入](https://docs.langchain.com/oss/javascript/langgraph/interrupts)。
