"""Shared strict input models: the original tool library and MCP use one definition."""
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StringConstraints


class ToolParameters(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


class QueryParameters(ToolParameters):
    query: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]


class SearchParameters(QueryParameters):
    max_results: int = Field(default=3, ge=1, le=5)
