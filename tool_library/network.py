"""网页搜索与正文读取；外部服务的结果统一转换为小型 JSON 对象。"""
import html
import ipaddress
import re
import socket
from copy import deepcopy
from urllib.parse import urljoin, urlsplit

import httpx
from requests.exceptions import RequestException
import trafilatura
from ddgs import DDGS
from ddgs.exceptions import DDGSException
from lxml import html as html_tree
from lxml import etree
from trafilatura.xml import xmltotxt
from tavily import TavilyClient
from tavily.errors import (BadRequestError, ForbiddenError, InvalidAPIKeyError,
                           TimeoutError as TavilyTimeoutError, UsageLimitExceededError,
                           TavilyKeylessLimitError)

from .errors import ToolError
from .webpage_store import save_webpage
from runtime import RunContext

MAX_WEB_CHARS = 10000
MAX_FOOTNOTE_CHARS = 3000
SEARCH_PROVIDERS = ("tavily", "duckduckgo", "yahoo")
SEARCH_TIMEOUT = 5
COVERAGE_NOTE = "truncated 仅表示提取文本是否被长度上限裁切；未验证整页覆盖，动态内容、图片及未识别脚注可能缺失。"


def extract_article(data, url):
    """只提取一次，再从同一棵结构树生成文本与 Markdown，避免两次提取内容不同。"""
    document = trafilatura.bare_extraction(data, url=url, favor_recall=True,
                                         include_comments=False, include_tables=True,
                                         include_formatting=True, include_links=True)
    if document is None or document.body is None:
        return None, None
    # 使用项目固定版本 Trafilatura 的格式转换器；不会让模型改写原文。
    # TXT 转换仍可能生成链接语法；仅在文本副本中解开 ref，保留链接文字。
    text_tree = deepcopy(document.body)
    etree.strip_tags(text_tree, "ref")
    return xmltotxt(text_tree, False), xmltotxt(document.body, True)


def extract_footnotes(data):
    """补取正文算法容易过滤的语义脚注和常见脚注锚点；不执行网页脚本。"""
    root = html_tree.fromstring(data)
    for element in root.xpath('//script | //style | //template | //svg'):
        element.drop_tree()
    candidates = root.xpath('//*[@role="doc-footnote" or @role="doc-endnote"] | '
                            '//*[@role="doc-endnotes"]//li | //li[@id] | //div[@id]')
    notes = []
    seen = set()
    for node in candidates:
        identifier = node.get('id', '')
        semantic = node.get('role') in {'doc-footnote', 'doc-endnote'} or node.xpath('ancestor::*[@role="doc-endnotes"]')
        if not semantic and not re.match(r'^(?:citation-bottom-\d+|footnote[-_]?\d+|fn[-_]?\d+)$', identifier, re.I):
            continue
        text = ' '.join(' '.join(node.itertext()).split())
        if text and text not in seen:
            notes.append(text)
            seen.add(text)
    return notes


def validate_url(url):
    parts = urlsplit(url)
    if parts.scheme not in {"http", "https"} or not parts.hostname or parts.username or parts.password:
        raise ToolError("invalid_url", "需要不含账号密码的公开 HTTP 或 HTTPS URL")
    try:
        addresses = socket.getaddrinfo(parts.hostname, parts.port or (443 if parts.scheme == "https" else 80))
    except (OSError, ValueError):
        raise ToolError("network_error", "无法解析网页主机地址") from None
    if not addresses or any(not ipaddress.ip_address(address[4][0]).is_global for address in addresses):
        raise ToolError("invalid_url", "此工具只访问公开互联网地址")


