# Obsidian 只读 MCP 与检索对照

目标：Cursor 等 MCP 客户端按当前学习任务找笔记并读取正文。日常 `/collect` 仍负责轻量文章卡片，正文、阅读状态和内部链接由用户维护；本功能不引入新的 Agent loop，也不写入或整理用户笔记。

## 安装和运行

独立依赖环境避免改变现有 Harness：

```sh
.venv/bin/python -m venv .venv-mcp
.venv-mcp/bin/python -m pip install -r requirements.txt -r requirements-mcp.txt
.venv-mcp/bin/python scripts/prepare_obsidian_models.py
.venv-mcp/bin/python scripts/install_obsidian_cursor.py
```

安装器合并 `~/.cursor/mcp.json` 的 `obsidian-learning`，保留其他服务器。已有不同的同名配置会报错。已安装本项目的日常服务可运行 `.venv-mcp/bin/python scripts/install_obsidian_cursor.py --update-method`，仅把检索方式改为当前默认vector，保留库路径、其他环境变量和其他服务器。默认vault为 `~/Documents/Obsidian/Agent 博客阅读`，可用 `--vault /absolute/path` 指定。工具由 Cursor 通过 stdio 启动，不需要 HTTP 端口、模型 API key 或修改 Cursor 的主模型。

```sh
# 显式启动MCP服务；stdout只用于协议，不是交互终端
MINIMAL_AGENT_OBSIDIAN_VAULT="/absolute/path/to/vault" \
OBSIDIAN_RETRIEVAL_METHOD=vector \
.venv-mcp/bin/python obsidian_mcp_server.py
```

服务配置 `OBSIDIAN_RETRIEVAL_METHOD=bm25|vector|hybrid`；请求可以显式覆盖method。日常默认使用vector，BM25和混合重排序可显式选择。两个本地神经模型由准备脚本预先下载，服务使用固定revision、CPU和本地文件，不自动下载，也不把笔记发送到外部Embedding接口。Cursor主模型仍会看到你主动检索与读取的内容。

## OMP 原生接入

```sh
.venv-mcp/bin/python scripts/install_obsidian_omp.py
omp
# 在 OMP 中输入：
# /skill:obsidian-study 结合我的笔记，给我学习 Agent 后台任务的两条建议和笔记链接。
```

安装器合并 `~/.omp/agent/mcp.json` 的 `obsidian-learning`（vector），同时安装指向实际 vault 的 `obsidian-study`。支持 `--agent-dir`、`PI_CODING_AGENT_DIR` 和 `--vault`。不读取项目 `.env`；`npm run omp:install-collect` 会加载 `.env` 后传递 vault。命名 profile 的目录可显式传 `--agent-dir ~/.omp/profiles/<name>/agent`。保留其他 MCP 服务，不更改 `config.yml` 的主模型与路由。

