import type { Capability } from '@douglas-agent/sandbank-core';

/**
 * Configuration for MicrosandboxAdapter.
 *
 * The adapter is a thin HTTP client that talks to a `microsandbox-shim` service
 * (typically deployed on a Linux host with KVM enabled). The shim then spawns
 * microVMs locally via the `microsandbox` SDK + libkrun. See:
 *   - openspec/changes/add-microsandbox-private-fallback/design.md (parent repo)
 *   - services/microsandbox-shim/ (parent repo)
 *   - docs/spikes/s13-microsandbox-on-wsl.md (parent repo)
 */
export interface MicrosandboxAdapterConfig {
  /**
   * Base URL of the microsandbox-shim service.
   * Typically a Tailscale tailnet address: `http://100.116.83.96:8200`.
   */
  apiUrl: string;

  /**
   * Bearer token for the shim service. Required — the shim rejects
   * unauthenticated requests with HTTP 401.
   */
  bearerToken: string;

  /**
   * Optional fetch implementation override (default: global `fetch`).
   * Mainly for testing.
   */
  fetchImpl?: typeof fetch;

  /**
   * Default vCPU count for created sandboxes. The shim forwards this to
   * `Sandbox.builder().cpus(n)`. If omitted, the shim picks a default.
   */
  defaultCpus?: number;

  /**
   * Default guest memory in MiB. The shim forwards this to
   * `Sandbox.builder().memory(mib)`. If omitted, the shim picks a default.
   */
  defaultMemoryMiB?: number;
}

/** Capabilities declared by MicrosandboxAdapter. */
export const MICROSANDBOX_CAPABILITIES: ReadonlySet<Capability> = new Set([
  'exec.stream',
  'terminal',
  'sleep',
  'snapshot',
  'port.expose',
]);

/** Shim wire format — mirrors services/microsandbox-shim/src/types.ts. */
export interface ShimSandboxInfo {
  id: string;
  image: string;
  status: 'running' | 'stopped' | 'destroyed';
  createdAt: string;
}

export interface ShimExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ShimExecStreamEvent =
  | { kind: 'stdout'; data: string }
  | { kind: 'stderr'; data: string }
  | { kind: 'exited'; exitCode: number };
