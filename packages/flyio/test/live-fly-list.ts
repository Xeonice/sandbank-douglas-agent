// Live smoke — exercise the FlyioAdapter against the real Fly Machines API.
// Calls listSandboxes() (read-only, zero cost) to verify the fork's renamed
// scope hasn't broken the upstream Fly REST path.
//
// Env required:
//   FLY_API_TOKEN  – `flyctl tokens create` output (current macbook token works)
//   FLY_APP_NAME   – defaults to 'openspec-task-runner'
//
// Run:
//   FLY_API_TOKEN=$(flyctl tokens create -x 1h) \
//     pnpm tsx packages/flyio/test/live-fly-list.ts
import { FlyioAdapter } from '../src/adapter.js';

const TOKEN = process.env.FLY_API_TOKEN;
const APP = process.env.FLY_APP_NAME ?? 'openspec-task-runner';

if (!TOKEN) {
  console.error('FLY_API_TOKEN env var required');
  process.exit(1);
}

async function main() {
  console.log(`[live-fly] target = app=${APP}`);
  const adapter = new FlyioAdapter({ apiToken: TOKEN!, appName: APP });

  console.log(`[live-fly] name = ${adapter.name}`);
  console.log(`[live-fly] capabilities = ${[...adapter.capabilities]}`);

  console.log('[live-fly] listSandboxes — GET /apps/<app>/machines');
  const t0 = Date.now();
  let list;
  try {
    list = await adapter.listSandboxes();
  } catch (e) {
    console.error(`[live-fly] ✗ list failed: ${(e as Error).message}`);
    process.exit(1);
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(`[live-fly]   ${list.length} machine(s) returned · ${elapsed}s`);
  for (const info of list.slice(0, 3)) {
    console.log(`[live-fly]   id=${info.id.slice(0, 16)} state=${info.state} image=${info.image.slice(0, 50)}`);
  }
  if (list.length > 3) console.log(`[live-fly]   ... and ${list.length - 3} more`);

  console.log('[live-fly] ✅ DONE — fork repo @douglas-agent/sandbank-flyio reaches Fly REST API correctly');
}

main().catch((e) => {
  console.error('[live-fly] FAIL:', e);
  process.exit(1);
});
