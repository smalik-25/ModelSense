# Auth design and upgrade path

The MCP server ships with a shared bearer token (`MCP_API_KEY`). This note records
why, the threat model it covers, and the concrete path to a real authorization
scheme. It is the Phase 5 "documented scoped-key design with rationale."

## Today: shared bearer token

- Every request to `POST /mcp` must carry `Authorization: Bearer <MCP_API_KEY>`.
  The agent service and MCP Inspector send it; a browser Origin that is not
  allowlisted gets a 403 before auth.
- The token is a single shared secret, injected as an env var on Render and never
  committed. Rotating it is a dashboard edit plus a redeploy.
- What this covers: keeps the public `/mcp` endpoint from being a wide-open tool
  server, and keeps the deploy simple while the surface is one server and one
  agent. What it does not cover: per-caller identity, scopes, revocation of a
  single client, or audit by principal.

## Why not more yet

The server is stateless and read-mostly; the only state is an in-memory
`session_id` LRU, and the only gated action (`export_report`) is guarded at the
agent layer by a human approval, not by server-side authz. A shared secret is the
right amount of auth for that surface. Adding OAuth earlier would be ceremony
without a second relying party.

## Upgrade path (in order)

### 1. Scoped keys (small step, no new infra)

Replace the single `MCP_API_KEY` with a small set of named keys, each mapped to a
scope set:

```
keys:
  agent-prod:   [tools:read, tools:scene]        # inspect + highlight/camera/measure
  eval-runner:  [tools:read, tools:scene, report:export]
  inspector:    [tools:read]
```

- Middleware resolves the bearer to a principal + scopes; each tool declares a
  required scope; unmatched scope returns a structured tool error, not a 500.
- Keys live in a JSON secret (or a KV store) so one client can be revoked without
  rotating everyone. This is a day of work and no new services.

### 2. OAuth 2.1 resource server (the real thing)

When there is a second first-party client or any third-party access, make the MCP
server an OAuth 2.1 **resource server** per the MCP authorization spec:

- The server advertises its authorization server via
  `WWW-Authenticate` / protected-resource metadata.
- Callers present short-lived access tokens (JWT) minted by the auth server; the
  MCP server validates signature, `aud`, `exp`, and scopes on every request.
- Scopes map to the same tool-scope table as step 1, so the tool-side check does
  not change - only how the principal is established.
- The agent service obtains tokens via client-credentials; the eval runner uses
  its own client id so its traffic is attributable in logs and Langfuse.

### 3. Per-principal audit

Once identity exists, stamp the principal onto every pino log line and Langfuse
trace, so "who called `export_report`" is answerable. The approval UI already
records the human decision; this closes the loop on the machine caller.

## Non-goals

- No per-user auth in the browser: the web app talks to the agent service, which
  is the authenticated MCP client. Browser sessions are out of scope until the app
  has real user accounts.
- No mTLS: token auth over TLS is sufficient for this deployment.
