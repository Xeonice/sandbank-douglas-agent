import type { Capability } from '@douglas-agent/sandbank-core';

/**
 * Configuration for AIOSandboxAdapter.
 *
 * The adapter uses dockerode to manage container lifecycle (create / destroy)
 * and `@agent-infra/sandbox` `SandboxClient` to talk to the sandbox HTTP API
 * once the container is healthy.
 */
export interface AIOSandboxAdapterConfig {
  /**
   * AIO Sandbox container image. Defaults to upstream release.
   * @default 'ghcr.io/agent-infra/sandbox:latest'
   */
  image?: string;

  /**
   * Docker daemon socket path. When undefined, dockerode falls back to its
   * default (Unix socket on Linux/macOS, named pipe on Windows).
   * @example '/var/run/docker.sock'
   */
  dockerSocketPath?: string;

  /**
   * Docker daemon TCP endpoint (alternative to socket path).
   * @example 'tcp://localhost:2375'
   */
  dockerHost?: string;

  /**
   * Host port range to allocate for sandbox HTTP API binding.
   * Each `createSandbox` reserves one port from this range.
   * @default [49152, 65535]   // standard ephemeral range
   */
  portRange?: [number, number];

  /**
   * Max seconds to wait for readiness probe after `docker start`.
   * Only relevant when `readinessProbe` is set.
   * @default 60
   */
  healthTimeoutSec?: number;

  /**
   * Optional HTTP readiness probe path.
   *
   * When set, `createSandbox` polls `GET http://<baseUrl>/<path>` until 200
   * (or timeout). When undefined (default), no HTTP probe — only wait for
   * the container to reach 'running' state.
   *
   * Use cases:
   *  - AIO Sandbox image: set `{ path: '/v1/sandbox' }`
   *  - Generic image (task-runner self-bootstrap): leave undefined
   *
   * @default undefined (no HTTP probe)
   */
  readinessProbe?: {
    path: string;
  };

  /**
   * Optional API key forwarded to SandboxClient via `X-API-Key` header.
   * Most self-hosted AIO Sandbox deployments leave this unset.
   */
  apiKey?: string;
}

/** Capabilities declared by AIOSandboxAdapter. */
export const AIO_CAPABILITIES: ReadonlySet<Capability> = new Set([
  'exec.stream',
  'terminal',
  'port.expose',
]);
