import type {
  AdapterSandbox,
  Capability,
  CreateConfig,
  ExecOptions,
  ExecResult,
  ListFilter,
  SandboxAdapter,
  SandboxInfo,
  SandboxState,
} from '@douglas-agent/sandbank-core';
import { ProviderError, SandboxNotFoundError } from '@douglas-agent/sandbank-core';
import {
  MICROSANDBOX_CAPABILITIES,
  type MicrosandboxAdapterConfig,
  type ShimExecResult,
  type ShimExecStreamEvent,
  type ShimSandboxInfo,
} from './types.js';

function shimStatusToSandboxState(s: ShimSandboxInfo['status']): SandboxState {
  switch (s) {
    case 'running':
      return 'running';
    case 'stopped':
      return 'stopped';
    case 'destroyed':
      return 'terminated';
    default:
      return 'error';
  }
}

/**
 * MicrosandboxAdapter — sandbank adapter that drives a remote
 * `microsandbox-shim` service over HTTP.
 *
 * The main API process does not need KVM. The shim runs on a Linux host (e.g.
 * douglas-wsl) and uses the `microsandbox` SDK to spawn microVMs locally.
 *
 * This adapter is intentionally a fetch-only HTTP client — it never imports
 * the `microsandbox` npm package directly.
 *
 * Protocol (see services/microsandbox-shim/src/server.ts for the canonical
 * implementation):
 *
 *   POST    {apiUrl}/v1/sandboxes           — create  → ShimSandboxInfo
 *   GET     {apiUrl}/v1/sandboxes/:id       — describe
 *   DELETE  {apiUrl}/v1/sandboxes/:id       — destroy
 *   POST    {apiUrl}/v1/sandboxes/:id/exec  — sync exec → ShimExecResult
 *   POST    {apiUrl}/v1/sandboxes/:id/exec/stream — SSE stream of ShimExecStreamEvent
 *
 * Every request carries `Authorization: Bearer <bearerToken>`.
 */
export class MicrosandboxAdapter implements SandboxAdapter {
  readonly name = 'microsandbox';
  readonly capabilities: ReadonlySet<Capability> = MICROSANDBOX_CAPABILITIES;

  private readonly apiUrl: string;
  private readonly bearerToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultCpus?: number;
  private readonly defaultMemoryMiB?: number;

  constructor(cfg: MicrosandboxAdapterConfig) {
    if (!cfg.apiUrl) throw new Error('MicrosandboxAdapter: apiUrl is required');
    if (!cfg.bearerToken) throw new Error('MicrosandboxAdapter: bearerToken is required');
    this.apiUrl = cfg.apiUrl.replace(/\/+$/, '');
    this.bearerToken = cfg.bearerToken;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.defaultCpus = cfg.defaultCpus;
    this.defaultMemoryMiB = cfg.defaultMemoryMiB;
  }

