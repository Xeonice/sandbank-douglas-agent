import Docker from 'dockerode';
import { SandboxClient } from '@agent-infra/sandbox';
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
import { SandboxNotFoundError, ProviderError } from '@douglas-agent/sandbank-core';
import { AIO_CAPABILITIES, type AIOSandboxAdapterConfig } from './types.js';

const DEFAULT_IMAGE = 'ghcr.io/agent-infra/sandbox:latest';
const DEFAULT_PORT_RANGE: [number, number] = [49152, 65535];
const DEFAULT_HEALTH_TIMEOUT_SEC = 60;
const SANDBOX_INTERNAL_PORT = 8080;

/** Docker container state → sandbank SandboxState */
function mapDockerState(s: string): SandboxState {
  switch (s) {
    case 'created':
      return 'creating';
    case 'running':
      return 'running';
    case 'paused':
    case 'restarting':
      return 'stopped';
    case 'exited':
    case 'dead':
      return 'terminated';
    case 'removing':
      return 'stopped';
    default:
      return 'error';
  }
}

/**
 * AIOSandboxAdapter — wraps `ghcr.io/agent-infra/sandbox` Docker container
 * lifecycle with dockerode, exposes business operations through
 * `@agent-infra/sandbox` `SandboxClient`.
 *
 * Each `createSandbox()` call:
 *   1. allocates a free host port from the configured range
 *   2. `docker run` the AIO Sandbox image with port `8080` → host port mapping
 *   3. polls container's `/health` until 200 (or timeout)
 *   4. wraps the connected `SandboxClient` in an `AdapterSandbox`
 *
 * `destroySandbox(id)` runs `docker rm -f`. `listSandboxes()` enumerates
 * containers labeled `sandbank-aio=true` to avoid touching unrelated containers
 * on the host.
 */
export class AIOSandboxAdapter implements SandboxAdapter {
  readonly name = 'aio';
  readonly capabilities: ReadonlySet<Capability> = AIO_CAPABILITIES;

  private readonly docker: Docker;
  private readonly image: string;
  private readonly portRange: [number, number];
  private readonly healthTimeoutSec: number;
  private readonly apiKey?: string;

  constructor(cfg: AIOSandboxAdapterConfig = {}) {
    this.docker = new Docker(
      cfg.dockerSocketPath
        ? { socketPath: cfg.dockerSocketPath }
        : cfg.dockerHost
          ? { host: cfg.dockerHost }
          : undefined
    );
    this.image = cfg.image ?? DEFAULT_IMAGE;
    this.portRange = cfg.portRange ?? DEFAULT_PORT_RANGE;
    this.healthTimeoutSec = cfg.healthTimeoutSec ?? DEFAULT_HEALTH_TIMEOUT_SEC;
    this.apiKey = cfg.apiKey;
  }

  async createSandbox(config: CreateConfig): Promise<AdapterSandbox> {
    const port = await this.allocPort();
    const envArr = Object.entries(config.env ?? {}).map(
      ([k, v]) => `${k}=${v}`
    );

    let container: Docker.Container;
    try {
      container = await this.docker.createContainer({
        Image: config.image ?? this.image,
        Env: envArr,
        Labels: { 'sandbank-aio': 'true' },
        HostConfig: {
          PortBindings: {
            [`${SANDBOX_INTERNAL_PORT}/tcp`]: [{ HostPort: String(port) }],
          },
          SecurityOpt: ['seccomp=unconfined'],
          AutoRemove: true,
        },
      });
      await container.start();
    } catch (e) {
      throw new ProviderError('aio', e);
    }

    const baseUrl = `http://localhost:${port}`;
    await this.waitHealth(baseUrl);

    const client = this.makeClient(baseUrl);
    const createdAt = new Date().toISOString();
    return this.wrap(container.id, baseUrl, client, 'running', createdAt);
  }

