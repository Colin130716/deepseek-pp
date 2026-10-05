import type { ToolProviderIdentity } from '../../types';

export const LOCAL_WORKSPACE_STORAGE_KEY = 'deepseek_pp_local_workspace_settings';

export const LOCAL_WORKSPACE_PROVIDER_ID = 'local_workspace';

export const LOCAL_WORKSPACE_DEFAULT_PORT = 8765;

export const LOCAL_WORKSPACE_PERMISSION_LEVELS = ['read_only', 'workspace_write', 'full_access'] as const;

export type LocalWorkspacePermissionLevel = typeof LOCAL_WORKSPACE_PERMISSION_LEVELS[number];

export const LOCAL_WORKSPACE_TOOL_NAMES = [
  'workspace_read',
  'workspace_list',
  'workspace_write',
  'workspace_edit',
  'workspace_bash',
] as const;

export type LocalWorkspaceToolName = typeof LOCAL_WORKSPACE_TOOL_NAMES[number];

export const LOCAL_WORKSPACE_TOOL_SET = new Set<string>(LOCAL_WORKSPACE_TOOL_NAMES);

/** Minimum permission level required for each tool (mirrors local-server matrix). */
export const LOCAL_WORKSPACE_TOOL_MIN_PERMISSION: Record<LocalWorkspaceToolName, LocalWorkspacePermissionLevel> = {
  workspace_read: 'read_only',
  workspace_list: 'read_only',
  workspace_write: 'workspace_write',
  workspace_edit: 'workspace_write',
  workspace_bash: 'full_access',
};

const PERMISSION_ORDER: readonly LocalWorkspacePermissionLevel[] = LOCAL_WORKSPACE_PERMISSION_LEVELS;

export function isLocalWorkspaceToolName(name: string): name is LocalWorkspaceToolName {
  return LOCAL_WORKSPACE_TOOL_SET.has(name);
}

export function isLocalWorkspacePermissionLevel(value: unknown): value is LocalWorkspacePermissionLevel {
  return typeof value === 'string'
    && (LOCAL_WORKSPACE_PERMISSION_LEVELS as readonly string[]).includes(value);
}

export function permissionAllowsTool(
  granted: LocalWorkspacePermissionLevel,
  tool: LocalWorkspaceToolName,
): boolean {
  return PERMISSION_ORDER.indexOf(granted) >= PERMISSION_ORDER.indexOf(LOCAL_WORKSPACE_TOOL_MIN_PERMISSION[tool]);
}

export const LOCAL_WORKSPACE_PROVIDER: ToolProviderIdentity = {
  kind: 'local',
  id: LOCAL_WORKSPACE_PROVIDER_ID,
  displayName: 'Local Workspace',
  transport: 'http',
};

export interface LocalWorkspaceSettings {
  enabled: boolean;
  host: string;
  port: number;
  workspacePath: string;
  permission: LocalWorkspacePermissionLevel;
}

export interface LocalWorkspaceConnectionTestResult {
  ok: boolean;
  message: string;
  serverVersion?: string;
}
