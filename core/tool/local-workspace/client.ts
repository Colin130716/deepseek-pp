import { localWorkspaceOrigin, type LocalWorkspaceSettings } from './settings';
import type { LocalWorkspaceConnectionTestResult } from './types';

export interface LocalWorkspaceServerResponse {
  ok: boolean;
  data?: unknown;
  error?: { code?: string; message?: string };
}

export class LocalWorkspaceClientError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = 'LocalWorkspaceClientError';
    this.code = code;
    this.retryable = retryable;
  }
}

function baseUrl(settings: Pick<LocalWorkspaceSettings, 'host' | 'port'>): string {
  return localWorkspaceOrigin(settings);
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      throw new LocalWorkspaceClientError(
        'http_status',
        `local workspace server responded with HTTP ${response.status}`,
        response.status >= 500,
      );
    }
    return await response.json();
  } catch (error) {
    if (error instanceof LocalWorkspaceClientError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new LocalWorkspaceClientError('timeout', `local workspace server request timed out after ${timeoutMs}ms`, true);
    }
    throw new LocalWorkspaceClientError(
      'connection_failed',
      'cannot reach the local workspace server; make sure "python run.py" is running',
      true,
    );
  }
}

/** Health probe used by the Tools page "test connection" button. */
export async function pingLocalWorkspaceServer(
  settings: Pick<LocalWorkspaceSettings, 'host' | 'port'>,
): Promise<LocalWorkspaceConnectionTestResult> {
  try {
    const body = await fetchJson(`${baseUrl(settings)}/health`, { method: 'GET' }, 5_000) as
      { ok?: boolean; version?: string; server?: string };
    if (body.ok !== true || body.server !== 'deepcompanion-local-workspace') {
      return { ok: false, message: 'unexpected health payload from this port' };
    }
    return { ok: true, message: 'connected', serverVersion: String(body.version ?? '') };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** Execute one tool on the local server; throws LocalWorkspaceClientError on transport failure. */
export async function callLocalWorkspaceTool(
  settings: Pick<LocalWorkspaceSettings, 'host' | 'port' | 'workspacePath' | 'permission'>,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<LocalWorkspaceServerResponse> {
  const url = `${baseUrl(settings)}/tools/${encodeURIComponent(toolName)}`;
  const body = await fetchJson(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspace_root: settings.workspacePath,
        permission: settings.permission,
        arguments: args,
      }),
    },
    // bash can legitimately run long; give HTTP a margin over the server-side timeout.
    Math.max(timeoutMs + 5_000, 10_000),
  ) as LocalWorkspaceServerResponse;
  if (typeof body !== 'object' || body === null || typeof body.ok !== 'boolean') {
    throw new LocalWorkspaceClientError('bad_response', 'malformed response from local workspace server');
  }
  return body;
}