def fetch_bytes(url, max_bytes, accept):
    """有大小、超时和跳转上限；每一次跳转都重新检查 URL。"""
    with httpx.Client(timeout=10, follow_redirects=False, headers={"User-Agent": "MinimalAgentDemo/1.0", "Accept": accept}) as client:
        for _ in range(4):
            validate_url(url)
            with client.stream("GET", url) as response:
                if response.status_code in {301, 302, 303, 307, 308}:
                    location = response.headers.get("location")
                    if not location:
                        raise ToolError("http_error", "网页跳转没有提供目标地址")
                    url = urljoin(url, location)
                    continue
                response.raise_for_status()
                data = bytearray()
                for chunk in response.iter_bytes():
                    data.extend(chunk)
                    if len(data) > max_bytes:
                        raise ToolError("too_large", "下载内容超过工具大小上限")
                return bytes(data), str(response.url), response.headers.get("content-type", "")
    raise ToolError("redirect_limit", "网页跳转次数超过上限")


def search_with_tavily(query, max_results, timeout):
    # 显式空 key 禁止 SDK 从环境选择付费凭据；只使用官方 keyless 模式。
    with TavilyClient(api_key="", client_source="minimal-agent-demo-keyless") as client:
        response = client.search(query, search_depth="basic", max_results=max_results,
                                 include_answer=False, include_raw_content=False, timeout=timeout)
    # SDK 会把缺失的 results 补成空列表；同时核对成功响应的 query，避免误判错误响应。
    if (not isinstance(response, dict) or response.get("error")
            or not isinstance(response.get("query"), str) or not response["query"].strip()
            or not isinstance(response.get("results"), list)):
        raise ToolError("invalid_search_response", "搜索服务未返回有效的结构化结果")
    if any(not isinstance(item, dict) for item in response["results"]):
        raise ToolError("invalid_search_response", "搜索结果格式无效")
    # 使用统一字段，不把 Tavily 生成的 answer 或整页原文作为搜索摘要返回。
    return [{"title": item.get("title", ""), "href": item.get("url", ""),
             "body": item.get("content", "")} for item in response["results"]]


def web_search(query, max_results=3, *, context=None):
    """有界切换搜索引擎；本轮失败的引擎不再请求，不将服务失败视为零结果。"""
    context = context if context is not None else RunContext()
    attempts = []
    for provider in SEARCH_PROVIDERS:
        if provider in context.unavailable_search_providers:
            attempts.append({"provider": provider, "status": "skipped",
                             "error_type": context.unavailable_search_providers[provider]})
            continue
        # 备用请求同样受本轮耗时约束；预算异常必须传给应用层。
        timeout = min(SEARCH_TIMEOUT, context.remaining_seconds())
        try:
            results = (search_with_tavily(query, max_results, timeout) if provider == "tavily"
                       else DDGS(timeout=timeout).text(query, backend=provider, max_results=max_results))
        except (DDGSException, BadRequestError, ForbiddenError, InvalidAPIKeyError,
                TavilyTimeoutError, UsageLimitExceededError, RequestException, ToolError, ValueError) as error:
            # DDGS 的 No results found 也可能来自 HTTP 202 验证页，不能当作可靠的零结果。
            reason = type(error).__name__
            context.unavailable_search_providers[provider] = reason
            attempt = {"provider": provider, "status": "unavailable", "error_type": reason}
            if isinstance(error, TavilyKeylessLimitError):
                retry_after = error.retry_after_seconds
                if type(retry_after) is int and retry_after >= 0:
                    attempt["retry_after_seconds"] = retry_after
            attempts.append(attempt)
            continue
        normalized = []
        for item in results[:max_results]:
            url = str(item.get("href", ""))[:2000]
            try:
                parts = urlsplit(url)
                if parts.scheme not in {"https", "http"} or not parts.hostname or parts.username or parts.password:
                    continue
                if parts.hostname in {"bing.com", "www.bing.com"} and parts.path == "/aclick":
                    continue  # Yahoo 页面可能混入 Bing 广告跳转，不作为正文来源。
            except ValueError:
                continue
            normalized.append({"title": str(item.get("title", ""))[:300], "url": url,
                               "snippet": str(item.get("body", ""))[:1000]})
        if normalized:
            attempts.append({"provider": provider, "status": "ok"})
            return {"provider": provider, "results": normalized, "attempts": attempts,
                    **({"access_mode": "keyless"} if provider == "tavily" else {}),
                    "message": "找到搜索结果；摘要不是网页正文"}
        if results:
            context.unavailable_search_providers[provider] = "InvalidResults"
            attempts.append({"provider": provider, "status": "unavailable", "error_type": "InvalidResults"})
        else:
            attempts.append({"provider": provider, "status": "no_results"})
    if all(attempt["status"] == "no_results" for attempt in attempts):
        return {"provider": None, "results": [], "attempts": attempts, "message": "没有找到搜索结果"}
    return {"provider": None, "results": [], "attempts": attempts,
            "error": {"code": "search_unavailable", "retryable": False,
                      "message": "搜索服务未能提供有效结果，本轮不要继续重试搜索或仅更换关键词。可读取已有 URL；没有 URL 时说明任务未完成。"}}


