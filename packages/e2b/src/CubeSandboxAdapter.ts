import { ProviderError } from '@douglas-agent/sandbank-core';
import { E2BProtocolAdapter } from './E2BProtocolAdapter.js';
import type { CubeSandboxAdapterConfig } from './types.js';

/**
 * Tencent CubeSandbox adapter.
 *
 * CubeSandbox implements the E2B v2 HTTP protocol on top of self-hosted
 * KVM+RustVMM microVMs. No default `apiUrl` — caller must supply their
 * self-hosted cube-api URL (typically `http://<host>:3000`).
 *
 * `apiKey` is optional (CubeSandbox installs default to no auth).
 *
 * Provider tag: `'cube'` (distinct from `'e2b'` for monitoring / billing
 * / log tagging separation).
 */
export class CubeSandboxAdapter extends E2BProtocolAdapter {
  readonly name = 'cube';

  constructor(cfg: CubeSandboxAdapterConfig) {
    if (!cfg.apiUrl) {
      throw new ProviderError(
        'cube',
        new Error('CubeSandboxAdapter requires apiUrl (self-hosted cube-api URL, e.g. http://10.116.83.96:3000)')
      );
    }
    super({
      apiUrl: cfg.apiUrl,
      apiKey: cfg.apiKey,
      timeoutMs: cfg.timeoutMs,
      fetch: cfg.fetch,
    });
  }
}
