"""Permission levels enforced server-side for the DeepCompanion local workspace."""

from __future__ import annotations

from enum import Enum


class PermissionLevel(str, Enum):
    READ_ONLY = "read_only"
    WORKSPACE_WRITE = "workspace_write"
    FULL_ACCESS = "full_access"


def parse_permission(raw: str | None) -> PermissionLevel:
    """Parse a permission string; unknown or missing values fail closed to read_only."""
    if not raw:
        return PermissionLevel.READ_ONLY
    try:
        return PermissionLevel(raw)
    except ValueError:
        return PermissionLevel.READ_ONLY


# Minimum permission level required by each tool.
TOOL_MIN_PERMISSION: dict[str, PermissionLevel] = {
    "workspace_read": PermissionLevel.READ_ONLY,
    "workspace_list": PermissionLevel.READ_ONLY,
    "workspace_write": PermissionLevel.WORKSPACE_WRITE,
    "workspace_edit": PermissionLevel.WORKSPACE_WRITE,
    "workspace_bash": PermissionLevel.FULL_ACCESS,
}

_LEVEL_ORDER: tuple[PermissionLevel, ...] = (
    PermissionLevel.READ_ONLY,
    PermissionLevel.WORKSPACE_WRITE,
    PermissionLevel.FULL_ACCESS,
)


def allows(tool: str, granted: PermissionLevel) -> bool:
    required = TOOL_MIN_PERMISSION.get(tool)
    if required is None:
        # Unknown tools are rejected.
        return False
    return _LEVEL_ORDER.index(granted) >= _LEVEL_ORDER.index(required)