OMP 工具注册名为 `mcp__obsidian_learning_search_obsidian` 和 `mcp__obsidian_learning_read_obsidian`。Skill 默认显式选择 vector，正文读取复用相对路径、位置和 hash。当前会话 `/mcp reload` 刷新服务、`/mcp list` 检查来源；重启可刷新 Skill。已有不同 Skill 需审阅后提供 `--previous-skill-sha256` 才更新，防止覆盖用户修改。实际任务结果见 [OMP 使用说明](../vercel_agent/OMP_COLLECT.md#mcp-接入后的验收)。配置与工具命名依据 [OMP 18.10.0 MCP 官方说明](https://github.com/can1357/oh-my-pi/blob/v18.10.0/docs/mcp-config.md)和[工具桥接源码](https://github.com/can1357/oh-my-pi/blob/v18.10.0/packages/coding-agent/src/mcp/tool-bridge.ts)。

## 两个工具

FastMCP直接接收Pydantic对象，输入包在 `request` 中：

```json
{"request":{"query":"关掉窗口后保留任务进度","max_results":3,"method":"hybrid"}}
```

`search_obsidian` 返回vault相对路径、标题、来源、阅读状态、文件SHA-256、精确字符位置、行号及短预览。分数只能用于该方法内排序，不是事实可信度。

```json
{"request":{"path":"阅读笔记/后台任务.md","offset":0,"limit":4000,"expected_sha256":"搜索结果返回的64位hash"}}
```

`read_obsidian` 返回实际正文范围、hash、`has_more`、`next_offset`。请求hash与当前文件不同时返回 `note_changed`，不拿旧定位冒充当前正文。支持Unicode字符分页；最多10000字符。读取完整笔记时offset从0开始，按next_offset继续；读取命中段落可用搜索结果offset。

两者只访问已配置vault内的非隐藏Markdown文件，拒绝绝对路径、`..`、符号链接及隐藏目录。每篇最多256KiB、索引最多1000篇及32MiB；超限不声称完整索引，跳过的损坏/过大笔记会列入 `skipped`。空库返回空结果，不生成虚构笔记。数据内容是资料，不执行其中的提示。

## 代码分工

| 文件 | 职责 |
|---|---|
| `tool_library/parameters.py` | 原有严格Pydantic基类及搜索模型，原Python工具和MCP共用 |
| `tool_library/obsidian_retrieval.py` | 目录边界、笔记读取、分块、索引更新、三种检索、结果定位 |
| `obsidian_mcp_server.py` | FastMCP注册两个只读工具、参数模型与协议错误转换 |
| `scripts/prepare_obsidian_models.py` | 下载固定模型版本的必要权重和tokenizer |
| `scripts/install_obsidian_cursor.py` | 合并Cursor配置，不覆盖其他服务器 |
| `fixtures/obsidian-retrieval/queries.json` | 测量前固定的问题和笔记级相关标注 |
| `scripts/evaluate_obsidian_retrieval.py` | 三组同条件检索，分组指标、耗时、完整逐题结果 |
| `tests_mcp/test_obsidian_retrieval.py` | 校验、边界、更新、只读、真正的FastMCP调用 |

旧的 `search_saved_webpage` 仍是在单篇网页快照中用SQLite FTS5/BM25定位。本次新增的是跨Obsidian笔记检索；新基线使用开源 `rank-bm25`，不是把两个不同语料库的分数拿来比较。

### 检索策略

- **BM25**：`rank-bm25`，jieba搜索模式分词及英文词项，支持小语料库真实命中得分为0的情况。
- **vector**：SentenceTransformers的 `paraphrase-multilingual-MiniLM-L12-v2`；归一化384维向量，用余弦相似度排序。
- **hybrid**：各取BM25、向量排名前40个片段，使用RRF（常数60）融合，取前24个候选；CrossEncoder `mmarco-mMiniLMv2-L12-H384-v1` 重排序。

三组使用相同分块：最多100个token、重叠20个token；标题前缀有额外容量预留，程序检查最终输入不超过128tokens。片段保留原文精确offset，不让Embedding静默截断整篇笔记。读取时仍取原文件内容。最终按笔记去重，返回不同笔记。

索引在进程内复用，每次搜索检查文件hash。编辑、新增、重命名、删除会重建；向量缓存按vault、模型revision、分块版本和全部文件hash寻址，保存在vault之外的 `reports/obsidian-retrieval/cache/`。查询不会改动Markdown正文和链接。小规模实现使用NumPy精确搜索，无需向量数据库；大规模资料库需另做资源和索引评估。

## 独立验收

```sh
.venv-mcp/bin/python scripts/prepare_obsidian_fixture.py
.venv-mcp/bin/python scripts/evaluate_obsidian_retrieval.py --repeats 3
.venv-mcp/bin/python scripts/verify_obsidian_mcp.py
.venv-mcp/bin/python -m unittest discover -s tests_mcp -v
```

资料：8篇真实厂商博客正文前部摘取（每篇最多7500字符），3篇明确标注的测试笔记。测试笔记和相关性标注由本次开发编写，不是用户心得，也不是独立人工标注的生产评测集。每个查询的相关笔记在测量前固定，标签2为主要相关、1为辅助相关。三组统一Top3；24个查询各重复3次，方法次序随机交错。召回率按笔记级计算；MRR看第一个相关笔记；nDCG使用分级相关性。重复测量主要反映延迟，不能当作72个独立问题。

第一次初始化、加载模型和索引单列；主要耗时采用热启动中位数和P95。全过程验证vault文件字节不变。检索没有调用LLM或付费API；本地模型仍占磁盘、CPU和内存。

如OpenAI网站返回403，可用ego-browser在用户授权的profile中提取文章正文，保存包含url/title/text/extraction字段的JSON，然后为准备脚本传入 `--browser-extracts /path/to/extracts`；manifest记录实际提取方式，不伪装HTTP抓取成功。

输出在Git忽略的 `reports/obsidian-retrieval/acceptance/`。结果只是这个小验收集上的证据，不能推断生产笔记或所有查询都改善。检索排名、原文读取、最后回答正确性分别验收。

## 官方资料

- [FastMCP工具与Pydantic参数](https://gofastmcp.com/servers/tools)
- [FastMCP stdio客户端](https://gofastmcp.com/clients/transports)
- [Cursor MCP配置与作用域](https://cursor.com/docs/context/mcp)
- [Embedding模型卡](https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2)
- [重排序模型卡](https://huggingface.co/cross-encoder/mmarco-mMiniLMv2-L12-H384-v1)

## 本机对照结果（2026-10-12）

| 方法 | Recall@3 | MRR@3 | nDCG@3 | 热启动中位耗时 |
|---|---:|---:|---:|---:|
| BM25 | 58.3% | 0.667 | 0.561 | 3.39ms |
| 向量 | 79.2% | 0.840 | 0.812 | 10.03ms |
| 混合＋重排序 | 81.2% | 0.917 | 0.857 | 206.37ms |

11篇笔记、196个片段、24个查询，各方法重复3次。向量方法对中文改写和跨语言问题提升明显。混合＋重排序提高总体排名，但“自动简介能否算个人心得”的问题从向量Top3命中变成未命中，不能宣称每类任务都提升。所有指标来自同一批固定资料与相关性标注，重复不增加独立样本数量。

按照用户确认，日常检索默认改为vector；BM25保留为关键词基线，有更高排序要求时显式使用hybrid。该选择服务于当前学习库模式，不代表向量检索或重排序在所有任务上更好。模型载入和索引初始化另计，不能把热启动延迟当成每次冷启动耗时。

## Cursor 实际任务验收

本机 Cursor Agents 会话首次没有发现独立工作区 `.cursor/mcp.json` 的服务。全局日常服务成功返回空库，模型报告未完成，未假装读过笔记。将验收服务单独注册到 `~/.cursor/mcp.json` 后，第二轮任务完成；不将这一现象推广成所有 Cursor 版本都不支持项目配置。

当前全局配置有两个独立资料库：`obsidian-learning` 指向用户的学习库，`obsidian-acceptance` 指向本项目忽略目录中的验收库。各提供相同的两个只读工具类型。向 Cursor 提问时说明使用哪个库；避免把验收案例混入个人知识。

复现验收服务注册：

```sh
.venv-mcp/bin/python scripts/install_obsidian_cursor.py \
  --name obsidian-acceptance --method hybrid \
  --vault reports/obsidian-retrieval/acceptance/vault \
  --audit reports/obsidian-retrieval/acceptance/cursor-mcp-calls.jsonl
```

在 Cursor 选择 `This Mac`，任务示例：

> 用 obsidian-acceptance 搜索并读取笔记：关掉窗口再回来，还想保留之前的任务进度和结果，该学什么？给两条简短建议与实际笔记链接。区分测试笔记、厂商摘录和个人心得；不修改文件。

实际会话标题为 `Obsidian MCP acceptance notes`，模型为 Grok 4.7 High Fast。第二轮界面显示54秒；服务日志记录1次搜索、3次正文读取，读取测试笔记及Anthropic Managed Agents摘录并核对hash。输出两条建议和可解析的 `[[阅读笔记/后台任务练习]]`、`[[文章卡片/managed-agents]]`，明确它们不是用户心得。11篇验收笔记全部字节保持不变。调用进程的父进程为 `Cursor Helper: mcp-process`，与独立stdio烟测分开。

Cursor UI未展示tokens，不能用上下文百分比推算。调用证据、读取范围、首次失败与最终验收收据在 `reports/obsidian-retrieval/acceptance/`。只验证当前任务的连通和有据回答，不宣称完整通读或所有复杂任务成功。