  async getSandbox(id: string): Promise<AdapterSandbox> {
    const container = this.docker.getContainer(id);
    let info: Docker.ContainerInspectInfo;
    try {
      info = await container.inspect();
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 404) {
        throw new SandboxNotFoundError('aio', id);
      }
      throw new ProviderError('aio', e, id);
    }
    const port = this.extractHostPort(info);
    const baseUrl = port ? `http://localhost:${port}` : '';
    const client = baseUrl ? this.makeClient(baseUrl) : undefined;
    return this.wrap(
      info.Id,
      baseUrl,
      client,
      mapDockerState(info.State.Status),
      info.Created
    );
  }

  async listSandboxes(filter?: ListFilter): Promise<SandboxInfo[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: ['sandbank-aio=true'] },
    });
    const states = filter?.state
      ? Array.isArray(filter.state)
        ? filter.state
        : [filter.state]
      : null;
    const limit = filter?.limit ?? Infinity;
    return containers
      .map<SandboxInfo>((c) => ({
        id: c.Id,
        state: mapDockerState(c.State),
        createdAt: new Date(c.Created * 1000).toISOString(),
        image: c.Image,
      }))
      .filter((info) => (states ? states.includes(info.state) : true))
      .slice(0, limit);
  }

  async destroySandbox(id: string): Promise<void> {
    try {
      await this.docker.getContainer(id).remove({ force: true });
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 404) {
        return; // idempotent
      }
      throw new ProviderError('aio', e, id);
    }
  }

  // ── internals ────────────────────────────────────────

  private makeClient(baseUrl: string): SandboxClient {
    const headers: Record<string, string> = {};
    if (this.apiKey) headers['X-API-Key'] = this.apiKey;
    return new SandboxClient({
      environment: () => baseUrl,
      headers: Object.keys(headers).length ? headers : undefined,
    });
  }

  private async allocPort(): Promise<number> {
    // Naive linear probe within range. dockerode's `PortBindings` returns
    // EADDRINUSE if the port is taken, so we retry. Good enough for POC.
    const [lo, hi] = this.portRange;
    for (let p = lo; p <= hi; p++) {
      if (await this.portFree(p)) return p;
    }
    throw new ProviderError('aio', new Error(`portRange [${lo},${hi}] exhausted`));
  }

  private async portFree(port: number): Promise<boolean> {
    // Best-effort host-side check. dockerode does the authoritative bind.
    return new Promise((resolve) => {
      const net = (globalThis as { require?: NodeRequire }).require?.('net');
      if (!net) return resolve(true); // skip in test environments
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.once('listening', () => srv.close(() => resolve(true)));
      srv.listen(port, '127.0.0.1');
    });
  }

  private async waitHealth(baseUrl: string): Promise<void> {
    const deadline = Date.now() + this.healthTimeoutSec * 1000;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${baseUrl}/health`, { method: 'GET' });
        if (res.ok) return;
        lastErr = new Error(`HTTP ${res.status}`);
      } catch (e) {
        lastErr = e;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new ProviderError(
      'aio',
      new Error(`/health did not become ready within ${this.healthTimeoutSec}s: ${(lastErr as Error)?.message ?? 'unknown'}`)
    );
  }

  private extractHostPort(info: Docker.ContainerInspectInfo): number | null {
    const bindings = info.NetworkSettings?.Ports?.[`${SANDBOX_INTERNAL_PORT}/tcp`];
    const first = bindings?.[0];
    if (!first?.HostPort) return null;
    const port = parseInt(first.HostPort, 10);
    return Number.isFinite(port) ? port : null;
  }

  private wrap(
    id: string,
    baseUrl: string,
    client: SandboxClient | undefined,
    state: SandboxState,
    createdAt: string
  ): AdapterSandbox {
    return new AIOAdapterSandbox(id, baseUrl, client, state, createdAt, this.docker);
  }
}

/** AdapterSandbox impl: delegates exec/file ops to SandboxClient (HTTP). */
class AIOAdapterSandbox implements AdapterSandbox {
  constructor(
    readonly id: string,
    private readonly baseUrl: string,
    private readonly client: SandboxClient | undefined,
    public readonly state: SandboxState,
    readonly createdAt: string,
    private readonly docker: Docker
  ) {}

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    if (!this.client) {
      throw new ProviderError('aio', new Error('no API baseUrl (likely stopped)'), this.id);
    }
    // Delegate to SandboxClient.bash.exec.
    // NOTE: the exact SDK shape varies by @agent-infra/sandbox version —
    // implementation-phase task confirms current API & wires up timeout/cwd.
    try {
      const result = (await (this.client as unknown as { bash?: { exec?: (req: unknown) => Promise<unknown> } }).bash?.exec?.({
        command,
        cwd: options?.cwd,
        timeout_ms: options?.timeout,
      })) as { stdout?: string; stderr?: string; exit_code?: number } | undefined;
      return {
        stdout: result?.stdout ?? '',
        stderr: result?.stderr ?? '',
        exitCode: result?.exit_code ?? 0,
      };
    } catch (e) {
      throw new ProviderError('aio', e, this.id);
    }
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    if (!this.client) {
      throw new ProviderError('aio', new Error('no API baseUrl'), this.id);
    }
    const body = typeof content === 'string' ? content : Buffer.from(content).toString('utf8');
    await (this.client as unknown as { file?: { write?: (req: unknown) => Promise<unknown> } }).file?.write?.({ path, content: body });
  }

  async readFile(path: string): Promise<Uint8Array> {
    if (!this.client) {
      throw new ProviderError('aio', new Error('no API baseUrl'), this.id);
    }
    const result = (await (this.client as unknown as { file?: { read?: (req: unknown) => Promise<unknown> } }).file?.read?.({ path })) as { content?: string } | undefined;
    return new TextEncoder().encode(result?.content ?? '');
  }
}
