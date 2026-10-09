# person agent 并发任务中心验收

日期：2026-10-09。实现基于当前 Harness，按已确认范围管理自己创建的独立任务；主 Agent 统一派发与回收，后台最多并发两项，routine 候选失败最多升级一次。

## 真实模型运行

DeepSeek 主 Agent 实际发布两项任务，自己提出能力/复杂度和验收，再按 auto 规则选择 DeepSeek 与本机 Codex。主 Agent 只有五个调度工具，执行端使用各自原工具和模型循环。

中心目录：`/Users/ashyh666/Documents/Agent-Runs/center/2026-10-09/3f0d8230-2fc6-45d6-a34e-c70b55643445`。

| 任务 | 路由 | 执行区间 UTC | 主Agent最终状态 | 独立核验 |
| --- | --- | --- | --- | --- |
| 12×13 | simple/math → deepseek | 06:25:40.812–06:25:47.007 | completed / agent_reviewed | 真实 calculate(multiply,12,13)，result.md 含156 |
| Node.js JSON转CSV与统计 | simple/coding → codex | 06:25:40.815–06:26:30.360 | completed / agent_reviewed | 实际运行node convert.cjs退出0；CSV两行正确，JSON精确为rows2/sum3 |

两条路由器执行区间重叠 **6.192秒**。这是执行进程区间的重叠，不等于两次模型HTTP请求同时进行了6.192秒。离线测试另外用真实假工作进程的start/end时间线证明实际并发最多两个、第三项排队。

coding 即使被主模型分类为 simple，也选择具备代码与文件执行能力的 advanced 候选。能力优先于粗略复杂度标签，不能只按“简单/复杂”名字选模型。

主 Agent 在数学任务结束时收到通知，获取状态、回读result.md、提交带证据的审阅；在Code任务结束时获取状态并回读result.md、result.csv、stats.json，再审阅和汇报。普通进度没有触发模型。

实际产物：

- [计算结果](</Users/ashyh666/Documents/Agent-Runs/center/2026-10-09/3f0d8230-2fc6-45d6-a34e-c70b55643445/executions/harness/2026-10-09/8ff17f31-156e-4653-a41f-d68aec14d13d/workspace/result.md>)
- [数据转换脚本](</Users/ashyh666/Documents/Agent-Runs/center/2026-10-09/3f0d8230-2fc6-45d6-a34e-c70b55643445/executions/codex/2026-10-09/9887e8cf-c70a-41bd-9ede-a0c324c94202/workspace/convert.cjs>)
- [转换后的CSV](</Users/ashyh666/Documents/Agent-Runs/center/2026-10-09/3f0d8230-2fc6-45d6-a34e-c70b55643445/executions/codex/2026-10-09/9887e8cf-c70a-41bd-9ede-a0c324c94202/workspace/result.csv>)
- [统计JSON](</Users/ashyh666/Documents/Agent-Runs/center/2026-10-09/3f0d8230-2fc6-45d6-a34e-c70b55643445/executions/codex/2026-10-09/9887e8cf-c70a-41bd-9ede-a0c324c94202/workspace/stats.json>)
- [Codex运行验证说明](</Users/ashyh666/Documents/Agent-Runs/center/2026-10-09/3f0d8230-2fc6-45d6-a34e-c70b55643445/executions/codex/2026-10-09/9887e8cf-c70a-41bd-9ede-a0c324c94202/workspace/result.md>)
- [主Agent答复及调度器补齐的完整路径](task-center-final-answer.md)
- [完整原始中心记录](</Users/ashyh666/Documents/Agent-Runs/center/2026-10-09/3f0d8230-2fc6-45d6-a34e-c70b55643445/summary.json>)
- [机器可读核验](task-center-summary.json)

对路由器工作区清单中的七个文件逐一比对字节数与SHA-256，全部一致。独立使用CSV解析器读取两行a=1、b=2；JSON完整对象为rows=2、sum=3。检查Codex原生command_execution事件中确有成功的node convert.cjs调用，不能只凭笔记声称实际运行。

## 请求与用量

| 主Agent阶段 | 模型请求 | 工具调用 | tokens |
| --- | --- | --- | --- |
| 初次分发 | 2 | 1 | 8005 |
| 回收数学任务 | 4 | 3 | 23639 |
| 回收代码任务 | 4 | 5 | 31159 |
| 合计（3个决策轮） | 10 | 9 | 62803 |

DeepSeek执行端另用2次模型请求、1次业务工具、7522tokens。Codex原生input_tokens为94665，其中cached_input_tokens为81792，output_tokens为1099；缓存输入是输入统计的子集，不再额外相加。没有把这些并入父模型请求数。

这轮没有上下文压缩，也没有输出截断重试。因为主 Agent 每次回收都需要获取详情、读取文件、审阅并回复，编排有明显额外开销。此轮证明调用链与任务结果，**没有证明比直接执行更省钱，也没有证明复杂度分类或模型分层最优**。

两项真实任务都在首次执行通过，没有真实触发升级；升级分支的执行、保留和停止规则由下面的离线故障注入验证，不冒充真实模型成功率实验。

## 离线验收

最终版本全部通过：

- TypeScript完整测试106项，类型检查通过。
- Python完整测试84项，依赖一致性检查通过。
- task-coordinator与task-executor两个Skill通过skill-creator的quick_validate，验证依赖仅装在临时目录，没有改项目依赖。
- git diff --check通过。

新增覆盖：

- 真实工作进程的双并发、第三项排队及目录隔离。
- 能力、复杂度、指定路线与不可用候选筛选。
- routine程序验收失败升级一次，两轮文件/原因/用量独立保存。
- 主模型实际回读后的语义拒绝升级；未回读或伪造已读证据拒绝。
- 两次失败停止；advanced初次失败停止；时限不足停止；取消不升级。
- 取消一个进程树不影响其他任务，忽略SIGTERM的子进程也被清理。
- 相同key复用；整批预检；消息cursor不重复；不可读其他中心任务。
- JSON Pointer精确值与对象键顺序；修改文件与符号链接拒绝。
- 真实Vercel SDK → Python参数校验 → Unix IPC → 原TaskRouter → 假执行CLI → 回读和审阅。
- 主模型串行、工作进程并行、进度不唤醒模型；主模型提交后一次错误不会重新启动工作，完成通知仍能触发审阅。
- 压缩保留task_id、attempt_id、文件hash和分页索引；执行端不继承中心凭据。

## 已修复的展示问题及边界

真实运行中主模型把部分长文件路径缩写成了省略号。保留原回答后，新增应用层展示从实际收据补齐完整路径，不再依赖模型复述。当前展示函数已对上述真实记录运行，并保存到task-center-final-answer.md；单元测试也核对完整路径。此项修复没有重新请求模型。

没有改写原Agent Loop；本轮新增后台TaskCenter、对话事件外壳、五个IPC工具和两份Skill，并扩展原路由器事件观察接口。默认npm run person进入新中心，旧流程改用npm run person:delegate。没有新增项目包、自动接管已有会话、后台常驻、崩溃恢复或金额硬上限。

退出时取消活动任务并保存产物；尚未审阅的任务不能变成completed。agent_reviewed是主模型判断，程序验收与hash也不保证事实正确。基于这一个真实样本不能推断全部任务成功率；图像、长文、多人共享额度和其他Agent接入没有在本轮验证。

运行、限额与代码阅读顺序见 [TASK_CENTER.md](../vercel_agent/TASK_CENTER.md)。
