# Agent Harness：博客知识收集与任务编排

一个基于 **Python、TypeScript、DeepSeek、Vercel AI SDK 和 LangGraph** 的终端 Agent 工程原型。主要场景是读取 AI 厂商博客、提炼有来源的内容与优化启发，并保存为 Obsidian 笔记；统一任务入口还可以把独立工作分配给 DeepSeek Harness 或本机 Codex CLI，收回实际回答、文件和运行记录。

项目从手写 Agent Loop 演进而来，将工具、Skill、上下文维护、预算、调度和验收分开组织。DeepSeek 主 Agent 负责理解任务、提出分类并审阅结果；任务中心按能力、可用性和复杂度规则选择执行端，TaskRouter 负责启动进程、隔离目录、取消和回收产物。当前最多并发两项独立任务，DeepSeek失败后可在条件允许时升级到Codex一次。

保留 Python 手写、Vercel SDK 和 LangGraph 三种循环，以及固定任务下的真实对照记录。定向阅读支持快照全文检索、原文回读、程序验收和可选独立模型核对，但没有证明新框架或额外核对能稳定改善成本与完成率。**模型结束、文件落盘、验收通过和事实正确分别判断，不将框架成功状态当作任务正确性的保证。**

统一交互入口：`cd vercel_agent && npm run person`。单任务入口：`npm run harness -- <skill> "任务"`；可选内部图循环：`npm run harness:langgraph -- <skill> "任务"`。

## 能做什么

| 能力 | 实现与交付 |
| --- | --- |
| 博客阅读与 Obsidian 收录 | 搜索或读取指定网页，保存 Markdown/text 快照，生成简化内容、来源与短引文，写入独立 vault 并回读核验 |
| 工具调用 | 共享九个业务工具，支持网页回查、计算、JSON/CSV 解析查询和图片理解；参数通过 Pydantic 校验 |
| Skill 驱动任务 | 显式加载本地 Skill，以同一套 Loop 执行网页阅读、计算核对、图表增长率等流程 |
| 多执行端编排 | 接入 DeepSeek Harness 与本机 Codex CLI，最多并发两项独立任务，支持取消、结果通知和受限失败升级 |
| 运行控制与观察 | 分别记录模型请求、工具尝试、耗时、tokens 和错误；保存任务上下文、日志、答案和文件清单 |
| 结果验收 | 核对实际来源、逐字引文、文件存在性与 SHA-256；语义正确性仍需人工或主 Agent 审阅 |

## 架构

```mermaid
flowchart TD
    U[用户：终端输入任务] --> H[单任务 Harness：选择 Skill]
    U --> C[任务中心：主 Agent 分配独立任务]
    C --> D[TaskCenter：能力筛选与分层规则]
    D --> R[TaskRouter：启动进程与独立工作目录]
    R --> H
    R --> X[Codex CLI：原生执行循环]
    H --> L[Vercel AI SDK Loop + DeepSeek]
    H --> G[可选 LangGraph 模型/工具节点循环]
    G --> B
    L --> B[JSON Lines 子进程桥接]
    B --> T[Python 工具注册表与参数校验]
    P[Python 手写 Loop：学习与对照] --> T
    T --> S[搜索 / 网页与数据 / 计算 / 视觉 / Obsidian]
    H --> V[运行记录与自动检查]
    X --> V
    V --> A[回读文件、审阅结果、报告缺口]
```

- **Loop** 管理模型与工具反复交互；普通工具错误可返回模型，预算错误必须强制停止。
- **Skill** 描述流程、输出与失败处理。它提供指令，不自动赋予新工具能力。
- **Harness** 组织任务、上下文、预算、日志和交付检查；工具执行仍由共享注册表负责。
- **主 Agent** 根据用户目标填写能力类型、复杂度和验收条件，处理结果通知并回读审阅产物。
- **任务中心** 校验分类字段，在已注册且能力匹配的候选中按规则选择执行端，管理队列与最多一次失败升级。
- **TaskRouter** 接收已选定的执行端，创建工作目录、启动进程、执行超时/取消并收回结果；它不再独立分析任务。

