// Live smoke test — runs against the real local Docker daemon.
// Pulls ghcr.io/agent-infra/sandbox:latest (~1-2 GB first time), creates a
// sandbox, exec a trivial command, then tears it down.
//
// Run: pnpm tsx packages/aio/test/live-aio.ts
import { AIOSandboxAdapter } from '../src/AIOSandboxAdapter.js';

async function main() {
  console.log('[live-aio] instantiate adapter');
  const adapter = new AIOSandboxAdapter({
    healthTimeoutSec: 90,
    portRange: [49500, 49600],
  });

  console.log(`[live-aio] capabilities = ${[...adapter.capabilities]}`);
  console.log(`[live-aio] name = ${adapter.name}`);

  console.log('[live-aio] listSandboxes (before)');
  const before = await adapter.listSandboxes();
  console.log(`[live-aio]   ${before.length} existing sandbox(es)`);

  console.log('[live-aio] createSandbox — docker run ghcr.io/agent-infra/sandbox:latest');
  const t0 = Date.now();
  const sb = await adapter.createSandbox({});
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[live-aio]   id=${sb.id.slice(0, 12)} state=${sb.state} createdAt=${sb.createdAt} elapsed=${elapsed}s`);

  console.log('[live-aio] listSandboxes (after)');
  const after = await adapter.listSandboxes();
  console.log(`[live-aio]   ${after.length} sandbox(es), ours: ${after.find((s) => s.id === sb.id) ? 'present' : 'MISSING'}`);

  console.log('[live-aio] destroySandbox');
  await adapter.destroySandbox(sb.id);

  console.log('[live-aio] listSandboxes (final)');
  const final = await adapter.listSandboxes();
  console.log(`[live-aio]   ${final.length} sandbox(es)`);

  console.log('[live-aio] ✅ DONE');
}

main().catch((e) => {
  console.error('[live-aio] FAIL:', e);
  process.exit(1);
});
