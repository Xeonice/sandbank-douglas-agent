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
import {
  ProviderError,
  RateLimitError,
  SandboxNotFoundError,
} from '@douglas-agent/sandbank-core';
import {
  E2B_PROTOCOL_CAPABILITIES,
  type E2BProtocolAdapterConfig,
} from './types.js';

/**
 * Raw E2B API sandbox response shape (subset of E2B v2 OpenAPI).
 * Field names follow E2B convention; CubeSandbox mirrors them.
 */
interface E2BSandbox {
  sandboxID: string;
  templateID?: string;
  state?: string;
  startedAt?: string;
  endAt?: string;
  metadata?: Record<string, string>;
}

interface E2BExecResult {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

/** Map E2B state string → sandbank SandboxState. */
function mapState(s: string | undefined): SandboxState {
  switch (s) {
    case 'running':
      return 'running';
    case 'paused':
    case 'stopped':
      return 'stopped';
    case 'killed':
    case 'terminated':
    case 'end':
      return 'terminated';
    case 'pending':
    case 'creating':
      return 'creating';
    case 'error':
      return 'error';
    default:
      return 'running'; // E2B sometimes omits state on freshly created sandboxes
  }
}

/**
 * Shared base implementation of the E2B v2 HTTP protocol.
 *
 * NOT exported from the package — only used internally by
 * `E2BAdapter` (E2B Cloud / Infra) and `CubeSandboxAdapter` (Tencent self-hosted).
 *
 * Endpoint paths follow the E2B v2 OpenAPI:
 *   POST   /sandboxes
 *   GET    /sandboxes
 *   GET    /sandboxes/:id
 *   DELETE /sandboxes/:id
 *   POST   /sandboxes/:id/exec
 *
 * Subclasses set their own `name` for `provider.name` tagging
 * (`'e2b'` vs `'cube'`) and supply different defaults.
 */
export abstract class E2BProtocolAdapter implements SandboxAdapter {
  abstract readonly name: string;
  readonly capabilities: ReadonlySet<Capability> = E2B_PROTOCOL_CAPABILITIES;

  protected readonly apiUrl: string;
  protected readonly apiKey?: string;
  protected readonly timeoutMs: number;
  protected readonly fetchImpl: typeof fetch;

  constructor(cfg: E2BProtocolAdapterConfig) {
    if (!cfg.apiUrl) {
      throw new ProviderError(
        this.constructor.name,
        new Error('apiUrl is required')
      );
    }
    this.apiUrl = cfg.apiUrl.replace(/\/+$/, '');
    this.apiKey = cfg.apiKey;
    this.timeoutMs = cfg.timeoutMs ?? 30_000;
    this.fetchImpl = cfg.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async createSandbox(config: CreateConfig): Promise<AdapterSandbox> {
    const body: Record<string, unknown> = {
      templateID: config.image ?? 'base',
      metadata: config.env ?? {},
    };
    if (config.resources) {
      body.resources = config.resources;
    }
    if (config.autoDestroyMinutes) {
      body.timeoutMs = config.autoDestroyMinutes * 60_000;
    }
    const raw = await this.request<E2BSandbox>('POST', '/sandboxes', body);
    return this.wrap(raw);
  }

  async getSandbox(id: string): Promise<AdapterSandbox> {
    const raw = await this.request<E2BSandbox>('GET', `/sandboxes/${id}`);
    return this.wrap(raw);
  }

  async listSandboxes(filter?: ListFilter): Promise<SandboxInfo[]> {
    const raw = await this.request<E2BSandbox[]>('GET', '/sandboxes');
    const states = filter?.state
      ? Array.isArray(filter.state)
        ? filter.state
        : [filter.state]
      : null;
    const limit = filter?.limit ?? Infinity;
    return raw
      .map<SandboxInfo>((s) => ({
        id: s.sandboxID,
        state: mapState(s.state),
        createdAt: s.startedAt ?? new Date().toISOString(),
        image: s.templateID ?? 'base',
      }))
      .filter((info) => (states ? states.includes(info.state) : true))
      .slice(0, limit);
  }

  async destroySandbox(id: string): Promise<void> {
    try {
      await this.request('DELETE', `/sandboxes/${id}`);
    } catch (e) {
      if (e instanceof SandboxNotFoundError) return; // idempotent
      throw e;
    }
  }

  // ── internals ────────────────────────────────────────

  /** Issue an HTTP request against the E2B-compatible backend. */
  protected async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.apiUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (this.apiKey) headers['X-API-Key'] = this.apiKey;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (e) {
      throw new ProviderError(this.name, e);
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 404) {
      throw new SandboxNotFoundError(this.name, this.extractIdFromPath(path));
    }
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') ?? '0', 10);
      throw new RateLimitError(this.name, retryAfter || undefined);
    }
    if (!res.ok) {
      const text = await safeBody(res);
      throw new ProviderError(
        this.name,
        new Error(`HTTP ${res.status}: ${text}`)
      );
    }

    // 204 No Content
    if (res.status === 204 || res.headers.get('Content-Length') === '0') {
      return undefined as T;
    }
    return (await res.json()) as T;
  }

  private extractIdFromPath(path: string): string {
    const m = path.match(/\/sandboxes\/([^/?]+)/);
    return m?.[1] ?? '';
  }

  protected wrap(raw: E2BSandbox): AdapterSandbox {
    return new E2BAdapterSandbox(
      raw.sandboxID,
      mapState(raw.state),
      raw.startedAt ?? new Date().toISOString(),
      this.name,
      (cmd, opts) => this.execImpl(raw.sandboxID, cmd, opts)
    );
  }

  private async execImpl(
    sandboxId: string,
    command: string,
    options?: ExecOptions
  ): Promise<ExecResult> {
    const raw = await this.request<E2BExecResult>(
      'POST',
      `/sandboxes/${sandboxId}/exec`,
      {
        command,
        cwd: options?.cwd,
        timeoutMs: options?.timeout,
      }
    );
    return {
      stdout: raw.stdout ?? '',
      stderr: raw.stderr ?? '',
      exitCode: raw.exitCode ?? 0,
    };
  }
}

async function safeBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/** Concrete AdapterSandbox wrapping an E2B sandbox. */
class E2BAdapterSandbox implements AdapterSandbox {
  constructor(
    readonly id: string,
    readonly state: SandboxState,
    readonly createdAt: string,
    private readonly providerName: string,
    private readonly execFn: (cmd: string, opts?: ExecOptions) => Promise<ExecResult>
  ) {}

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    if (this.state === 'terminated' || this.state === 'error') {
      throw new ProviderError(
        this.providerName,
        new Error(`exec on ${this.state} sandbox is not allowed`),
        this.id
      );
    }
    return this.execFn(command, options);
  }
}
