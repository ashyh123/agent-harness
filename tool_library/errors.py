class ToolError(Exception):
    """只携带可以安全展示给模型和日志的错误，不包含原始服务响应或密钥。"""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
