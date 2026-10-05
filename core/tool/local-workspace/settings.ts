import {
  LOCAL_WORKSPACE_DEFAULT_PORT,
  LOCAL_WORKSPACE_STORAGE_KEY,
  isLocalWorkspacePermissionLevel,
  type LocalWorkspacePermissionLevel,
  type LocalWorkspaceSettings,
} from './types';

export type {
  LocalWorkspaceConnectionTestResult,
  LocalWorkspacePermissionLevel,
  LocalWorkspaceSettings,
} from './types';

export const DEFAULT_LOCAL_WORKSPACE_SETTINGS: LocalWorkspaceSettings = {
  enabled: false,
  host: '127.0.0.1',
  port: LOCAL_WORKSPACE_DEFAULT_PORT,
  workspacePath: '',
  permission: 'read_only',
};

const MIN_PORT = 1;
const MAX_PORT = 65_535;
const MAX_PATH_LENGTH = 4096;

/** Loopback-only hosts are accepted; anything else fails closed to 127.0.0.1. */
function normalizeHost(value: unknown): string {
  if (value === 'localhost' || value === '127.0.0.1' || value === '::1') return String(value);
  return DEFAULT_LOCAL_WORKSPACE_SETTINGS.host;
}

export function normalizeLocalWorkspaceSettings(input: unknown): LocalWorkspaceSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ...DEFAULT_LOCAL_WORKSPACE_SETTINGS };
  }

  const partial = input as Partial<LocalWorkspaceSettings>;
  const rawPath = typeof partial.workspacePath === 'string' ? partial.workspacePath.trim() : '';
  return {
    enabled: partial.enabled === true && rawPath.length > 0,
    host: normalizeHost(partial.host),
    port: typeof partial.port === 'number' && Number.isInteger(partial.port)
      ? Math.min(MAX_PORT, Math.max(MIN_PORT, partial.port))
      : DEFAULT_LOCAL_WORKSPACE_SETTINGS.port,
    workspacePath: rawPath.slice(0, MAX_PATH_LENGTH),
    // Unknown or missing permission values fail closed to read_only.
    permission: isLocalWorkspacePermissionLevel(partial.permission)
      ? partial.permission
      : DEFAULT_LOCAL_WORKSPACE_SETTINGS.permission,
  };
}

export async function getLocalWorkspaceSettings(): Promise<LocalWorkspaceSettings> {
  const data = await chrome.storage.local.get(LOCAL_WORKSPACE_STORAGE_KEY) as Record<string, unknown>;
  return normalizeLocalWorkspaceSettings(data[LOCAL_WORKSPACE_STORAGE_KEY]);
}

export async function saveLocalWorkspaceSettings(
  patch: Partial<LocalWorkspaceSettings>,
): Promise<LocalWorkspaceSettings> {
  const current = await getLocalWorkspaceSettings();
  const next = normalizeLocalWorkspaceSettings({ ...current, ...patch });
  await chrome.storage.local.set({ [LOCAL_WORKSPACE_STORAGE_KEY]: next });
  return next;
}

export function localWorkspaceOrigin(settings: Pick<LocalWorkspaceSettings, 'host' | 'port'>): string {
  const host = settings.host.includes(':') ? `[${settings.host}]` : settings.host;
  return `http://${host}:${settings.port}`;
}
