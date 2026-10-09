"""有界、确定性的 JSON/CSV 解析与查询，不执行模型生成的代码、不写文件。"""
import csv
import hashlib
import io
import json
import math
import re
from decimal import Decimal, InvalidOperation, localcontext
import httpx

from runtime import RunContext
from .errors import ToolError
from .network import fetch_bytes

MAX_BYTES = 2 * 1024 * 1024
MAX_ROWS = 20_000
MAX_RESULT_CHARS = 10_000
MAX_DOCUMENTS = 8
NUMERIC = re.compile(r"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$")


def _invalid(message):
    raise ToolError("invalid_data", message)


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            _invalid(f"JSON 存在重复字段：{key[:80]}")
        result[key] = value
    return result


def _finite_float(value):
    number = float(value)
    if not math.isfinite(number):
        _invalid("JSON 数字溢出或不是有限数值")
    return number


def _parse(text, data_format, comment_prefix):
    if data_format == "json":
        if comment_prefix is not None:
            raise ToolError("invalid_arguments", "comment_prefix 只适用于 CSV")
        try:
            return json.loads(text, object_pairs_hook=_pairs, parse_float=_finite_float,
                              parse_constant=lambda _: _invalid("JSON 不允许 NaN/Infinity"))
        except (ValueError, RecursionError) as error:
            _invalid("JSON 格式不合法或嵌套过深：" + type(error).__name__)
    if comment_prefix is not None:
        # 只去掉文件开头连续的注释/空行，绝不删除引号内的换行或注释字符。
        lines = text.splitlines(keepends=True)
        first = 0
        while first < len(lines) and (not lines[first].strip() or lines[first].lstrip().startswith(comment_prefix)):
            first += 1
        text = "".join(lines[first:])
    try:
        reader = csv.reader(io.StringIO(text, newline=""), strict=True)
        headers = next(reader, None)
        if not headers or any(not header.strip() for header in headers) or len(headers) != len(set(headers)):
            _invalid("CSV 必须有非空且不重复的表头")
        rows = []
        for row in reader:
            if not row:  # 空白记录不算数据行；字段为空的记录仍保留。
                continue
            if len(row) != len(headers):
                _invalid(f"CSV 第 {reader.line_num} 行字段数与表头不一致")
            if len(rows) >= MAX_ROWS:
                raise ToolError("too_large", f"CSV 超过 {MAX_ROWS} 行上限")
            rows.append(dict(zip(headers, row)))
        return rows, headers
    except csv.Error:
        _invalid("CSV 引号、字段长度或记录格式不合法")


def _select(root, pointer):
    if not pointer:
        return root
    if not pointer.startswith("/"):
        raise ToolError("invalid_pointer", "json_pointer 必须为空或以 / 开头；例如 /1 或 /data/rows")
    current = root
    for raw in pointer[1:].split("/"):
        if re.search(r"~(?![01])", raw):
            raise ToolError("invalid_pointer", "JSON Pointer 转义只允许 ~0 和 ~1")
        key = raw.replace("~1", "/").replace("~0", "~")
        if isinstance(current, dict) and key in current:
            current = current[key]
        elif isinstance(current, list) and re.fullmatch(r"0|[1-9]\d*", key) and int(key) < len(current):
            current = current[int(key)]
        else:
            raise ToolError("missing_path", "JSON Pointer 指定的位置不存在")
    return current


def _number(value):
    if isinstance(value, bool) or value is None or not isinstance(value, (str, int, float)):
        raise ToolError("non_numeric", "数值操作遇到布尔值、null 或非数值字段")
    text = str(value).strip()
    if len(text) > 1000:
        raise ToolError("non_numeric", "数值字段超过 1000 字符精度范围")
    if not NUMERIC.fullmatch(text):
        raise ToolError("non_numeric", "数值操作遇到空值或非数值文本；不会按零处理")
    try:
        number = Decimal(text)
    except InvalidOperation:
        raise ToolError("non_numeric", "数值无法转换") from None
    if not number.is_finite() or abs(number.adjusted()) > 308:
        raise ToolError("non_numeric", "数值不是有限值或超出统计范围")
    return number


def _field(row, column):
    if not isinstance(row, dict) or column not in row:
        raise ToolError("missing_column", f"记录中不存在列：{column[:80]}")
    return row[column]


