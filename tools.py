import json
import time
from dataclasses import dataclass
from typing import Annotated, Literal

import httpx
from openai import OpenAIError
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError

from runtime import BudgetExceeded, RunContext
from tool_library.calculator import calculate
from tool_library.errors import ToolError
from tool_library.network import read_webpage, web_search
from tool_library.vision import analyze_image
from pathlib import Path

NOTES_DIR = Path(__file__).resolve().parent / "notes"
MAX_NOTE_CHARS = 6000


def search_notes(query):
    """在 notes 目录的 Markdown / 文本文件中搜索关键词。"""
    if not isinstance(query, str) or not query.strip() or len(query) > 200:
        raise ValueError("query 必须是 1–200 字符的非空字符串")
    keywords = query.casefold().split()
    results = []
    for path in sorted(NOTES_DIR.glob("*")):
        if path.is_symlink() or not path.is_file() or path.suffix not in {".md", ".txt"}:
            continue
        with path.open(encoding="utf-8", errors="replace") as file:
            for number, line in enumerate(file, 1):
                if all(word in line.casefold() for word in keywords):
                    results.append({"file": f"notes/{path.name}", "line": number, "text": line.strip()[:300]})
                    if len(results) == 5:
                        return {"results": results}
    return {"results": results, "message": "找到匹配内容" if results else "没有找到匹配内容"}


def read_note(filename):
    """读取 notes 根目录中的一篇笔记，最多返回 6000 个字符。"""
    if not isinstance(filename, str) or not filename.strip() or len(filename) > 200:
        raise ValueError("filename 必须是 1–200 字符的非空字符串")
    relative = Path(filename.strip())
    if relative.parts and relative.parts[0] == "notes":
        relative = Path(*relative.parts[1:])
    if relative.is_absolute() or len(relative.parts) != 1 or relative.suffix not in {".md", ".txt"}:
        raise ValueError("只能读取 notes 根目录中的 .md 或 .txt 文件")
    path = NOTES_DIR / relative
    if path.is_symlink():
        raise ValueError("不能读取符号链接")
    if not path.is_file():
        raise ValueError("笔记文件不存在，可用 search_notes 查找正确的文件名")
    with path.open(encoding="utf-8", errors="replace") as file:
        content = file.read(MAX_NOTE_CHARS + 1)
    return {
        "file": f"notes/{relative.name}",
        "content": content[:MAX_NOTE_CHARS],
        "truncated": len(content) > MAX_NOTE_CHARS,
    }


class ToolParameters(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


class QueryParameters(ToolParameters):
    query: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]


class SearchParameters(QueryParameters):
    max_results: int = Field(default=3, ge=1, le=5)


class WebpageParameters(ToolParameters):
    url: str = Field(min_length=1, max_length=2000)


class CalculateParameters(ToolParameters):
    operation: Literal["add", "subtract", "multiply", "divide"]
    a: float
    b: float


class VisionParameters(ToolParameters):
    image_source: str = Field(min_length=1, max_length=2000, description="images/ 内的本地图片路径，或公开 HTTP(S) 图片 URL")
    question: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1000)]


class NoteParameters(ToolParameters):
    filename: str = Field(min_length=1, max_length=200)


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    parameters: type[BaseModel]
    function: object

    def definition(self):
        return {"type": "function", "function": {
            "name": self.name, "description": self.description,
            "parameters": self.parameters.model_json_schema(),
        }}


TOOL_REGISTRY = {
    tool.name: tool for tool in [
        Tool("web_search", "使用 DuckDuckGo 搜索网页，返回标题、URL 和摘要。需要最新或外部信息时使用；搜索摘要不是完整正文。", SearchParameters, web_search),
        Tool("read_webpage", "读取指定公开网页的正文和可识别脚注。已有 URL 时直接使用。truncated 仅表示提取文本被长度裁切；false 不保证整页完整，须关注 completeness 与 coverage_note。", WebpageParameters, read_webpage),
        Tool("calculate", "精确执行两个数的加减乘除。operation 为 add/subtract/multiply/divide；多步计算可连续调用。百分比增长用 (新值-旧值)/旧值*100。", CalculateParameters, calculate),
        Tool("analyze_image", "阅读图片中的文字、物体、截图或图表，回答 question；看不清的信息应明确标注。需要图片内容时调用。图片路径应由用户提供，或使用公开图片 URL。", VisionParameters, analyze_image),
    ]
}

# 原来的笔记工具作为可选示例保留；默认四工具不依赖 notes/。
NOTE_TOOL_REGISTRY = {
    "search_notes": Tool("search_notes", "搜索本地示例笔记，返回文件名、行号和原文。", QueryParameters,
                         lambda query, context=None: search_notes(query)),
    "read_note": Tool("read_note", "读取 notes/ 根目录中的示例笔记，最多 6000 字符。", NoteParameters,
                      lambda filename, context=None: read_note(filename)),
}
TOOL_DEFINITIONS = [tool.definition() for tool in TOOL_REGISTRY.values()]
TOOL_FUNCTIONS = {name: tool.function for name, tool in TOOL_REGISTRY.items()}


def execute_tool(name, arguments, *, context=None, registry=None):
    """只执行注册的工具：先校验参数，统一返回数据或可展示的错误。"""
    context = context or RunContext()
    registry = TOOL_REGISTRY if registry is None else registry
    context.remaining_seconds()
    if context.tool_calls >= context.max_tool_calls:
        raise BudgetExceeded(f"已达到每轮 {context.max_tool_calls} 次工具调用上限")
    context.tool_calls += 1
    started = time.monotonic()
    event = {"type": "tool", "name": name}
    context.events.append(event)
    try:
        if name not in registry:
            raise ToolError("unknown_tool", "工具未注册")
        if not isinstance(arguments, str) or len(arguments) > 8000:
            raise ToolError("invalid_arguments", "参数必须是最多 8000 字符的 JSON 字符串")
        parameters = registry[name].parameters.model_validate_json(arguments)
        event["arguments"] = parameters.model_dump()
        result = registry[name].function(**parameters.model_dump(), context=context)
    except BudgetExceeded:
        event["stopped"] = "budget_exceeded"
        raise
    except ValidationError as error:
        result = {"error": {"code": "invalid_arguments", "message": "工具参数不符合要求",
                            "details": error.errors(include_input=False, include_url=False, include_context=False)}}
    except ToolError as error:
        result = {"error": {"code": error.code, "message": str(error)}}
    except httpx.HTTPStatusError as error:
        result = {"error": {"code": "http_error", "message": f"外部服务返回 HTTP {error.response.status_code}"}}
    except OpenAIError as error:
        result = {"error": {"code": "model_error", "message": "视觉模型调用失败", "type": type(error).__name__, "status": getattr(error, "status_code", None)}}
    except Exception as error:
        result = {"error": {"code": "execution_error", "message": "工具执行失败", "type": type(error).__name__}}
    finally:
        event["elapsed_seconds"] = round(time.monotonic() - started, 3)
    event["result"] = result
    return json.dumps(result, ensure_ascii=False, allow_nan=False)
