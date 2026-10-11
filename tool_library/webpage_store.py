"""在模型上下文之外保存提取文本，通过文档 ID 回读；不重新访问网站。"""
import hashlib
import json
import os
import re
import tempfile
import sqlite3
from pathlib import Path

from .errors import ToolError

SNAPSHOT_DIR = Path(os.getenv("MINIMAL_AGENT_WEBPAGE_STORE_DIR",
                            Path(__file__).resolve().parents[1] / "reports/webpage-snapshots"))
MAX_READ_CHARS = 10000
MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024


def search_saved_webpage(document_id, query, max_results=3, *, context=None):
    """SQLite FTS5/BM25 搜索完整 text 快照；只给定位，证据须按范围回读。"""
    if not isinstance(query, str) or not query.strip() or len(query) > 200:
        raise ToolError("invalid_query", "query 必须是1–200字符")
    if type(max_results) is not int or not 1 <= max_results <= 5:
        raise ToolError("invalid_query", "max_results 必须是1–5")
    document = load_webpage(document_id)
    content = document.get("text_content", document["content"])
    tokens = list(dict.fromkeys(re.findall(r"[^\W_]+", query.casefold())))[:12]
    if not tokens:
        raise ToolError("invalid_query", "需要字母、数字或汉字关键词")
    # OR 提高召回；BM25排序。输入只作为转义后的词项，不允许注入FTS运算符。
    expression = " OR ".join('"' + token.replace('"', '""') + '"' for token in tokens)
    with sqlite3.connect(":memory:") as index:
        index.execute("CREATE VIRTUAL TABLE chunks USING fts5(content, start UNINDEXED, stop UNINDEXED)")
        for offset in range(0, len(content), 850):
            index.execute("INSERT INTO chunks VALUES (?, ?, ?)",
                          (content[offset:offset + 1000], offset, min(offset + 1000, len(content))))
        matches = index.execute("SELECT content, start, stop, bm25(chunks) FROM chunks WHERE chunks MATCH ? ORDER BY bm25(chunks), start LIMIT ?",
                                (expression, max_results)).fetchall()
    return {"document_id": document_id, "url": document["url"], "content_format": "text",
            "total_chars": len(content), "query": query, "method": "sqlite_fts5_bm25",
            "matches": [{"offset": start, "end_offset": stop, "preview": text[:250], "score": score}
                        for text, start, stop, score in matches],
            "note": "命中不是完整证据；用read_saved_webpage按text格式回读对应范围。没有命中不证明全文没有答案。"}


def serialized(document):
    return json.dumps(document, ensure_ascii=False, sort_keys=True, allow_nan=False).encode("utf-8")


def save_webpage(*, url, title, content, footnotes_found, coverage_note, text_content=None):
    """内容寻址的快照；先完整写入临时文件，再替换目标，避免半个 JSON。"""
    document = {"version": 1, "url": url, "title": title, "content": content,
                "footnotes_found": footnotes_found, "completeness": "not_verified",
                "coverage_note": coverage_note}
    if text_content is not None:
        document.update(version=2, content_format="markdown", text_content=text_content)
    data = serialized(document)
    if len(data) > MAX_SNAPSHOT_BYTES:
        raise ToolError("snapshot_too_large", "提取文本超过本地快照大小上限")
    document_id = hashlib.sha256(data).hexdigest()
    SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=SNAPSHOT_DIR, delete=False) as file:
            temporary = Path(file.name)
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, SNAPSHOT_DIR / f"{document_id}.json")
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return document_id


def load_webpage(document_id):
    """宿主读取并校验完整快照；不把完整原文自动送入模型。"""
    if not isinstance(document_id, str) or not re.fullmatch(r"[0-9a-f]{64}", document_id):
        raise ToolError("invalid_document_id", "需要 read_webpage 返回的 64 位文档 ID，不能传入文件路径")
    path = SNAPSHOT_DIR / f"{document_id}.json"
    if path.is_symlink():
        raise ToolError("invalid_snapshot", "不能回读符号链接快照")
    try:
        with path.open("rb") as file:
            data = file.read(MAX_SNAPSHOT_BYTES + 1)
    except FileNotFoundError:
        raise ToolError("snapshot_not_found", "该文档快照不存在；请重新读取网页取得新的文档 ID") from None
    try:
        document = json.loads(data)
        if len(data) > MAX_SNAPSHOT_BYTES or hashlib.sha256(serialized(document)).hexdigest() != document_id:
            raise ValueError("invalid snapshot")
        if document["version"] not in {1, 2} or not isinstance(document["content"], str):
            raise ValueError("invalid snapshot")
        if document["version"] == 2 and (document.get("content_format") != "markdown"
                                        or not isinstance(document.get("text_content"), str)):
            raise ValueError("invalid snapshot")
    except (ValueError, TypeError, KeyError):
        raise ToolError("invalid_snapshot", "文档快照损坏或与文档 ID 不匹配") from None
    return document


def read_saved_webpage(document_id, offset=0, limit=4000, content_format=None, *, context=None):
    if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= MAX_READ_CHARS:
        raise ToolError("invalid_range", "offset 必须是非负整数，limit 必须为 1–10000 字符")
    document = load_webpage(document_id)
    formats = {"text": len(document["content"])} if document["version"] == 1 else {
        "markdown": len(document["content"]), "text": len(document["text_content"])}
    selected_format = content_format or document.get("content_format", "text")
    if selected_format not in formats:
        raise ToolError("unsupported_format", "此快照没有该格式；请使用 available_formats 中的格式")
    content = document["text_content"] if document["version"] == 2 and selected_format == "text" else document["content"]
    if offset > len(content):
        raise ToolError("invalid_range", "offset 超过快照文本长度")
    end = min(offset + limit, len(content))
    # 不把另一份全文一起返回模型；需要哪种格式就按范围取哪种。
    metadata = {key: value for key, value in document.items() if key not in {"content", "text_content"}}
    return {**metadata, "document_id": document_id, "content": content[offset:end],
            "content_format": selected_format, "available_formats": formats,
            "offset": offset, "end_offset": end, "total_chars": len(content),
            "has_more": end < len(content), "next_offset": end if end < len(content) else None,
            "range_complete": offset == 0 and end == len(content)}