  private authHeaders(extra?: Record<string, string>): Record<string, string> {
    return { Authorization: `Bearer ${this.bearerToken}`, ...extra };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    sandboxIdForError?: string,
  ): Promise<T> {
    const headers = this.authHeaders(body ? { 'Content-Type': 'application/json' } : undefined);
    const res = await this.fetchImpl(`${this.apiUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404) {
      throw new SandboxNotFoundError('microsandbox', sandboxIdForError ?? path);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new ProviderError(
        'microsandbox',
        new Error(`shim ${method} ${path} → ${res.status}: ${detail}`),
        sandboxIdForError,
      );
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async createSandbox(config: CreateConfig): Promise<AdapterSandbox> {
    if (!config.image) {
      throw new ProviderError('microsandbox', new Error('createSandbox requires image'));
    }
    const info = await this.request<ShimSandboxInfo>('POST', '/v1/sandboxes', {
      image: config.image,
      env: config.env ?? {},
      cpus: this.defaultCpus,
      memoryMiB: this.defaultMemoryMiB,
    });
    return this.wrap(info);
  }

  async getSandbox(id: string): Promise<AdapterSandbox> {
    const info = await this.request<ShimSandboxInfo>(
      'GET',
      `/v1/sandboxes/${id}`,
      undefined,
      id,
    );
    return this.wrap(info);
  }

  async listSandboxes(_filter?: ListFilter): Promise<SandboxInfo[]> {
    const list = await this.request<ShimSandboxInfo[]>('GET', '/v1/sandboxes');
    return list.map((info) => ({
      id: info.id,
      state: shimStatusToSandboxState(info.status),
      createdAt: info.createdAt,
      image: info.image,
    }));
  }

  async destroySandbox(id: string): Promise<void> {
    await this.request<ShimSandboxInfo>('DELETE', `/v1/sandboxes/${id}`, undefined, id);
  }

  private wrap(info: ShimSandboxInfo): AdapterSandbox {
    const adapter = this;
    const handle: AdapterSandbox = {
      id: info.id,
      state: shimStatusToSandboxState(info.status),
      createdAt: info.createdAt,

      async exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
        const res = await adapter.request<ShimExecResult>(
          'POST',
          `/v1/sandboxes/${info.id}/exec`,
          {
            command,
            args: undefined,
            cwd: opts?.cwd,
            timeoutMs: opts?.timeout,
          },
          info.id,
        );
        return { stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode };
      },

      execStream(command: string, opts?: ExecOptions): Promise<ReadableStream<Uint8Array>> {
        return adapter.openExecStream(info.id, command, opts);
      },

      streamLogs(): Promise<ReadableStream<Uint8Array>> {
        return adapter.openLogsStream(info.id);
      },
    };
    return handle;
  }

  /**
   * Subscribe to a sandbox's combined stdout + stderr stream via the shim's
   * `GET /v1/sandboxes/:id/logs` SSE endpoint. Used by the broker to read
   * task-runner JSON Lines events without requiring the dev box to accept
   * inbound HTTP callbacks.
   *
   * SSE wire format (from the shim):
   *   data: {"b64":"<base64 bytes>"}\n\n
   *
   * Returns a ReadableStream<Uint8Array> of the decoded raw bytes, ordered
   * by host capture timestamp.
   */
  private async openLogsStream(sandboxId: string): Promise<ReadableStream<Uint8Array>> {
    const res = await this.fetchImpl(`${this.apiUrl}/v1/sandboxes/${sandboxId}/logs`, {
      method: 'GET',
      headers: this.authHeaders(),
    });
    if (res.status === 404) throw new SandboxNotFoundError('microsandbox', sandboxId);
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new ProviderError(
        'microsandbox',
        new Error(`shim streamLogs → ${res.status}: ${detail}`),
        sandboxId,
      );
    }
    if (!res.body) {
      throw new ProviderError(
        'microsandbox',
        new Error('shim streamLogs returned no body'),
        sandboxId,
      );
    }

    const sourceReader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        for (;;) {
          const { value, done } = await sourceReader.read();
          if (done) {
            controller.close();
            return;
          }
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
            if (!dataLine) continue;
            try {
              const parsed = JSON.parse(dataLine.slice(6)) as { b64?: string };
              if (typeof parsed.b64 === 'string') {
                const bytes = Uint8Array.from(Buffer.from(parsed.b64, 'base64'));
                controller.enqueue(bytes);
              }
            } catch {
              // ignore malformed event
            }
          }
          return;
        }
      },
      cancel() {
        sourceReader.cancel().catch(() => {});
      },
    });
  }

  private async openExecStream(
    sandboxId: string,
    command: string,
    opts?: ExecOptions,
  ): Promise<ReadableStream<Uint8Array>> {
    const res = await this.fetchImpl(`${this.apiUrl}/v1/sandboxes/${sandboxId}/exec/stream`, {
      method: 'POST',
      headers: this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ command, cwd: opts?.cwd, timeoutMs: opts?.timeout }),
    });
    if (res.status === 404) throw new SandboxNotFoundError('microsandbox', sandboxId);
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new ProviderError(
        'microsandbox',
        new Error(`shim execStream → ${res.status}: ${detail}`),
        sandboxId,
      );
    }
    if (!res.body) {
      throw new ProviderError(
        'microsandbox',
        new Error('shim execStream returned no body'),
        sandboxId,
      );
    }

    // Parse SSE on the way through and emit raw stdout bytes, matching the
    // sandbank `execStream` contract (ReadableStream<Uint8Array> = combined
    // stdout+stderr text bytes; exit is signaled by stream close).
    const encoder = new TextEncoder();
    const sourceReader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        for (;;) {
          const { value, done } = await sourceReader.read();
          if (done) {
            controller.close();
            return;
          }
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
            if (!dataLine) continue;
            try {
              const event = JSON.parse(dataLine.slice(6)) as ShimExecStreamEvent;
              if (event.kind === 'stdout' || event.kind === 'stderr') {
                controller.enqueue(encoder.encode(event.data));
              } else if (event.kind === 'exited') {
                controller.close();
                return;
              }
            } catch {
              // ignore malformed event
            }
          }
          return;
        }
      },
      cancel() {
        sourceReader.cancel().catch(() => {});
      },
    });
  }
}
