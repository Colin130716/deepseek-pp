"""FastAPI local server exposing workspace tool execution for DeepCompanion.

Security model:
- Binds to 127.0.0.1 only; CORS restricted to chrome-extension:// origins.
- Every request carries ``workspace_root`` (absolute path chosen by the user in
  the extension UI) and ``permission`` (read_only | workspace_write | full_access).
- The server independently enforces the permission matrix and a realpath-based
  sandbox, so a compromised or buggy client cannot exceed the granted level.

Run: python -m uvicorn app:app --host 127.0.0.1 --port 8765  (or: python run.py)
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

import permissions as perm
import sandbox

PROTOCOL_VERSION = "1"
DEFAULT_PORT = 8765


class ToolRequest(BaseModel):
    model_config = {"extra": "forbid"}

    workspace_root: str = Field(min_length=1, max_length=4096)
    permission: str = Field(default="read_only", max_length=32)
    arguments: dict[str, Any] = Field(default_factory=dict)


class ReadArgs(BaseModel):
    model_config = {"extra": "forbid"}

    path: str = Field(min_length=1, max_length=1024)
    encoding: str = Field(default="utf-8", max_length=32)


class ListArgs(BaseModel):
    model_config = {"extra": "forbid"}

    path: str = Field(default="", max_length=1024)


class WriteArgs(BaseModel):
    model_config = {"extra": "forbid"}

    path: str = Field(min_length=1, max_length=1024)
    content: str = Field(max_length=4 * 1024 * 1024)
    mode: Literal["overwrite", "append", "create_new"] = "overwrite"


class EditArgs(BaseModel):
    model_config = {"extra": "forbid"}

    path: str = Field(min_length=1, max_length=1024)
    old_str: str = Field(min_length=1, max_length=256 * 1024)
    new_str: str = Field(max_length=256 * 1024)
    replace_all: bool = False


class BashArgs(BaseModel):
    model_config = {"extra": "forbid"}

    command: str = Field(min_length=1, max_length=8 * 1024)
    timeout: int | None = Field(default=None, ge=1, le=120)


ARG_MODELS: dict[str, type[BaseModel]] = {
    "workspace_read": ReadArgs,
    "workspace_list": ListArgs,
    "workspace_write": WriteArgs,
    "workspace_edit": EditArgs,
    "workspace_bash": BashArgs,
}


def create_app() -> FastAPI:
    app = FastAPI(title="DeepCompanion Local Workspace Server", version=PROTOCOL_VERSION)

    # The extension sends Origin: chrome-extension://<id>; allow any extension
    # origin but nothing else. Loopback binding already blocks remote hosts.
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"chrome-extension://[a-p]{32}",
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type"],
    )

    @app.get("/health")
    def health() -> dict[str, Any]:
        return {
            "ok": True,
            "version": PROTOCOL_VERSION,
            "server": "deepcompanion-local-workspace",
            "pid": os.getpid(),
        }

    @app.post("/tools/{tool_name}")
    def execute_tool(tool_name: str, body: ToolRequest, request: Request) -> dict[str, Any]:
        del request  # reserved for future header checks
        if tool_name not in ARG_MODELS:
            return {"ok": False, "error": {"code": "unknown_tool", "message": f"unknown tool: {tool_name}"}}

        granted = perm.parse_permission(body.permission)
        if not perm.allows(tool_name, granted):
            return {
                "ok": False,
                "error": {
                    "code": "permission_denied",
                    "message": f"permission '{granted.value}' does not allow tool '{tool_name}'",
                },
            }

        root = Path(body.workspace_root)
        if not root.is_dir():
            return {
                "ok": False,
                "error": {"code": "invalid_workspace", "message": f"workspace root is not a directory: {body.workspace_root}"},
            }

        try:
            args_model = ARG_MODELS[tool_name]
            args = args_model.model_validate(body.arguments)
        except Exception as exc:  # pydantic validation errors
            return {"ok": False, "error": {"code": "invalid_arguments", "message": str(exc)}}

        try:
            if tool_name == "workspace_read":
                data = sandbox.read_file(root, args.path, args.encoding)
            elif tool_name == "workspace_list":
                data = sandbox.list_dir(root, args.path)
            elif tool_name == "workspace_write":
                data = sandbox.write_file(root, args.path, args.content, args.mode)
            elif tool_name == "workspace_edit":
                data = sandbox.edit_file(root, args.path, args.old_str, args.new_str, args.replace_all)
            else:  # workspace_bash
                data = sandbox.run_bash(root, args.command, args.timeout)
        except sandbox.SandboxError as exc:
            return {"ok": False, "error": {"code": exc.code, "message": exc.message}}
        except PermissionError as exc:
            return {"ok": False, "error": {"code": "os_permission", "message": str(exc)}}
        except OSError as exc:
            return {"ok": False, "error": {"code": "io_error", "message": str(exc)}}

        return {"ok": True, "data": data}

    return app


app = create_app()
