"""网页搜索与正文读取；外部服务的结果统一转换为小型 JSON 对象。"""
import html
import ipaddress
import re
import socket
from urllib.parse import urljoin, urlsplit

import httpx
import trafilatura
from ddgs import DDGS

from .errors import ToolError

MAX_WEB_CHARS = 10000


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


def web_search(query, max_results=3, *, context=None):
    results = DDGS(timeout=10).text(query, backend="duckduckgo", max_results=max_results)
    normalized = [
        {"title": str(item.get("title", ""))[:300], "url": str(item.get("href", ""))[:2000], "snippet": str(item.get("body", ""))[:1000]}
        for item in results[:max_results]
    ]
    return {"provider": "duckduckgo", "results": normalized, "message": "找到搜索结果" if normalized else "没有找到搜索结果"}


def read_webpage(url, *, context=None):
    data, final_url, content_type = fetch_bytes(url, 2 * 1024 * 1024, "text/html,application/xhtml+xml,text/plain")
    if "text/plain" in content_type:
        content = data.decode("utf-8", errors="replace")
        title = ""
    elif "text/html" in content_type or "application/xhtml+xml" in content_type:
        content = trafilatura.extract(data, include_comments=False, include_tables=True)
        title_match = re.search(r"<title[^>]*>(.*?)</title>", data.decode("utf-8", errors="replace"), re.I | re.S)
        title = html.unescape(title_match.group(1)).strip()[:300] if title_match else ""
    else:
        raise ToolError("unsupported_content", "此工具读取 HTML 或纯文本；图片请使用 analyze_image")
    if not content or not content.strip():
        raise ToolError("extraction_failed", "没有提取到正文；页面可能需要 JavaScript、登录或禁止访问")
    return {"url": final_url, "title": title, "content": content[:MAX_WEB_CHARS], "truncated": len(content) > MAX_WEB_CHARS}
