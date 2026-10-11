# 工具与运行机制详解

本页保留工具参数、数据边界、网页回查、预算与旧笔记示例等实现细节。项目概览与首次运行见 [根目录 README](../README.md)。命令以仓库根目录为起点，进入 SDK 目录的命令会明确标注。

## 默认工具

| 工具 | 参数 | 返回内容 | 实现 |
| --- | --- | --- | --- |
| `web_search` | `query`，可选 `max_results`（1–5，默认 3） | 实际 `provider`、`attempts`、标题、URL、摘要 | Tavily 官方 SDK 的 keyless 模式 → DuckDuckGo → Yahoo，无需搜索密钥 |
| `read_webpage` | `url` | 最终 URL、标题、正文、`truncated`、`document_id`、`content_format`、`available_formats` | HTTPX 下载，Trafilatura 召回优先提取，同一结构树生成 Markdown 与文本 |
| `read_saved_webpage` | `document_id`，可选 `offset`、`limit`、`content_format` | 所选格式片段、来源 URL、字符范围、`next_offset`、`has_more` | 本地快照回查，不重新下载 |
| `calculate` | `operation`、`a`、`b` | 运算及结果 | Python 有限数值算术 |
| `read_data` | `url` 或 `text`，`data_format`，可选 `json_pointer`、`columns` | 本轮 `dataset_id`、解析格式、来源、分页数据 | 标准库 JSON/CSV 解析，不写数据文件 |
| `query_data` | `dataset_id`，可选筛选、排序、统计、分页、`output_format` | JSON/CSV 转换结果或全量匹配记录统计 | 本轮内存查询，不重新下载、不执行任意代码 |
| `analyze_image` | `image_source`、`question` | 图片来源及文字分析 | DeepSeek Responses API 图片输入 |
| `save_obsidian_blog` | `document_id`、`summary`、`takeaway`、`evidence_quote` | 实际保存路径、回读核验、文件 hash | 专属 Obsidian vault 的 Markdown 写入 |

`calculate` 支持 `add`、`subtract`、`multiply`、`divide`，通过注册表调用时拒绝数字字符串、布尔值、NaN、无穷大和多余参数。除零、结果溢出返回明确的工具错误。多步算式由 Agent 分步调用，无任意代码执行。

数据任务先 `read_data`，然后用返回的 `dataset_id` 调用 `query_data`。下载最多 2 MiB，CSV/选中数组最多 20000 行，本轮最多 8 份数据；仅 UTF-8（支持 BOM）。CSV 必须有不重复的表头，保留字符串、空字段、引号和换行；NOAA 等带开头注释的文件显式传 `comment_prefix="#"`。JSON 用 `json_pointer` 选中嵌套数据，例如世界银行 `/1`。`columns` 选字段，`output_format="csv"` 转为 CSV；null/嵌套值明确拒绝有损转换。筛选条件全部 AND，CSV 精确匹配用字符串，数值大小用 `gt/ge/lt/le`；数值排序设置 `numeric_sort=true`。`aggregate=count/sum/mean/min/max` 在全部匹配行上执行，分页不影响统计；数值统计拒绝缺失值、布尔值和非数值文本，小数结果另附 `decimal_value`。