def read_webpage(url, *, context=None):
    data, final_url, content_type = fetch_bytes(url, 2 * 1024 * 1024, "text/html,application/xhtml+xml,text/plain")
    notes = []
    if "text/plain" in content_type:
        content = data.decode("utf-8", errors="replace")
        text_content = content
        content_format = "text"
        title = ""
    elif "text/html" in content_type or "application/xhtml+xml" in content_type:
        text_content, content = extract_article(data, final_url)
        content_format = "markdown"
        notes = extract_footnotes(data) if content else []
        title_match = re.search(r"<title[^>]*>(.*?)</title>", data.decode("utf-8", errors="replace"), re.I | re.S)
        title = html.unescape(title_match.group(1)).strip()[:300] if title_match else ""
    else:
        raise ToolError("unsupported_content", "此工具读取 HTML 或纯文本；图片请使用 analyze_image")
    if not content or not content.strip():
        raise ToolError("extraction_failed", "没有提取到正文；页面可能需要 JavaScript、登录或禁止访问")
    # 给补充脚注预留空间，避免长正文把尾部的重要限定再次挤掉。
    heading = '\n\n[网页脚注]\n'
    # 快照保存裁切前的提取文本；模型仍只收到有界结果，可稍后按 ID 回读。
    full_body = ' '.join(text_content.split())
    full_notes = [note for note in notes if note not in full_body]
    saved_content = content + (heading + '\n'.join(full_notes) if full_notes else '')
    saved_text = text_content + (heading + '\n'.join(full_notes) if full_notes else '')
    document_id = save_webpage(url=final_url, title=title, content=saved_content,
                              footnotes_found=len(notes), coverage_note=COVERAGE_NOTE,
                              text_content=saved_text if content_format == "markdown" else None)
    reserved = len(heading) + min(len('\n'.join(notes)), MAX_FOOTNOTE_CHARS) if notes else 0
    # 只对将实际返回的正文去重；位于裁切边界外的脚注仍须补回。
    normalized_body = ' '.join(content[:MAX_WEB_CHARS - reserved].split())
    extra_notes = [note for note in notes if note not in normalized_body]
    note_text = '\n'.join(extra_notes)
    supplement = heading + note_text[:MAX_FOOTNOTE_CHARS] if note_text else ''
    body_budget = MAX_WEB_CHARS - len(supplement)
    truncated = len(content) > body_budget or len(note_text) > MAX_FOOTNOTE_CHARS
    return {"url": final_url, "title": title, "content": content[:body_budget] + supplement,
            "document_id": document_id, "total_chars": len(saved_content),
            "content_format": content_format,
            "available_formats": {"markdown": len(saved_content), "text": len(saved_text)}
                                 if content_format == "markdown" else {"text": len(saved_content)},
            "truncated": truncated, "footnotes_found": len(notes),
            "completeness": "not_verified",
            "coverage_note": COVERAGE_NOTE}
