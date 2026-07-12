import type { Page, Route } from '@playwright/test';

/**
 * Mock the agent service at the network layer so e2e is deterministic and never
 * calls a live API. The web client talks to VITE_AGENT_URL (default
 * http://localhost:8787), a different origin than the app, so the fulfilled
 * responses carry CORS headers and OPTIONS preflights are answered.
 */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'Content-Type',
};

/** Build an SSE body from a list of AgentEvent objects, ending with the end frame. */
export function sseBody(events: unknown[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'event: end\ndata: {}\n\n';
}

/** What the client POSTs to /chat/approve. Captured so a spec can assert the exact
 * decision reached the server (guards against the field being renamed/dropped). */
export interface ApproveBody {
  id?: string;
  approved?: boolean;
}

export async function mockAgent(
  page: Page,
  events: unknown[],
  opts: { approveLog?: ApproveBody[]; hangChat?: boolean } = {},
): Promise<void> {
  const preflight = (route: Route) => route.fulfill({ status: 204, headers: CORS });

  await page.route('**/healthz', (route) =>
    route.request().method() === 'OPTIONS'
      ? preflight(route)
      : route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: '{"status":"ok"}' }),
  );

  await page.route('**/chat/approve', (route) => {
    if (route.request().method() === 'OPTIONS') return preflight(route);
    if (opts.approveLog) {
      try {
        opts.approveLog.push(route.request().postDataJSON() as ApproveBody);
      } catch {
        opts.approveLog.push({});
      }
    }
    return route.fulfill({
      status: 200,
      headers: CORS,
      contentType: 'application/json',
      body: '{"ok":true}',
    });
  });

  await page.route('**/chat', async (route) => {
    if (route.request().method() === 'OPTIONS') return preflight(route);
    if (opts.hangChat) {
      // Hold the response so the turn stays in flight; the Stop test aborts the
      // fetch before this resolves. Guarded because the aborted fulfill throws.
      await new Promise((r) => setTimeout(r, 10_000));
      try {
        await route.fulfill({ status: 200, headers: CORS, contentType: 'text/event-stream', body: sseBody(events) });
      } catch {
        // request was aborted by the client (Stop) - expected.
      }
      return;
    }
    return route.fulfill({
      status: 200,
      headers: CORS,
      contentType: 'text/event-stream',
      body: sseBody(events),
    });
  });
}

const t = (name: string) => `mcp__modelsense__${name}`;

/** A canned find -> highlight turn (the Phase 2 demo), for reuse across specs. */
export const HIGHLIGHT_TURN = [
  { t: 'tool', phase: 'call', name: t('load_model'), id: 'a', input: { model_id: 'DamagedHelmet' } },
  { t: 'tool', phase: 'call', name: t('find_elements'), id: 'b', input: { query: 'wheel' } },
  { t: 'text', text: 'Found 2 wheel nodes and highlighted the largest.' },
  { t: 'scene', command: { type: 'highlight', nodeIds: ['Wheels'], color: '#ffcc00', exclusive: false } },
  { t: 'tool', phase: 'result', name: t('find_elements'), id: 'b', ok: true, output: { total: 2 } },
  { t: 'done', turns: 4, costUsd: 0.12, durationMs: 8000, inputTokens: 5000, outputTokens: 200 },
];

/**
 * A find -> highlight turn that emits a highlight scene command for the given
 * truck node ids. Used by the highlight-fidelity spec to check the command
 * actually lands on the matching mesh(es) in the live scene.
 */
export function truckHighlightTurn(nodeIds: string[]): unknown[] {
  return [
    { t: 'tool', phase: 'call', name: t('load_model'), id: 'a', input: { model_id: 'CesiumMilkTruck' } },
    { t: 'tool', phase: 'call', name: t('find_elements'), id: 'b', input: { query: 'wheel' } },
    { t: 'tool', phase: 'call', name: t('highlight_elements'), id: 'c', input: { node_ids: nodeIds } },
    { t: 'text', text: `Highlighted ${nodeIds.join(', ')}.` },
    { t: 'scene', command: { type: 'highlight', nodeIds, color: '#ffcc00', exclusive: true } },
    { t: 'done', turns: 4, costUsd: 0.05, durationMs: 8000, inputTokens: 2600, outputTokens: 400 },
  ];
}

/**
 * A find -> highlight turn for the Box model, whose single mesh node is UNNAMED,
 * so the server addresses it positionally as `node-<index>`. Used to guard that
 * the viewer resolves those synthetic ids (H1), not just glTF names.
 */
export function boxHighlightTurn(nodeIds: string[]): unknown[] {
  return [
    { t: 'tool', phase: 'call', name: t('load_model'), id: 'a', input: { model_id: 'Box' } },
    { t: 'tool', phase: 'call', name: t('find_elements'), id: 'b', input: { query: '' } },
    { t: 'tool', phase: 'call', name: t('highlight_elements'), id: 'c', input: { node_ids: nodeIds } },
    { t: 'text', text: `Highlighted the largest mesh (${nodeIds.join(', ')}).` },
    { t: 'scene', command: { type: 'highlight', nodeIds, color: '#ffcc00', exclusive: true } },
    { t: 'done', turns: 4, costUsd: 0.05, durationMs: 8000, inputTokens: 2600, outputTokens: 400 },
  ];
}

/** A turn that streams a tool call then fails with an error frame (no `done`). */
export const ERROR_TURN = [
  { t: 'tool', phase: 'call', name: t('load_model'), id: 'a', input: { model_id: 'DamagedHelmet' } },
  { t: 'error', message: 'Agent error' },
];

/** A gated export_report turn that asks for approval. */
export const APPROVAL_TURN = [
  { t: 'tool', phase: 'call', name: t('load_model'), id: 'a', input: { model_id: 'DamagedHelmet' } },
  { t: 'approval', id: 'appr-1', tool: t('export_report'), input: { format: 'markdown' } },
  { t: 'text', text: 'Report exported after your approval.' },
  { t: 'done', turns: 3, costUsd: 0.1, durationMs: 6000, inputTokens: 4000, outputTokens: 150 },
];