def _matches(row, condition):
    value = _field(row, condition["column"])
    other, op = condition["value"], condition["operator"]
    if op in {"eq", "ne"}:
        # CSV 字段保留字符串。精确匹配不偷偷改变类型；数字比较用 gt/ge/lt/le。
        same_type = type(value) is type(other) or (type(value) in {int, float} and type(other) in {int, float})
        equal = same_type and value == other
        return equal if op == "eq" else not equal
    left, right = _number(value), _number(other)
    return {"gt": left > right, "ge": left >= right, "lt": left < right, "le": left <= right}[op]


def _csv(rows, columns):
    if any(not isinstance(row, dict) for row in rows):
        raise ToolError("not_tabular", "CSV 输出需要对象记录；用 json_pointer 选中记录数组")
    columns = columns if columns is not None else list(dict.fromkeys(key for row in rows for key in row))
    if not columns:
        raise ToolError("not_tabular", "空表转 CSV 需要指定 columns")
    stream = io.StringIO(newline="")
    writer = csv.writer(stream, lineterminator="\n")
    writer.writerow(columns)
    for row in rows:
        values = [_field(row, column) for column in columns]
        if any(isinstance(value, (list, dict)) or value is None for value in values):
            raise ToolError("lossy_conversion", "CSV 无法无损表示 null 或嵌套对象；请选择简单字段或 JSON 输出")
        writer.writerow(values)
    return stream.getvalue()


def _structure(value):
    if isinstance(value, dict):
        keys = list(value)
        return {"type": "object", "fields": keys[:30], "field_count": len(keys), "fields_complete": len(keys) <= 30}
    if isinstance(value, list):
        return {"type": "array", "length": len(value),
                "first_item": _structure(value[0]) if value and isinstance(value[0], dict) else None}
    return {"type": "scalar", "python_type": type(value).__name__}


