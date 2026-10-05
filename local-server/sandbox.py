"""Path sandboxing and tool implementations for the local workspace server."""

from __future__ import annotations

import base64
import os
import subprocess
from pathlib import Path


class SandboxError(Exception):
    """Raised when an operation violates the workspace sandbox or input limits."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


MAX_READ_BYTES = 512 * 1024
MAX_WRITE_BYTES = 1024 * 1024
MAX_LIST_ENTRIES = 500
BASH_TIMEOUT_SECONDS = 30
BASH_MAX_OUTPUT_BYTES = 256 * 1024

_BINARY_SUFFIXES = frozenset(
    {
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico",
        ".zip", ".gz", ".tar", ".bz2", ".7z", ".rar",
        ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
        ".mp3", ".mp4", ".wav", ".avi", ".mov", ".mkv",
        ".exe", ".dll", ".so", ".dylib", ".bin", ".woff", ".woff2", ".ttf",
    }
)


def resolve_in_workspace(workspace_root: Path, rel_path: str) -> Path:
    """Resolve ``rel_path`` strictly inside ``workspace_root``.

    Symlinks are resolved with realpath so escapes via ``..`` or links are
    rejected. Empty paths refer to the workspace root itself.
    """
    if not isinstance(rel_path, str):
        raise SandboxError("invalid_path", "path must be a string")
    cleaned = rel_path.strip()
    if "\x00" in cleaned:
        raise SandboxError("invalid_path", "path contains NUL byte")
    # Reject absolute inputs; everything is relative to the workspace root.
    if os.path.isabs(cleaned) or (len(cleaned) >= 2 and cleaned[1] == ":"):
        raise SandboxError("invalid_path", "absolute paths are not allowed")
    root_real = os.path.realpath(workspace_root)
    candidate = os.path.realpath(os.path.join(root_real, cleaned)) if cleaned else root_real
    if candidate != root_real and not candidate.startswith(root_real + os.sep):
        raise SandboxError("path_escape", f"path escapes the workspace: {rel_path}")
    return Path(candidate)


def _looks_binary(path: Path) -> bool:
    return path.suffix.lower() in _BINARY_SUFFIXES


def read_file(workspace_root: Path, rel_path: str, encoding: str = "utf-8") -> dict:
    target = resolve_in_workspace(workspace_root, rel_path)
    if not target.exists():
        raise SandboxError("not_found", f"file not found: {rel_path}")
    if target.is_dir():
        raise SandboxError("is_directory", f"path is a directory: {rel_path}")
    if _looks_binary(target):
        data = target.read_bytes()[:MAX_READ_BYTES]
        return {
            "kind": "base64",
            "path": rel_path,
            "size": target.stat().st_size,
            "truncated": target.stat().st_size > MAX_READ_BYTES,
            "data": base64.b64encode(data).decode("ascii"),
        }
    raw = target.read_bytes()
    truncated = len(raw) > MAX_READ_BYTES
    if truncated:
        raw = raw[:MAX_READ_BYTES]
    try:
        text = raw.decode(encoding)
    except (UnicodeDecodeError, LookupError) as exc:
        raise SandboxError("decode_error", f"cannot decode file: {exc}") from exc
    return {"kind": "text", "path": rel_path, "content": text, "truncated": truncated}


def list_dir(workspace_root: Path, rel_path: str = "") -> dict:
    target = resolve_in_workspace(workspace_root, rel_path)
    if not target.exists():
        raise SandboxError("not_found", f"directory not found: {rel_path}")
    if not target.is_dir():
        raise SandboxError("not_a_directory", f"path is not a directory: {rel_path}")
    entries: list[dict] = []
    for child in sorted(target.iterdir(), key=lambda p: (p.is_file(), p.name.lower())):
        if len(entries) >= MAX_LIST_ENTRIES:
            break
        stat = child.stat()
        entries.append(
            {
                "name": child.name,
                "type": "dir" if child.is_dir() else "file",
                "size": stat.st_size,
            }
        )
    return {"path": rel_path or ".", "entries": entries}


def write_file(workspace_root: Path, rel_path: str, content: str, mode: str = "overwrite") -> dict:
    if not isinstance(content, str):
        raise SandboxError("invalid_content", "content must be a string")
    encoded = content.encode("utf-8")
    if len(encoded) > MAX_WRITE_BYTES:
        raise SandboxError("too_large", f"content exceeds {MAX_WRITE_BYTES} bytes")
    target = resolve_in_workspace(workspace_root, rel_path)
    if target.is_dir():
        raise SandboxError("is_directory", f"path is a directory: {rel_path}")
    target.parent.mkdir(parents=True, exist_ok=True)
    if mode == "append":
        with open(target, "ab") as fh:
            fh.write(encoded)
    elif mode == "create_new":
        if target.exists():
            raise SandboxError("already_exists", f"file already exists: {rel_path}")
        target.write_bytes(encoded)
    else:
        target.write_bytes(encoded)
    return {"path": rel_path, "bytes_written": len(encoded), "mode": mode}


def edit_file(workspace_root: Path, rel_path: str, old_str: str, new_str: str, replace_all: bool = False) -> dict:
    if not old_str:
        raise SandboxError("invalid_input", "old_str must not be empty")
    target = resolve_in_workspace(workspace_root, rel_path)
    if not target.is_file():
        raise SandboxError("not_found", f"file not found: {rel_path}")
    raw = target.read_bytes()
    if len(raw) > MAX_WRITE_BYTES:
        raise SandboxError("too_large", f"file exceeds {MAX_WRITE_BYTES} bytes")
    text = raw.decode("utf-8")
    occurrences = text.count(old_str)
    if occurrences == 0:
        raise SandboxError("no_match", "old_str not found in file")
    if occurrences > 1 and not replace_all:
        raise SandboxError("ambiguous_match", f"old_str matches {occurrences} times; pass replace_all=true or add context")
    updated = text.replace(old_str, new_str) if replace_all else text.replace(old_str, new_str, 1)
    target.write_bytes(updated.encode("utf-8"))
    return {"path": rel_path, "replacements": occurrences if replace_all else 1}


def run_bash(workspace_root: Path, command: str, timeout: int | None = None) -> dict:
    if not isinstance(command, str) or not command.strip():
        raise SandboxError("invalid_command", "command must be a non-empty string")
    effective_timeout = min(int(timeout), 120) if timeout else BASH_TIMEOUT_SECONDS
    try:
        proc = subprocess.run(
            ["bash", "-lc", command],
            cwd=str(workspace_root),
            capture_output=True,
            text=True,
            timeout=effective_timeout,
            env={**os.environ, "LC_ALL": "C.UTF-8"},
        )
    except subprocess.TimeoutExpired:
        raise SandboxError("timeout", f"command timed out after {effective_timeout}s") from None
    stdout = _truncate(proc.stdout or "")
    stderr = _truncate(proc.stderr or "")
    return {"exit_code": proc.returncode, "stdout": stdout, "stderr": stderr, "cwd": str(workspace_root)}


def _truncate(text: str) -> str:
    data = text.encode("utf-8")
    if len(data) <= BASH_MAX_OUTPUT_BYTES:
        return text
    head = data[: BASH_MAX_OUTPUT_BYTES].decode("utf-8", errors="replace")
    return head + f"\n...[truncated at {BASH_MAX_OUTPUT_BYTES} bytes]"
