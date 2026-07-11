import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from './http';

// End-to-end over real HTTP: auth, stateless Streamable HTTP, the tool wrapper,
// the cross-request session store, and structured (isError) errors. Fully
// offline, so it doubles as the CI conformance smoke test.

const API_KEY = 'test-key';
// Generous per-test timeouts: loading express + the MCP SDK the first time is
// slow on cold/contended machines; the assertions themselves are instant.
const T = 20_000;

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = createApp({ port: 0, mcpApiKey: API_KEY, allowedOrigins: [] });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
}, 30_000);

afterAll(() => {
  server?.close();
});

async function connect(): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${API_KEY}` } },
  });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(transport);
  return { client, transport };
}

describe('MCP server over HTTP', () => {
  it(
    'rejects an unauthenticated request with 401',
    async () => {
      // GET carries no body, so there is no request-body drain to race the
      // response; the auth middleware answers immediately.
      const res = await fetch(`${baseUrl}/mcp`, { method: 'GET' });
      expect(res.status).toBe(401);
    },
    T,
  );

  it(
    'returns 405 for authenticated GET and DELETE (stateless: no protocol sessions)',
    async () => {
      const headers = { Authorization: `Bearer ${API_KEY}` };
      const get = await fetch(`${baseUrl}/mcp`, { method: 'GET', headers });
      expect(get.status).toBe(405);
      const del = await fetch(`${baseUrl}/mcp`, { method: 'DELETE', headers });
      expect(del.status).toBe(405);
    },
    T,
  );

  it(
    'lists all nine tools',
    async () => {
      const { client, transport } = await connect();
      try {
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name).sort()).toEqual([
          'camera_focus',
          'export_report',
          'find_elements',
          'get_scene_stats',
          'highlight_elements',
          'list_models',
          'load_model',
          'measure',
          'suggest_optimizations',
        ]);
      } finally {
        await transport.close();
      }
    },
    T,
  );

  it(
    'runs a load -> find -> highlight flow across separate requests',
    async () => {
      const { client, transport } = await connect();
      try {
        const loaded = await client.callTool({
          name: 'load_model',
          arguments: { model_id: 'CesiumMilkTruck' },
        });
        const summary = loaded.structuredContent as {
          session_id: string;
          counts: { nodes: number };
        };
        expect(summary.session_id).toBeTruthy();
        expect(summary.counts.nodes).toBe(6);

        // The session minted above must survive into this separate request even
        // though the server is stateless (state lives in the module session store).
        const found = await client.callTool({
          name: 'find_elements',
          arguments: { session_id: summary.session_id, query: 'wheel' },
        });
        expect((found.structuredContent as { total: number }).total).toBe(2);

        const highlighted = await client.callTool({
          name: 'highlight_elements',
          arguments: { session_id: summary.session_id, node_ids: ['Wheels', 'Wheels.001'] },
        });
        const cmd = highlighted.structuredContent as { type: string; nodeIds: string[] };
        expect(cmd.type).toBe('highlight');
        expect(cmd.nodeIds).toEqual(['Wheels', 'Wheels.001']);
      } finally {
        await transport.close();
      }
    },
    T,
  );

  it(
    'returns a structured tool error (isError) for an expired/unknown session',
    async () => {
      const { client, transport } = await connect();
      try {
        const res = await client.callTool({
          name: 'get_scene_stats',
          arguments: { session_id: 'does-not-exist' },
        });
        expect(res.isError).toBe(true);
      } finally {
        await transport.close();
      }
    },
    T,
  );
});
