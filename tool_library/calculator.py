import math

from .errors import ToolError


def calculate(operation, a, b, *, context=None):
    if operation == "divide" and b == 0:
        raise ToolError("division_by_zero", "除数不能为零")
    operations = {
        "add": lambda: a + b,
        "subtract": lambda: a - b,
        "multiply": lambda: a * b,
        "divide": lambda: a / b,
    }
    result = operations[operation]()
    if not math.isfinite(result):
        raise ToolError("numeric_overflow", "计算结果超出有限数值范围")
    return {"operation": operation, "a": a, "b": b, "result": result}