执行端保留各自的模型和工具。主 Agent 的请求预算不能限制 Codex 内部全部用量；当前没有统一金额硬上限。

## 快速开始

推荐在 macOS/Linux 使用 Python 3.11+、Node.js 22+。模型调用需要 DeepSeek API key；Codex 仅在使用其执行端时需要安装并完成登录。Obsidian 用于查看笔记，写入本地 Markdown 不依赖 REST 插件。

### 1. 安装依赖

```sh
git clone https://github.com/ashyh123/agent-harness.git
cd agent-harness
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
cp -n .env.example .env
cd vercel_agent
npm ci
```

仓库当前为私有，克隆需要有访问权限。

### 2. 配置模型

在**仓库根目录**的 `.env` 填写：

```dotenv
DEEPSEEK_API_KEY="你的 API key"
DEEPSEEK_MODEL="deepseek-flash"
VISION_MODEL="deepseek-flash"
```

可选配置 `MINIMAL_AGENT_OBSIDIAN_VAULT` 为专属笔记目录的绝对路径。默认使用 `~/Documents/Obsidian/Agent 博客阅读`。可用模型及视觉输入能力以你的服务账号为准。

SDK/Harness 入口自动读取 `.env`。该文件、依赖目录和原始运行记录已加入 `.gitignore`。

### 3. 跑一个小任务

以下命令均在 `vercel_agent` 目录执行：

```sh
# 列出 Skill，不调用模型
npm run harness -- --list

# 使用真实计算工具；预期结果为 56088
npm run harness -- calculation-audit "计算123乘456，展示工具结果。"

# 多轮工具对话，输入 /exit 退出
npm run chat
```

真实模型任务产生 API 用量。运行结果会打印任务目录、请求次数、工具次数与 tokens。

## 演示流程

### 博客 → 简化分析 → Obsidian

```sh
# 采集三家厂商各一篇博客，分析指定范围，保存并检查实际笔记
npm run verify:obsidian -- 810836465
```

这个入口先真实采集网页，再把快照 ID 交给 `obsidian-blog-reader` Skill，读取 text 前 4000 字符并分析。它会调用模型、写入真实笔记，保存独立验证记录；**这条演示验证的是指定范围分析与收录，不是整篇长文通读。**

输出目录：

```text
~/Documents/Obsidian/Agent 博客阅读/
  阅读笔记/       简化内容、优化启发、逐字引文、来源与实际阅读范围
  提取原文/       网页提取文本快照

reports/obsidian-runs/<本次验证>/
  verification.json    运行状态、真实路径与文件检查
```

在 Obsidian 中打开上述 vault，核对笔记、原文链接和读取范围。用已有快照执行单篇任务：

```sh
npm run harness -- obsidian-blog-reader "处理 document_id <替换为实际快照ID>，简化分析并保存到Obsidian。"
```

快照 ID 来自实际 `read_webpage` 返回，不能直接使用其他机器报告中的 ID。直接提供博客 URL 也支持，但长文在当前预算下可能失败。

### 发布独立任务 → 执行 → 回收与审阅

```sh
# 统一对话入口；支持 /tasks、/cancel <任务ID>、/exit
npm run person

# 一次分配两项独立任务：需要可用的 Codex CLI
npm run person -- "同时处理两个独立任务：用计算工具求12乘13；让具备代码执行能力的Agent编写并运行JSON转CSV脚本。分别回读审阅，给出结果和实际文件路径。"
```

主 Agent 提交任务后，后台最多并发两项；程序验收通过后进入 `awaiting_review`，完成消息唤醒主入口，回读产物并提交审阅判断后才能成为 `completed / agent_reviewed`。

### 执行端如何分配

