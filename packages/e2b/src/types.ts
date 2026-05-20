import type { Capability } from '@douglas-agent/sandbank-core';

/** Base config shared by E2BAdapter / CubeSandboxAdapter. */
export interface E2BProtocolAdapterConfig {
  /**
   * Base URL of the E2B-compatible HTTP API.
   *
   * - E2B Cloud:  https://api.e2b.dev
   * - E2B Infra:  https://<your-deployment>.<domain>
   * - CubeSandbox: http://<host>:3000
   */
  apiUrl: string;

  /** Optional API key, sent as `X-API-Key` header. */
  apiKey?: string;

  /** Per-request timeout in ms. */
  timeoutMs?: number;

  /**
   * Custom fetch impl (mainly for testing with undici MockAgent).
   * @default globalThis.fetch
   */
  fetch?: typeof fetch;
}

/** E2BAdapter-specific config (E2B Cloud / Infra). */
export interface E2BAdapterConfig extends Partial<Omit<E2BProtocolAdapterConfig, 'apiUrl' | 'apiKey'>> {
  /** Defaults to E2B Cloud public endpoint. */
  apiUrl?: string;
  /** Required for E2B Cloud / E2B Infra. */
  apiKey: string;
}

/** CubeSandboxAdapter-specific config. */
export interface CubeSandboxAdapterConfig extends Partial<Omit<E2BProtocolAdapterConfig, 'apiUrl'>> {
  /** Self-hosted CubeSandbox cube-api URL (no default — caller-supplied). */
  apiUrl: string;
}

/** Capabilities shared by all E2B-protocol adapters. */
export const E2B_PROTOCOL_CAPABILITIES: ReadonlySet<Capability> = new Set([
  'exec.stream',
  'terminal',
  'sleep',
  'snapshot',
  'port.expose',
]);

/** E2B Cloud default endpoint. */
export const E2B_CLOUD_ENDPOINT = 'https://api.e2b.dev';
