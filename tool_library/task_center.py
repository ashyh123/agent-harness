"""主Agent的五个调度工具；任务运行、并发和记录由独立的Node调度器持有。"""
import json
import os
import socket

from .errors import ToolError


def _request(operation, arguments, context):
    endpoint = os.getenv('MINIMAL_AGENT_TASK_CENTER_SOCKET')
    token = os.getenv('MINIMAL_AGENT_TASK_CENTER_TOKEN')
    if not endpoint or not token:
        raise ToolError('center_unavailable', '请通过npm run person启动本地任务中心')
    timeout = min(10, context.remaining_seconds()) if context is not None else 10
    request = json.dumps({'op': operation, 'arguments': arguments, 'token': token}, ensure_ascii=False).encode() + b'\n'
    if len(request) > 32768:
        raise ToolError('center_invalid_request', '任务中心请求过大')
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(timeout)
            client.connect(endpoint)
            client.sendall(request)
            response = bytearray()
            while b'\n' not in response:
                chunk = client.recv(8192)
                if not chunk:
                    raise ValueError('incomplete response')
                response.extend(chunk)
                if len(response) > 256 * 1024:
                    raise ValueError('oversized response')
        reply = json.loads(response.split(b'\n', 1)[0])
        if 'error' in reply:
            raise ToolError('center_rejected', str(reply['error']))
        return reply['data']
    except (OSError, ValueError, KeyError):
        raise ToolError('center_unavailable', '本地任务中心未及时返回合法结果；不要据此声称任务已完成')


def submit_tasks(tasks, *, context=None):
    return _request('submit_tasks', {'tasks': tasks}, context)


def get_task_updates(cursor=0, limit=10, task_id=None, *, context=None):
    return _request('get_task_updates', {'cursor': cursor, 'limit': limit, 'task_id': task_id}, context)


def read_task_artifact(task_id, attempt_id, path, offset=0, limit=3000, *, context=None):
    return _request('read_task_artifact', {'task_id': task_id, 'attempt_id': attempt_id,
                    'path': path, 'offset': offset, 'limit': limit}, context)


def review_task(task_id, attempt_id, passed, reason, evidence=None, *, context=None):
    return _request('review_task', {'task_id': task_id, 'attempt_id': attempt_id,
                    'passed': passed, 'reason': reason, 'evidence': evidence or []}, context)


def cancel_task(task_id, *, context=None):
    return _request('cancel_task', {'task_id': task_id}, context)