分配逻辑位于 [selectExecutor](vercel_agent/task_center.ts#L105)，分类指令位于 [task-coordinator Skill](skills/task-coordinator/SKILL.md)。主 Agent 调用 `submit_tasks`，填写 `capability`、`complexity`、可选 `route` 和验收条件；代码先筛选可用且能力匹配的候选，再执行以下规则：

| 条件 | 当前自动选择规则 |
| --- | --- |
| 明确指定 `route=deepseek` 或 `codex` | 遵循指定，仍检查可用性与能力；不匹配时报错 |
| `complexity=complex` 或 `capability=coding` | 优先 advanced，当前为 Codex |
| 其他 simple 任务 | 优先 routine，当前为 DeepSeek |
| 所需分层没有候选 | 使用剩余能力匹配候选中的第一个；没有候选则报错 |

DeepSeek 注册 general/web/data/math/image，Codex 还注册 coding。分类来自主模型，代码不会再次判断任务的真实复杂度；routine/advanced 是配置标签，不代表已验证的价格或成功率。需要编写脚本或任意文件的任务应分类为 coding/advanced，不能因为同属“数据处理”就假定DeepSeek已有对应工具。

执行、程序验收或主 Agent 审阅失败时，首次routine任务可升级到配置中的Codex：须能力匹配、可用、中心未关闭且剩余时间至少5秒。升级交接原目标、失败原因、已有回答与产物索引；advanced首次失败、第二次失败或取消不再升级。不根据历史成功率、实时价格或负载自适应路由。

启动时DeepSeek检查密钥配置，Codex检查CLI可执行文件；这不保证账号登录、额度或服务连接正常。

若需要手动指定执行端：

```sh
npm run router -- agents
npm run router -- run --agent codex "计算(123*456)+789，生成result.json和report.md。" --expect result.json --expect report.md
npm run router -- runs --limit 10
```

记录与产物存于 `~/Documents/Agent-Runs/`，按日期、执行端和任务 ID 分目录。取消与超时会终止相关进程树并保留已有产物。详细入口及状态见 [任务中心](vercel_agent/TASK_CENTER.md) 和 [TaskRouter](vercel_agent/ROUTER.md)。

## 验证证据

最近记录（**2026-10-10**）：143项TypeScript测试、86项Python测试通过，TypeScript类型检查通过。离线测试验证执行机制，不代表真实模型任务都能成功。

| 验证 | 实际观察 | 证据与边界 |
| --- | --- | --- |
| 博客收录 | Anthropic、OpenAI、Google 三篇指定范围分析均生成笔记，核对来源、引文和文件 hash | [验收报告](reports/obsidian-skill-validation.md)；语义仍需审阅，不代表全文总结 |
| 双任务编排 | DeepSeek 完成 12×13，Codex 实际执行 JSON→CSV 与统计；回收文件并审阅，执行进程区间存在重叠 | [任务中心验收](reports/task-center-validation.md)；一个真实样本不证明路由最优或降低成本 |
| SDK 与手写循环 | 相同工具资料下比较请求次数、tokens 与最终答案 | [对照报告](reports/vercel-sdk-comparison.md)；没有证明 SDK 能降低 tokens |
| 上下文恢复 | 修复软目标误停、保护最新工具批次、接入预算内摘要恢复 | [复测报告](reports/offload-recovery-validation.md)；同一长文完整验收仍为 0/4 |

### 最近的阅读策略对照

2026-10-10，在相同deepseek-flash、任务、工具与预算下，对两项博客阅读及JSON/CSV两项数据任务各重复3次，共36次真实运行。下列完成率采用共同严格验收和人工复核，失败运行消耗计入；不是运行时自报通过率。

| 模式 | 严格完成 | 总tokens | 平均每次耗时 |
| --- | ---: | ---: | ---: |
| 原Harness（同样提供检索工具） | 9/12 | 205,202 | 7.19秒 |
| LangGraph：检索＋程序验收 | 8/12 | 256,328 | 8.27秒 |
| LangGraph：检索＋程序验收＋独立模型核对 | 9/12 | 261,027 | 8.99秒 |

关闭模型核对总体tokens下降约1.8%，但严格完成率下降；单看博客组，tokens反而增加约1.9%。数据组均6/6通过，本来不调用核对模型。独立模型核对也漏判一次恢复步骤顺序错误。本批没有证明关闭核对能够保持完成效果并稳定节省预算，样本不足以证明统计等效性，默认执行器保持原Vercel循环，阅读约定入口默认保留semantic核对。

[三组完整报告](reports/evidence-ablation-validation.md)记录任务、预算、验收、基础设施故障批次排除和失败分析；[此前24次阅读对照](reports/evidence-reading-validation.md)单独保留，不混算不同批次。使用方式见[LangGraph说明](vercel_agent/LANGGRAPH.md)。这些定向阅读实验不代表已经解决整篇长论文阅读。

本地验证，从仓库根目录执行：

```sh
.venv/bin/python -m unittest discover -s tests -v
.venv/bin/python -m pip check
cd vercel_agent
npm test
npm run typecheck
```

真实 API 验证入口包括 `verify:search`、`verify:obsidian`、`verify:context` 和 `compare`，会产生模型用量。部分预算与上下文对比脚本依赖 Git 忽略的本机快照/数据清单；克隆仓库后不能直接重放这些实验。报告保留实验控制、结果和限制，原始运行目录中的本机绝对路径也不能在其他机器直接打开。

## 代码导航

| 位置 | 阅读重点 |
| --- | --- |
| [agent.py](agent.py)、[runtime.py](runtime.py) | 手写循环、预算计数、错误传播与用量记录 |
| [tools.py](tools.py)、[tool_library/](tool_library/) | 工具定义、参数模型与共享执行器 |
| [vercel_agent/agent.ts](vercel_agent/agent.ts)、[bridge.ts](vercel_agent/bridge.ts) | SDK 循环、请求前维护与 Python 子进程桥接 |
| [harness.ts](vercel_agent/harness.ts)、[skills/](skills/) | Skill 加载、任务隔离、运行结束与任务验收 |
| [person_cli.ts](vercel_agent/person_cli.ts)、[task-coordinator](skills/task-coordinator/SKILL.md) | 主Agent入口、分类指令、通知和产物审阅 |
| [task_center.ts](vercel_agent/task_center.ts)、[task_router.ts](vercel_agent/task_router.ts) | 能力筛选、分层路由、队列、取消、失败升级与产物回收 |
| [langgraph_loop.ts](vercel_agent/langgraph_loop.ts)、[reading_validation.ts](vercel_agent/reading_validation.ts) | 图内模型/工具循环、程序验收、可选核对及预算内修正 |
| [context.ts](vercel_agent/context.ts)、[working_context.ts](vercel_agent/working_context.ts)、[offload_context.ts](vercel_agent/offload_context.ts) | 默认摘要策略与两种实验策略 |
| [tests/](tests/)、[vercel_agent/tests/](vercel_agent/tests/) | 参数边界、故障注入、真实 SDK/桥接的离线集成测试 |

## 当前限制与下一步

- **长文证据保持仍不稳定。** 已解决的运行阻断不等于完成阅读任务；压缩/移出可能丢失关键事实与引文，模型可能重复回读并耗尽预算。默认仍为 `legacy`，未因局部实验结果切换。
- **网页提取不保证完整。** 当前读取公开 HTTP(S) 页面，不执行 JavaScript、不登录，也不支持 PDF 正文解析；提取快照不等于原始网页全部内容。
- **验收有边界。** 正确 hash、逐字引文和模型审阅都不保证解释正确。单任务 Harness 的 `needs_review`、任务中心的 `agent_reviewed` 均保留人工复核责任。
- **任务中心只管理自己创建的任务。** 目前注册两个执行端，没有自动接管其他会话、后台常驻、定时调度或崩溃恢复。

下一阶段聚焦稳定保存任务关键事实与逐字证据、降低原文定位和重复回读成本，并在固定验收集上比较成功率、用量与失败类型。

## 进一步阅读

- [工具参数、运行预算与扩展方式](docs/TOOLS_AND_RUNTIME.md)
- [SDK Loop 与上下文策略](vercel_agent/README.md)
- [Harness 与 Skill 的运行方式](vercel_agent/HARNESS.md)
- [任务中心](vercel_agent/TASK_CENTER.md) · [手动路由](vercel_agent/ROUTER.md)
- [手写阶段总结](LEARNING_SUMMARY.md) · [SDK/Harness 阶段总结](SDK_HARNESS_SUMMARY.md)
