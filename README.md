# 最小工具 Agent

一个终端运行的 Agent Demo：模型提出工具调用，Python 校验并执行，再把结果交回模型。默认提供网页搜索、网页读取、计算器和图片理解；通过更换工具注册表扩展能力。

当前阶段的实现、理解、验证证据与下一步判断见 [学习总结](LEARNING_SUMMARY.md)。

现已增加并行保留的 [Vercel AI SDK 版本](vercel_agent/README.md)：两版共用 `tools.py`，手写版用于理解循环，SDK 版用于比较框架接管循环后的差异。[五组真实模型对比](reports/vercel-sdk-comparison.md)记录了调用次数、Token 和人工验收结果。

现有 Python 环境就绪、Node.js 22+ 已安装时，可直接体验 SDK 版：

```sh
cd vercel_agent
npm ci
npm run chat
```

SDK 入口自动读取项目 `.env`，使用同一个 DeepSeek 密钥。

已加入 [最薄 Harness 的使用与原理](vercel_agent/HARNESS.md)：显式选择 Skill，复用 SDK Loop 和四个工具执行任务，每次保存独立结果与执行记录。在 `vercel_agent` 目录运行 `npm run harness -- --list` 查看可用流程。

当前阶段的实现、理解、验证结论和限制见 [SDK 与 Harness 阶段总结](SDK_HARNESS_SUMMARY.md)。

## 运行

当前 `.venv` 已安装依赖。首次搭建时：

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
cp -n .env.example .env
```

在本地 `.env` 填入 DeepSeek 密钥，然后在项目终端运行：

```sh
source .venv/bin/activate
set -a
source .env
set +a
python agent.py
```

输入 `/exit` 退出。脚本不会自动加载 `.env`；重新开终端时需要再次激活环境并导入配置。`DEEPSEEK_MODEL` 默认 `deepseek-flash`；`VISION_MODEL` 未设置时复用主模型。两者当前使用同一个 DeepSeek 客户端和密钥。

可以依次输入：

```text
你好
请用计算工具计算 123 乘以 456。
搜索 Hugging Face Agents Course 官方入口，给出来源 URL。
读取 https://example.com/，告诉我它的用途。
阅读 images/demo-chart.png，提取两个年份的数值，并用计算工具算出增长百分比。
请用计算工具计算 10 除以 0，如果失败就解释原因。
```

## 四个工具

| 工具 | 参数 | 返回内容 | 实现 |
| --- | --- | --- | --- |
| `web_search` | `query`，可选 `max_results`（1–5，默认 3） | 标题、URL、摘要 | `ddgs`，明确指定 DuckDuckGo，不需要额外搜索密钥 |
| `read_webpage` | `url` | 最终 URL、标题、正文、`truncated` | HTTPX 下载，Trafilatura 提取正文 |
| `calculate` | `operation`、`a`、`b` | 运算及结果 | Python 有限数值算术 |
| `analyze_image` | `image_source`、`question` | 图片来源及文字分析 | DeepSeek Responses API 图片输入 |

`calculate` 支持 `add`、`subtract`、`multiply`、`divide`，通过注册表调用时拒绝数字字符串、布尔值、NaN、无穷大和多余参数。除零、结果溢出返回明确的工具错误。多步算式由 Agent 分步调用，无任意代码执行。

搜索返回的是摘要。需要详细总结或验证事实时，再读取来源页面。网页工具只访问公开 HTTP(S) 地址，下载最多 2 MiB，最多返回 10000 字符，最多 3 次跳转，每次跳转重新检查地址。它不会执行 JavaScript，也不会自动登录；受限页面、PDF 和复杂动态页面可能无法读取。

网页读取会补取语义脚注及常见脚注锚点，并在 10000 字符总额度中为补充脚注预留最多 3000 字符（另含标题分隔符）。`footnotes_found` 表示检测到的条目数；`truncated` 只说明提取文本是否被裁切，`false` 不保证完整覆盖网页。`completeness=not_verified` 和 `coverage_note` 明确提醒模型：动态内容、图片及未识别脚注可能缺失。网页 Skill 要求同时检查正文和脚注，并保留评测范围、比较条件、模拟估计等限定。

图片输入支持公开 HTTP(S) 图片 URL，或项目 `images/` 目录里的本地 PNG、JPEG、WEBP、GIF。远程图片先下载并检查，再转为 Base64 发给模型；最多 8 MiB、2000 万像素。目录外路径不读取。默认样例 `images/demo-chart.png` 是合成测试图，标注 2024=120、2025=150，预期增长 25%。它不代表真实业务数据。重新生成：

```sh
python examples/create_demo_image.py
```

视觉工具内部单独发一次模型请求，分析后把文字结果交回外层 Loop；不把图片 Base64 写入执行日志。小字、模糊图表可能识别错误，需要和原图核对。

## 阅读代码

```text
agent.py               对话入口、Agent Loop、失败回滚
runtime.py             每轮预算、模型用量和步骤记录
tools.py              Tool 定义、参数模型、注册表、统一执行
tool_library/
   network.py          网页搜索和读取
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

接口资料核对日期：2026-10-06。DeepSeek 的 API 格式兼容不代表托管搜索工具可用；这里的搜索由 Python 工具调用 DuckDuckGo 完成。