返回最多 10000 字符，默认 5 行、最多 100 行；内容过大时缩小页并提供 `next_offset`，不裁切单元格。初次预览的单条记录过大时返回 `structure` 和 `preview_omitted`，仍保留数据 ID，后续选列或缩小 JSON 路径查询；不重复下载。原始数据仅保留在当前 RunContext 内存，下一任务释放，不能跨任务使用旧 ID；上下文压缩保留 ID、来源和分页位置，可继续查询。工具本身不写文件；Harness 仍按已有设计写运行记录。Vercel 工具目录的 [Python Code Execution](https://ai-sdk.dev/resources/tools/code-execution) 需要额外 Sandbox 凭据，本次采用标准库解析并复用共享桥接，未安装云端执行工具。

搜索优先使用 `tavily-python==0.8.5` 官方 SDK 的免费 keyless 模式；失败时再尝试 DuckDuckGo 和 Yahoo，每项最多一次。显式空 key 防止 SDK 自动读取环境中的 Tavily 付费凭据；不发送 Authorization。固定 basic 搜索，关闭自动生成答案和完整原文，只映射标题、URL、摘要。每个引擎请求超时最多 5 秒，并受剩余运行时间限制。`provider` 标明实际成功的引擎，`attempts` 记录各次状态；一次工具调用最多包含三次引擎请求。失败引擎在本轮任务内暂停请求，下一轮重新尝试。Tavily keyless 限流的有效 `retry_after_seconds` 会写入尝试记录，但本轮不等待或反复请求。全部服务失败时返回 `search_unavailable` 和 `retryable=false`，工具描述要求模型停止重复搜索。正常空列表与服务失败分别记录，不能把验证页当作原文没有信息。仍沿用每轮 8 次工具调用上限。

Tavily 的免费 keyless 模式支持搜索但有速率限制；DuckDuckGo、Yahoo 使用已有 DDGS 对公开搜索页面的访问。无需新账号或搜索密钥，不保证外部服务始终可用。两版 Loop 共用这项改进。运行 `cd vercel_agent` 后执行 `npm run verify:search`，可验证真实的“搜索 → 读两篇官方文章 → 简短描述”任务，阅读输入须来自搜索返回地址；会产生模型用量，完整记录保存到 `reports/search-reliability-runs/`。重新安装 Python 依赖请执行 `.venv/bin/python -m pip install -r requirements.txt`。

Vercel 的工具目录有 `@tavily/ai-sdk`，但核对时最新 `0.5.0` 的 peerDependencies 只声明 AI SDK 5/6，本项目是 AI SDK 7，未强行安装。这里复用官方 Python 搜索 SDK，由现有桥接将统一 `web_search` 暴露给 Vercel Loop；没有重写循环。参考：[Tavily 官方 SDK 的 keyless 模式](https://github.com/tavily-ai/tavily-python#keyless-mode)、[Vercel 的 Tavily 工具目录](https://ai-sdk.dev/resources/tools/tavily)。

搜索返回的是摘要。需要详细总结或验证事实时，再读取来源页面。网页工具只访问公开 HTTP(S) 地址，下载最多 2 MiB，最多返回 10000 字符，最多 3 次跳转，每次跳转重新检查地址。它不会执行 JavaScript，也不会自动登录；受限页面、PDF 和复杂动态页面可能无法读取。

网页读取会补取语义脚注及常见脚注锚点，并在 10000 字符总额度中为补充脚注预留最多 3000 字符（另含标题分隔符）。`footnotes_found` 表示检测到的条目数；`truncated` 只说明提取文本是否被裁切，`false` 不保证完整覆盖网页。`completeness=not_verified` 和 `coverage_note` 明确提醒模型：动态内容、图片及未识别脚注可能缺失。网页 Skill 要求同时检查正文和脚注，并保留评测范围、比较条件、模拟估计等限定。

每次成功读取网页，裁切前的提取正文和补充脚注先保存到 `reports/webpage-snapshots/<document_id>.json`，再向模型返回有界预览和文档 ID。HTML 使用 `favor_recall=True` 优先保留更多内容；从同一次提取的结构树生成 Markdown 与 text，二者存在同一个快照中。默认预览返回 Markdown，text 保留原文措辞供核对，不把两份全文同时送进上下文。ID 由快照内容生成，同一份资料可以跨任务、跨进程回查。快照使用临时文件完整写入后替换，文件不进入 Git。

text 去除加粗和链接目标等格式标记，仍保留列表、表格的组织。Markdown 保留标题层级、列表、表格、加粗及链接。两者都由程序转换，不调用模型改写。召回优先可能增加冗余内容，尚未证明适用于所有网页，完整性仍为 `not_verified`。

`read_saved_webpage` 从 0 开始按字符位置读取，默认最多返回 4000 字符，上限 10000；继续读取使用返回的 `next_offset`。不指定格式时使用快照默认格式，新的 HTML 快照为 Markdown；纯文本页面和旧版快照为 text。传入 `content_format="text"` 核对措辞。`available_formats` 给出各格式的字符总数，切换格式时须重新定位，不能混用 offset。旧快照只有 text，请求不存在的格式返回 `unsupported_format`。

`has_more=false` 表示到达所选格式的快照末尾，`range_complete=true` 表示本次范围覆盖整个所选格式，两者均不保证原网页提取完整。回读计入工具预算，不调用模型或访问网络；未知 ID、越界、损坏快照返回结构化错误。它只接受文档 ID，不接受任意文件路径。跨越 Markdown 加粗或链接标记的引文需要回读 text 后核对；自动检查仍只忽略空白，不自动删除格式符号或放宽措辞匹配。

目前实现资料回查，并修复了两篇实际样本中已发现的六处列表/表格内容遗漏。SDK Loop 和 Harness 已加入累计上下文自动压缩，原 Python 手写 Loop 暂未加入；两版均没有完整会话恢复。当前原文指工具提取的文本，不是原始 HTML。快照会保留在本地，删除文件后相应 ID 无法回读；可用 `MINIMAL_AGENT_WEBPAGE_STORE_DIR` 指定存储目录。

SDK 每次请求前估算当前输入容量（含指令、工具描述和输出预留），达到 12000 时自动生成工作摘要，目标不超过 8500；这是保守估算，不是模型的精确 token 计数。最新任务和系统/Skill 指令完整保留；程序保留文档 ID、来源、格式及回查区间，模型摘要承接事实、约束和未解决事项。压缩先通知用户，无需确认；压缩请求使用 1024 输出上限，计入原有模型次数和时间预算。已执行工具不重跑，成功后下一轮沿用压缩历史。摘要可能遗漏细节，精确事实仍需快照回查。预算不足、摘要截断或无法缩小输入时明确停止，不提交残缺历史。详见 [压缩实现与验证](../reports/context-compaction-validation.md)。

验证“旧上下文移除后回查”，运行：

```sh
cd vercel_agent
npm run verify:recall
```

脚本读取一篇真实博客，关闭原工具进程，在全新上下文中只提供文档 ID 与范围定位，让真实模型回查原文；随后验证不存在的 ID。会产生 DeepSeek 用量，结果写入 `reports/webpage-recall-validation.json`。这是人为精简工作记录的验证，不是自动压缩实现。平时也可通过 `npm run harness -- webpage-reader "回查 document_id <实际ID>，回答我的问题……"` 使用已保存资料；将占位符替换成首次读取实际返回的 ID。

图片输入支持公开 HTTP(S) 图片 URL，或项目 `images/` 目录里的本地 PNG、JPEG、WEBP、GIF。远程图片先下载并检查，再转为 Base64 发给模型；最多 8 MiB、2000 万像素。目录外路径不读取。默认样例 `images/demo-chart.png` 是合成测试图，标注 2024=120、2025=150，预期增长 25%。它不代表真实业务数据。重新生成：

```sh
python examples/create_demo_image.py
```

视觉工具内部单独发一次模型请求，分析后把文字结果交回外层 Loop；不把图片 Base64 写入执行日志。小字、模糊图表可能识别错误，需要和原图核对。

## 阅读代码

已加入 `obsidian-blog-reader` Skill，把已有阅读文件或新博客分析存入独立 Obsidian vault。Skill 负责读取、简化、启发和保存流程；`save_obsidian_blog` 负责实际写文件并回读。默认目录为 `~/Documents/Obsidian/Agent 博客阅读`，可通过 `MINIMAL_AGENT_OBSIDIAN_VAULT` 指定绝对路径。不会覆盖已有笔记；来源取自真实快照，引文须出现在本轮实际读取内容中。

在 `vercel_agent` 中运行 `npm run harness -- obsidian-blog-reader "回查 document_id <实际ID>，简化分析并保存到 Obsidian"`。每次任务一篇，多篇逐篇运行；此 Skill 的 Harness 在工具返回真实保存并回读的收据后结束，无需再请求模型口头确认，语义验收仍为 `needs_review`。`npm run verify:obsidian` 随机从三家厂商各选一篇，真实采集后交给 Skill 分析快照，再检查 vault 中的实际文件，产生模型用量。详见 [实现与验证](../reports/obsidian-skill-validation.md)。

预算验收：在 `vercel_agent` 中运行 `npm run verify:budget -- 2`，比较当前配置的 2 倍与 3 倍上限，每任务重复两次；运行 `npm run verify:budget -- 2 - roomy` 使用相同任务、延后压缩的对照配置。测试三篇论文、一篇博客、六步计算和工具错误恢复，实际请求模型并产生用量。输出目录独立，记录全部成功和失败；`--review-only <实验目录>` 可离线复核。默认交互入口保持原配置，测试配置只作用于本次运行。[预算实验结果与限制](../reports/budget-comparison-validation.md)。

```text
agent.py               对话入口、Agent Loop、失败回滚
runtime.py             每轮预算、模型用量和步骤记录
tools.py              Tool 定义、参数模型、注册表、统一执行
tool_library/
   network.py          网页搜索和读取
   webpage_store.py    提取原文快照、按 ID 和范围回查
   calculator.py       计算
   vision.py           图片校验和视觉模型调用
   errors.py           工具错误
```

阅读顺序：`TOOL_REGISTRY` → `Tool.definition()` 生成给模型的描述和 JSON Schema → `run_agent()` 检查 `tool_calls` → `execute_tool()` 用 Pydantic 校验参数并调用函数 → 根据 `tool_call_id` 写回结果 → 下一次模型请求。

`SYSTEM_PROMPT` 只规定整体行为：按任务需要使用工具、如实处理失败和资料不足、查询来源时不补未经工具返回的链接、把工具内容作为资料。各工具的用途和参数放在工具描述中。失败后的重试或换方法由模型选择，运行次数和超时由代码限制。

成功的对话历史保留在内存中，重启清空。本轮模型请求失败、输出截断且精简恢复失败或达到预算时，终端入口回滚本轮消息，保留之前成功的对话。工具错误作为结构化数据交回模型，模型可以说明失败或选择下一步。

工具结果不是新的指令。答案应引用实际来源；`truncated=true` 时不能声称已读取完整内容。

## 预算与执行记录

每轮最多：

- 5 次外层 Loop 请求。
- 8 次模型请求总计，包含视觉工具内部的请求。
- 8 次工具调用；参数错误和执行失败也计入次数。
- 90 秒总耗时预算，每个新步骤启动时检查；进行中的调用依靠各自超时结束，并非强制取消。

网页/搜索请求超时设置为 10 秒；模型请求超时最多 30 秒，并按剩余预算缩短。主模型最多生成 512 tokens，视觉模型最多生成 768 tokens。Chat Completions 用 `thinking.type=disabled` 关闭推理；Responses 视觉调用用 `reasoning.effort=none`，两种接口的配置不同。

主模型返回 `finish_reason=length` 时，框架自动进入一次精简恢复：保留用户问题和已取得的工具资料，丢弃半截输出，要求重新回答所有问题、保留核心事实及必要限定，省略非必要示例和细节。请求仍使用 512 token 上限，并计入 5 次外层请求、8 次模型请求及时间预算。进入精简模式后若再次截断，或预算不足，就明确报告未完成；截断的工具参数也不会执行。成功后回答开头说明已自动改为精简版，恢复指令不留在下一轮对话中。视觉工具的未完成响应仍作为工具错误处理。

这是重新生成较短答案，不是恢复尚未生成的文字；是否覆盖所有问题仍需验收。精简模式的模型事件标记为 `kind=compact_retry`。验证记录的 `output_truncated` 表示过程中是否发生过截断，即使恢复成功也为 true；`compact_retry_used` 标记是否进入了精简模式，最终是否完成应结合 `answer` 和 `error` 判断。

终端显示每次模型请求、工具参数和结果摘要。最近一轮结构化记录保存在 `reports/last-run.json`，包含模型与视觉请求的用量、工具结果、耗时及运行错误。此文件每轮覆盖，验证脚本则保存整组场景。记录不包含认证头或密钥。

## 验证

本地测试不调用模型或搜索服务：

```sh
python -m unittest discover -s tests -v
python -m pip check
```

激活环境并加载 `.env` 后，真实 API 验证会消耗 DeepSeek 用量：

```sh
python evaluate_agent.py
python evaluate_agent.py --case '看图后计算' --output reports/vision-followup.json
```

默认八类场景：问候、计算、搜索、读网页、搜索后读网页、读图、看图后计算、除零错误。每个场景独立消息历史；模型请求计数和 token 用量包含视觉请求。每个场景结束即保存到 `reports/tool-library-evaluation.json`；可用 `--output` 指定其他文件。返回回答不代表任务一定正确，要核对工具结果、来源和最后结论。人工验证结果见 `reports/tool-library-evaluation.md`。

简化系统提示词后的验证见 `reports/compact-prompt-evaluation.md`。无搜索结果时仍发现模型补充未经核实的链接，来源要求目前依靠提示词，没有代码强制校验。

输出截断后的自动精简恢复验证见 `reports/compact-retry-evaluation.md`。指定网页实测在 512 token 上限内自动恢复，但精简后的事实准确性仍需核对。

## 更换工具集合

新增工具时：写函数 → 定义一个继承 `ToolParameters` 的参数模型 → 注册 `Tool(name, description, parameters, function)`。函数接受业务参数和可选的 `context`；内部调用模型时使用 `context.call_model()`，确保记录用量并共享预算。

Loop 接受 `tool_definitions` 和 `executor`，不依赖具体业务工具。原有笔记工具与笔记文件保留为可选示例，默认不提供给模型。要运行旧场景：

```sh
python evaluate_agent.py --suite notes
```

或在 Python 中注入另一个注册表：

```python
from functools import partial
from tools import NOTE_TOOL_REGISTRY, execute_tool

answer = run_agent(
    client, messages,
    tool_definitions=[tool.definition() for tool in NOTE_TOOL_REGISTRY.values()],
    executor=partial(execute_tool, registry=NOTE_TOOL_REGISTRY),
)
```

示例中的 `client`、`messages` 由调用者提供；系统提示词也需要与该工具集合匹配。旧笔记验证记录留在 `reports/read-note-*`，其步骤次数和提示词反映当时的版本。

## 文档

- [DDGS 项目文档](https://pypi.org/project/ddgs/)
- [Trafilatura Python 用法](https://trafilatura.readthedocs.io/en/latest/usage-python.html)
- [DeepSeek 工具调用](https://api-docs.deepseek.com/guides/tool_calls/)
- [DeepSeek Responses API 与图片输入](https://api-docs.deepseek.com/guides/responses_api/)

接口资料按项目历史验证记录使用。搜索由共享 Python 工具执行，依次尝试 Tavily keyless、DuckDuckGo 和 Yahoo；模型 API 格式兼容不代表提供了托管搜索能力。
