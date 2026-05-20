import { ProviderError } from '@douglas-agent/sandbank-core';
import { E2BProtocolAdapter } from './E2BProtocolAdapter.js';
import { E2B_CLOUD_ENDPOINT, type E2BAdapterConfig } from './types.js';

/**
 * E2B Cloud / E2B Infra adapter.
 *
 * Defaults `apiUrl` to E2B Cloud public endpoint; requires `apiKey`.
 * For E2B Infra self-hosted: pass your deployment URL via `apiUrl`.
 *
 * Provider tag: `'e2b'`.
 */
export class E2BAdapter extends E2BProtocolAdapter {
  readonly name = 'e2b';

  constructor(cfg: E2BAdapterConfig) {
    if (!cfg.apiKey) {
      throw new ProviderError(
        'e2b',
        new Error('E2BAdapter requires apiKey (E2B Cloud / Infra both authenticate via X-API-Key)')
      );
    }
    super({
      apiUrl: cfg.apiUrl ?? E2B_CLOUD_ENDPOINT,
      apiKey: cfg.apiKey,
      timeoutMs: cfg.timeoutMs,
      fetch: cfg.fetch,
    });
  }
}
