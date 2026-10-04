import { translate, type LocaleMessageKey, type SupportedLocale } from '../../i18n/background';
import type {
  JsonValue,
  ToolCall,
  ToolDescriptor,
  ToolProviderIdentity,
  ToolResult,
} from '../../types';
import { callLocalWorkspaceTool, LocalWorkspaceClientError } from './client';
import { getLocalWorkspaceSettings, localWorkspaceOrigin } from './settings';
import {
  LOCAL_WORKSPACE_PERMISSION_LEVELS,
  LOCAL_WORKSPACE_PROVIDER,
  LOCAL_WORKSPACE_TOOL_NAMES,
  isLocalWorkspacePermissionLevel,
  isLocalWorkspaceToolName,
  permissionAllowsTool,
  type LocalWorkspacePermissionLevel,
  type LocalWorkspaceSettings,
  type LocalWorkspaceToolName,
} from './types';

export { LOCAL_WORKSPACE_PROVIDER, LOCAL_WORKSPACE_TOOL_NAMES };
export type { LocalWorkspaceToolName };
export { pingLocalWorkspaceServer } from './client';
export {
  getLocalWorkspaceSettings,
  saveLocalWorkspaceSettings,
  localWorkspaceOrigin,
} from './settings';

const COPY_KEYS: Record<LocalWorkspaceToolName, { title: LocaleMessageKey; description: LocaleMessageKey }> = {
  workspace_read: { title: 'tool.localWorkspace.readTitle', description: 'tool.localWorkspace.readDescription' },
  workspace_list: { title: 'tool.localWorkspace.listTitle', description: 'tool.localWorkspace.listDescription' },
  workspace_write: { title: 'tool.localWorkspace.writeTitle', description: 'tool.localWorkspace.writeDescription' },
  workspace_edit: { title: 'tool.localWorkspace.editTitle', description: 'tool.localWorkspace.editDescription' },
  workspace_bash: { title: 'tool.localWorkspace.bashTitle', description: 'tool.localWorkspace.bashDescription' },
};

export function createLocalWorkspaceToolProviderIdentity(locale: SupportedLocale): ToolProviderIdentity {
  return {
    ...LOCAL_WORKSPACE_PROVIDER,
    displayName: translate(locale, 'tool.localWorkspace.providerName'),
  };
}

/** Tools visible for a permission level (mirrors the server-side matrix). */
export function localWorkspaceToolsForPermission(permission: LocalWorkspacePermissionLevel): LocalWorkspaceToolName[] {
  return LOCAL_WORKSPACE_TOOL_NAMES.filter((tool) => permissionAllowsTool(permission, tool));
}

export async function shouldExposeLocalWorkspaceTools(): Promise<boolean> {
  const settings = await getLocalWorkspaceSettings();
  return settings.enabled && settings.workspacePath.length > 0;
}

export function createLocalWorkspaceToolDescriptors(
  locale: SupportedLocale,
  settings: LocalWorkspaceSettings,
): ToolDescriptor[] {
  if (!settings.enabled || settings.workspacePath.length === 0) return [];
  const provider = createLocalWorkspaceToolProviderIdentity(locale);
  return localWorkspaceToolsForPermission(settings.permission).map((name) => ({
    id: `local:${LOCAL_WORKSPACE_PROVIDER.id}:${name}`,
    provider,
    name,
    invocationName: name,
    title: translate(locale, COPY_KEYS[name].title),
    description: translate(locale, COPY_KEYS[name].description),
    inputSchema: schemaForTool(name),
    execution: {
      mode: 'auto',
      enabled: true,
      risk: riskForTool(name),
      timeoutMs: timeoutForTool(name),
      maxResultBytes: name === 'workspace_read' ? 60_000 : 40_000,
    },
    annotations: {
      requires: 'local_server',
      output: `JSON returned by the local workspace server at ${localWorkspaceOrigin(settings)}.`,
      workspace: settings.workspacePath,
      permission: settings.permission,
    },
  }));
}