def _query(document, dataset_id, *, json_pointer="", columns=None, filters=None, sort_by=None,
           descending=False, numeric_sort=False, aggregate=None, aggregate_column=None,
           offset=0, limit=5, output_format="json"):
    selected = _select(document["root"], json_pointer)
    rows = selected if isinstance(selected, list) else [selected]
    if len(rows) > MAX_ROWS:
        raise ToolError("too_large", f"选中记录超过 {MAX_ROWS} 行上限；用 json_pointer 缩小范围")
    if columns is not None and (not columns or len(columns) != len(set(columns))):
        raise ToolError("invalid_arguments", "columns 必须非空且不重复")
    if (aggregate_column is not None and aggregate is None) or (aggregate not in {None, "count"} and not aggregate_column):
        raise ToolError("invalid_arguments", "sum/mean/min/max 需要 aggregate_column")
    matched = [row for row in rows if all(_matches(row, condition) for condition in (filters or []))]
    result = {"dataset_id": dataset_id, "source_url": document["url"], "format": document["format"],
              "json_pointer": json_pointer, "total_records": len(rows), "matched_records": len(matched)}
    if aggregate:
        if aggregate == "count":
            value = len(matched)
        else:
            values = [_number(_field(row, aggregate_column)) for row in matched]
            if not values:
                raise ToolError("empty_data", "没有匹配行，无法执行数值统计")
            # 防止 Decimal 默认的 28 位精度使大整数求和出现静默舍入。
            with localcontext() as decimal_context:
                decimal_context.prec = 1024
                value = {"sum": lambda: sum(values), "mean": lambda: sum(values) / len(values),
                         "min": lambda: min(values), "max": lambda: max(values)}[aggregate]()
            exact = str(value)
            value = int(value) if value == value.to_integral_value() else float(value)
            if isinstance(value, float) and not math.isfinite(value):
                raise ToolError("numeric_overflow", "统计结果溢出")
            result["decimal_value"] = exact
        return {**result, "aggregate": aggregate, "aggregate_column": aggregate_column, "value": value,
                "scope": "全部匹配记录，统计在分页之前执行"}
    if sort_by:
        keys = [_field(row, sort_by) for row in matched]
        if numeric_sort:
            keys = [_number(value) for value in keys]
        elif any(not isinstance(value, str) for value in keys):
            raise ToolError("non_comparable", "文本排序只接受字符串；数值排序设置 numeric_sort=true")
        matched = [row for _, row in sorted(zip(keys, matched), key=lambda pair: pair[0], reverse=descending)]
    end = min(len(matched), offset + limit)
    page = matched[offset:end]
    if columns is not None:
        page = [{column: _field(row, column) for column in columns} for row in page]
    csv_columns = columns if columns is not None else document.get("columns")
    # 缩小分页，而不截断字符串或删除字段。单条仍太大则明确失败。
    while True:
        output = _csv(page, csv_columns) if output_format == "csv" else page
        response = {**result, "output_format": output_format, "columns": csv_columns,
                    "data": output, "offset": offset, "returned_records": len(page),
                    "has_more": offset + len(page) < len(matched),
                    "next_offset": offset + len(page) if offset + len(page) < len(matched) else None}
        if len(json.dumps(response, ensure_ascii=False, allow_nan=False)) <= MAX_RESULT_CHARS:
            return response
        if len(page) <= 1:
            raise ToolError("result_too_large", "单条记录或表头超过返回上限；使用 columns/json_pointer 缩小字段")
        page = page[:max(1, len(page) // 2)]


def read_data(url=None, text=None, data_format="auto", json_pointer="", comment_prefix=None,
              columns=None, offset=0, limit=5, output_format="json", *, context=None):
    context = context or RunContext()
    if (url is None) == (text is None):
        raise ToolError("invalid_arguments", "url 和 text 必须且只能提供一个")
    if url is not None:
        try:
            raw, url, content_type = fetch_bytes(url, MAX_BYTES, "application/json,text/csv,text/plain")
        except httpx.TimeoutException:
            raise ToolError("network_timeout", "数据下载超时；尚未获取和解析文件") from None
        except httpx.RequestError:
            raise ToolError("network_error", "数据下载失败；尚未获取和解析文件") from None
        if content_type.split(";", 1)[0].strip().lower() in {"text/html", "application/xhtml+xml"}:
            raise ToolError("unsupported_content", "返回的是 HTML 页面，不是 JSON/CSV 数据文件")
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            raise ToolError("unsupported_encoding", "只支持 UTF-8 JSON/CSV；不会用替换字符损坏数据") from None
    else:
        raw, content_type = text.encode("utf-8"), ""
        text = text.removeprefix("\ufeff")
    if len(raw) > MAX_BYTES:
        raise ToolError("too_large", "数据超过 2 MiB 上限")
    if data_format == "auto":
        mime = content_type.split(";", 1)[0].strip().lower()
        if mime == "application/json" or mime.endswith("+json") or text.lstrip().startswith(("{", "[")):
            data_format = "json"
        elif mime == "text/csv" or (url and url.split("?", 1)[0].endswith(".csv")):
            data_format = "csv"
        else:
            raise ToolError("unknown_format", "无法可靠识别格式；显式指定 data_format=json 或 csv")
    parsed = _parse(text, data_format, comment_prefix)
    root, headers = parsed if data_format == "csv" else (parsed, None)
    dataset_id = hashlib.sha256(raw + data_format.encode() + (comment_prefix or "").encode()).hexdigest()
    if dataset_id not in context.data_documents and len(context.data_documents) >= MAX_DOCUMENTS:
        raise ToolError("data_cache_full", "本轮最多保存 8 份数据；开始新任务后释放")
    document = {"root": root, "url": url, "format": data_format, "columns": headers}
    try:
        response = _query(document, dataset_id, json_pointer=json_pointer, columns=columns,
                          offset=offset, limit=limit, output_format=output_format)
    except ToolError as error:
        if error.code != "result_too_large":
            raise
        # 已成功解析但预览太大：返回结构和 ID，模型仍可查询，不必重新下载。
        response = {"dataset_id": dataset_id, "source_url": url, "format": data_format,
                    "json_pointer": json_pointer, "preview_omitted": True,
                    "structure": _structure(_select(root, json_pointer)),
                    "next_action": "数据已解析并在本轮内存中；用 query_data 的 json_pointer/columns 缩小范围"}
        if len(json.dumps(response, ensure_ascii=False)) > MAX_RESULT_CHARS:
            raise ToolError("result_too_large", "数据结构的字段名也超过返回容量；请直接指定路径与列") from None
    context.data_documents[dataset_id] = document
    return response


def query_data(dataset_id, *, context=None, **options):
    if context is None or dataset_id not in context.data_documents:
        raise ToolError("data_not_found", "本轮没有此 dataset_id；请先 read_data。数据不跨轮保存")
    return _query(context.data_documents[dataset_id], dataset_id, **options)
