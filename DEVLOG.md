# DEVLOG

Running log of what changed and why. Newest first.

## 2026-07-07 - Phase 1: MCP server MVP + viewer MVP

Server (`apps/server`):
- Streamable HTTP MCP server on Express, stateless transport (fresh `McpServer`
  per POST, GET/DELETE return 405), shared-bearer auth (`MCP_API_KEY`), Origin
  allowlist returning 403, pino logging, `/healthz`.
- Five tools, each returning `content` plus typed `structuredContent`, with
  input/output Zod schemas in `packages/shared`: `list_models`, `load_model`,
  `get_scene_stats`, `find_elements`, `highlight_elements`.
- glTF parsing and stats via `@gltf-transform` 4.4.1 (`inspect` + `getBounds`).
  Loaded documents live in an in-memory LRU keyed by a server-minted
  `session_id` passed as a tool argument (not an MCP protocol session).
- Tool failures (unknown session, unknown model, unmatched node ids, bad input)
  return as structured `isError` results, never thrown across the boundary.

Assets: three committed Khronos CC0 GLBs (DamagedHelmet, CesiumMilkTruck, Box).
URL loading is restricted to Khronos glTF-Sample-Assets `.glb` files.

Viewer (`apps/web`): Vite + React 19 + React Three Fiber. Loads catalog models
served same-origin from `public/models` (copied from `assets/models` at build),
OrbitControls with auto-framing, and a dev panel that applies a canned highlight
(emissive swap) using the same `structuredContent` shape the agent emits in
Phase 2.

Verification (all green locally):
- `pnpm typecheck` (shared, server, web), `pnpm lint`, web `vite build`.
- 16 domain unit tests against committed GLB fixtures with golden values:
  DamagedHelmet 15452 triangles / 5 textures; CesiumMilkTruck 6 nodes, wheels =
  2 nodes at 768 triangles each.
- 4 HTTP integration tests with a real MCP client over Streamable HTTP: lists
  the five tools, runs `load_model` then `find_elements` then
  `highlight_elements` across separate requests (proving the stateless plus
  session-store design), returns `isError` for a bad session, and 401s an
  unauthenticated request. This is the offline CI conformance gate.

Notes:
- Vitest module collection is slow on this dev machine under load (100s+ once,
  fast when idle); integration tests carry explicit 20s timeouts. Expected fast
  on CI.
- Deferred to a follow-up: a large perf scene (Sponza) and Draco/KTX2 decoder
  wiring; only uncompressed models are in the Phase 1 catalog.
- Deploy (Render blueprint + Vercel) runs after the first push; see README.

## 2026-07-07 - Phase 0 scaffold

- Initialized the pnpm workspace monorepo: `apps/{server,web,agent}`, `packages/shared`, `evals`.
- Toolchain pinned: Node 22 LTS (`.nvmrc`, `engines`), pnpm 10.15.0 (`packageManager`),
  TypeScript strict mode with `noUncheckedIndexedAccess` and `verbatimModuleSyntax`.
- Tooling: ESLint flat config + typescript-eslint, Prettier, Vitest (root `projects`).
- `packages/shared`: first Zod schemas (session id, `structuredContent` command union).
- CI (GitHub Actions): lint, typecheck, unit tests on push and PR. Runs on fixtures,
  never touches live APIs.
- Decision: build the MCP server on `@modelcontextprotocol/sdk` 1.29.0 (v1 stable,
  spec revision 2025-11-25), not the v2 beta which targets the unreleased 2026-07-28
  spec. Streamable HTTP is built stateless-first (`sessionIdGenerator: undefined`);
  loaded-model state is keyed by a server-minted `session_id` passed as a tool
  argument, not a protocol session. The v2 / 2026-07-28 migration is in the parking lot.
- Verified package versions at pin time: `@playwright/mcp` 0.0.77, `playwright` 1.61.1,
  `@modelcontextprotocol/inspector` 0.22.0, `@gltf-transform/core` 4.4.1.
