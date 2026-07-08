/**
 * MCP conformance smoke via the official Inspector CLI. Starts the built MCP
 * server, then uses @modelcontextprotocol/inspector to list tools and call one,
 * asserting the server speaks the protocol over Streamable HTTP. No live LLM: the
 * server only parses GLBs, so this runs in CI.
 *
 * Usage: node scripts/mcp-conformance.mjs   (requires apps/server built)
 */
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER = `${ROOT}apps/server/dist/index.js`;
const PORT = process.env.CONFORMANCE_PORT ?? '3100';
const KEY = process.env.MCP_API_KEY ?? 'conformance-test-key';
const MCP_URL = `http://localhost:${PORT}/mcp`;
const INSPECTOR = '@modelcontextprotocol/inspector@0.22.0';
const EXPECTED_TOOLS = [
  'camera_focus', 'export_report', 'find_elements', 'get_scene_stats',
  'highlight_elements', 'list_models', 'load_model', 'measure', 'suggest_optimizations',
];

function fail(msg) {
  console.error(`CONFORMANCE FAIL: ${msg}`);
  process.exitCode = 1;
}

function inspect(args) {
  const cmd =
    `npx --yes ${INSPECTOR} --cli ${MCP_URL} --transport http ` +
    `--header "Authorization: Bearer ${KEY}" ${args}`;
  const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const start = out.indexOf('{');
  const end = out.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error(`no JSON in inspector output:\n${out}`);
  return JSON.parse(out.slice(start, end + 1));
}

async function main() {
  if (!existsSync(SERVER)) {
    fail(`server bundle missing at ${SERVER}; run: pnpm --filter @modelsense/server build`);
    return;
  }

  const server = spawn('node', [SERVER], {
    env: { ...process.env, PORT, MCP_API_KEY: KEY },
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  try {
    // Wait for the server to accept connections.
    let up = false;
    for (let i = 0; i < 40; i++) {
      try {
        const res = await fetch(`http://localhost:${PORT}/healthz`);
        if (res.ok) { up = true; break; }
      } catch {
        // not yet listening
      }
      await sleep(500);
    }
    if (!up) return fail('server did not become healthy in 20s');

    // 1. tools/list must return exactly the nine tools.
    const list = inspect('--method tools/list');
    const names = (list.tools ?? []).map((t) => t.name).sort();
    console.log(`tools/list -> ${names.length} tools: ${names.join(', ')}`);
    if (JSON.stringify(names) !== JSON.stringify(EXPECTED_TOOLS)) {
      return fail(`expected ${EXPECTED_TOOLS.length} tools, got ${names.length}: ${names.join(', ')}`);
    }

    // 2. tools/call load_model must return structured scene data.
    const call = inspect('--method tools/call --tool-name load_model --tool-arg model_id=DamagedHelmet');
    const text = JSON.stringify(call);
    if (!text.includes('session_id') || !text.includes('triangles')) {
      return fail(`load_model result missing session_id/triangles: ${text.slice(0, 300)}`);
    }
    console.log('tools/call load_model -> ok (session + stats returned)');
    console.log('CONFORMANCE PASS');
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  } finally {
    server.kill('SIGTERM');
  }
}

main();
