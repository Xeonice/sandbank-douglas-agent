// E2BProtocolAdapter intentionally NOT exported — it is an internal base class.
// Consumers pick one of the concrete adapters based on the backend they target.
export { E2BAdapter } from './E2BAdapter.js';
export { CubeSandboxAdapter } from './CubeSandboxAdapter.js';
export {
  E2B_PROTOCOL_CAPABILITIES,
  E2B_CLOUD_ENDPOINT,
  type E2BAdapterConfig,
  type CubeSandboxAdapterConfig,
} from './types.js';