export async function executeLocalWorkspaceToolCall(
  call: ToolCall,
  locale: SupportedLocale,
): Promise<ToolResult> {
  const provider = call.provider ?? createLocalWorkspaceToolProviderIdentity(locale);
  const startedAt = Date.now();
  const finish = (result: Omit<ToolResult, 'startedAt' | 'completedAt' | 'durationMs'>): ToolResult => {
    const completedAt = Date.now();
    return { ...result, startedAt, completedAt, durationMs: completedAt - startedAt };
  };

  if (!isLocalWorkspaceToolName(call.name)) {
    return finish({
      ok: false,
      name: call.name,
      provider,
      summary: `Unsupported local workspace tool: ${call.name}`,
      error: { code: 'workspace_tool_unsupported', message: `Unsupported local workspace tool: ${call.name}`, retryable: false },
    });
  }

  const settings = await getLocalWorkspaceSettings();
  if (!settings.enabled || settings.workspacePath.length === 0) {
    return finish({
      ok: false,
      name: call.name,
      provider,
      summary: 'Local workspace is not configured.',
      error: { code: 'workspace_not_configured', message: 'Enable the local workspace and pick a workspace folder in the Tools page first.', retryable: false },
    });
  }
  // Client-side pre-check mirrors the server matrix; the server re-enforces it.
  if (!permissionAllowsTool(settings.permission, call.name)) {
    return finish({
      ok: false,
      name: call.name,
      provider,
      summary: `Permission '${settings.permission}' does not allow ${call.name}.`,
      error: { code: 'permission_denied', message: `Raise the permission level in the Tools page to use ${call.name}.`, retryable: false },
    });
  }

  const args = normalizeArguments(call.payload);
  try {
    const response = await callLocalWorkspaceTool(settings, call.name, args, timeoutForTool(call.name));
    const completedWith = (partial: Omit<ToolResult, 'startedAt' | 'completedAt' | 'durationMs'>) => partial;
    if (response.ok) {
      return finish(completedWith({
        ok: true,
        name: call.name,
        provider,
        descriptorId: call.descriptorId,
        summary: summarizeSuccess(call.name, response.data),
        output: asJsonValue(response.data) ?? null,
      }));
    }
    const code = response.error?.code ?? 'server_error';
    const message = response.error?.message ?? 'local workspace server returned an error';
    return finish(completedWith({
      ok: false,
      name: call.name,
      provider,
      descriptorId: call.descriptorId,
      summary: `${call.name} failed: ${message}`,
      error: { code, message, retryable: code === 'timeout' || code === 'io_error' },
    }));
  } catch (error) {
    if (error instanceof LocalWorkspaceClientError) {
      return finish({
        ok: false,
        name: call.name,
        provider,
        descriptorId: call.descriptorId,
        summary: `${call.name} failed: ${error.message}`,
        error: { code: error.code, message: error.message, retryable: error.retryable },
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    return finish({
      ok: false,
      name: call.name,
      provider,
      descriptorId: call.descriptorId,
      summary: `${call.name} failed unexpectedly`,
      error: { code: 'workspace_execution_failed', message, retryable: false },
    });
  }
}

function normalizeArguments(payload: ToolCall['payload']): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    args[key] = value;
  }
  return args;
}

function summarizeSuccess(name: LocalWorkspaceToolName, data: unknown): string {
  if (!data || typeof data !== 'object') return `${name} completed`;
  const record = data as Record<string, JsonValue>;
  switch (name) {
    case 'workspace_read': {
      const content = typeof record.content === 'string' ? record.content : '';
      return `Read ${String(record.path ?? '')} (${content.length} chars${record.truncated === true ? ', truncated' : ''})`;
    }
    case 'workspace_list': {
      const entries = Array.isArray(record.entries) ? record.entries.length : 0;
      return `Listed ${String(record.path ?? '.')} (${entries} entries)`;
    }
    case 'workspace_write':
      return `Wrote ${String(record.bytes_written ?? 0)} bytes to ${String(record.path ?? '')}`;
    case 'workspace_edit':
      return `Edited ${String(record.path ?? '')} (${String(record.replacements ?? 1)} replacement)`;
    case 'workspace_bash':
      return `bash exit ${String(record.exit_code ?? '?')}`;
    default:
      return `${name} completed`;
  }
}

function asJsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map((item) => asJsonValue(item) ?? null);
  if (typeof value === 'object') {
    const out: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = asJsonValue(item) ?? null;
    }
    return out;
  }
  return undefined;
}

function schemaForTool(name: LocalWorkspaceToolName): ToolDescriptor['inputSchema'] {
  switch (name) {
    case 'workspace_read':
      return objectSchema({
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        encoding: { type: 'string', description: 'Text encoding, default utf-8.' },
      }, ['path']);
    case 'workspace_list':
      return objectSchema({
        path: { type: 'string', description: 'Directory path relative to the workspace root; empty lists the root.' },
      });
    case 'workspace_write':
      return objectSchema({
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        content: { type: 'string', description: 'Full text content to write.' },
        mode: { type: 'string', enum: ['overwrite', 'append', 'create_new'], description: 'Write mode, default overwrite.' },
      }, ['path', 'content']);
    case 'workspace_edit':
      return objectSchema({
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        old_str: { type: 'string', description: 'Exact text to replace; must match uniquely unless replace_all is true.' },
        new_str: { type: 'string', description: 'Replacement text.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence instead of failing on ambiguity.' },
      }, ['path', 'old_str', 'new_str']);
    case 'workspace_bash':
      return objectSchema({
        command: { type: 'string', description: 'Bash command to run with the workspace as cwd.' },
        timeout: { type: 'number', description: 'Optional timeout in seconds (max 120).' },
      }, ['command']);
    default:
      return objectSchema({});
  }
}

function objectSchema(
  properties: NonNullable<ToolDescriptor['inputSchema']['properties']>,
  required: string[] = [],
): ToolDescriptor['inputSchema'] {
  return { type: 'object', properties, required, additionalProperties: false };
}

function riskForTool(name: LocalWorkspaceToolName): ToolDescriptor['execution']['risk'] {
  if (name === 'workspace_bash') return 'high';
  if (name === 'workspace_write' || name === 'workspace_edit') return 'medium';
  return 'low';
}

function timeoutForTool(name: LocalWorkspaceToolName): number {
  if (name === 'workspace_bash') return 130_000;
  return 30_000;
}

// Re-exported for handler validation without importing enum arrays elsewhere.
export { LOCAL_WORKSPACE_PERMISSION_LEVELS, isLocalWorkspacePermissionLevel };
