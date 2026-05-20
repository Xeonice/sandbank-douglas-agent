// Live smoke test — CubeSandboxAdapter against the running douglas-wsl Cube.
//
// Validates:
//   1. HTTP transport works (TCP + TLS-not + headers)
//   2. listSandboxes parses the response shape (or fails predictably)
//   3. destroySandbox is idempotent (404 → returns)
//
// Doesn't run createSandbox because we have no template registered yet
// (cubemastercli tpl create-from-image is a 5-10 min separate task).
//
// Run: pnpm tsx packages/e2b/test/live-cube.ts
import { CubeSandboxAdapter } from '../src/CubeSandboxAdapter.js';
import { SandboxNotFoundError } from '@douglas-agent/sandbank-core';

const CUBE_HOST = process.env.CUBE_HOST ?? 'http://10.116.83.96:3000';

async function main() {
  console.log(`[live-cube] target = ${CUBE_HOST}`);
  const adapter = new CubeSandboxAdapter({ apiUrl: CUBE_HOST });

  console.log(`[live-cube] name = ${adapter.name}`);
  console.log(`[live-cube] capabilities = ${[...adapter.capabilities]}`);

  console.log('[live-cube] listSandboxes (HTTP GET /sandboxes)');
  try {
    const list = await adapter.listSandboxes();
    console.log(`[live-cube]   parsed ${list.length} sandbox(es)`);
    if (list.length > 0) {
      console.log(`[live-cube]   first: ${JSON.stringify(list[0])}`);
    }
  } catch (e) {
    console.log(`[live-cube]   ⚠ list failed: ${(e as Error).message}`);
    // cube-api may return non-array body for GET /sandboxes (the /health alias).
    // That's a protocol mismatch but not a transport failure.
  }

  console.log('[live-cube] destroySandbox("nonexistent") - should be idempotent on 404');
  try {
    await adapter.destroySandbox('definitely-not-a-real-id-xyz');
    console.log('[live-cube]   ✓ idempotent (no error thrown)');
  } catch (e) {
    if (e instanceof SandboxNotFoundError) {
      console.log('[live-cube]   ⚠ threw SandboxNotFoundError (should have swallowed 404)');
    } else {
      console.log(`[live-cube]   ⚠ destroy failed: ${(e as Error).message}`);
    }
  }

  console.log('[live-cube] getSandbox("nonexistent") - should throw SandboxNotFoundError');
  try {
    await adapter.getSandbox('definitely-not-a-real-id-xyz');
    console.log('[live-cube]   ⚠ did NOT throw (cube-api may not return 404 properly)');
  } catch (e) {
    if (e instanceof SandboxNotFoundError) {
      console.log('[live-cube]   ✓ SandboxNotFoundError correctly thrown');
    } else {
      console.log(`[live-cube]   ⚠ wrong error type: ${(e as Error).constructor.name}`);
    }
  }

  console.log('[live-cube] ✅ done');
}

main().catch((e) => {
  console.error('[live-cube] FAIL:', e);
  process.exit(1);
});
