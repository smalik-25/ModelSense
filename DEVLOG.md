# DEVLOG

Running log of what changed and why. Newest first.

## 2026-07-08 - Phase 3: evaluation harness + regression gate

The differentiator. `evals/` is a Python 3.12 harness (uv) that scores the agent
on a 50-task golden set with deterministic trajectory checks, a Haiku judge for
context fidelity, and a CI regression gate.

New 9th tool first (completes the tool set the resume targets claim): `suggest_optimizations`
returns ranked, deterministic findings (oversized textures, dense meshes, missing
Draco/KTX2, duplicate materials) with optional triangle/texture budgets. Shared Zod
schema, server domain logic, unit tests, agent allowlist. This gives the optimization
eval category a real tool to select rather than freeform reasoning.

Golden answers are computed, not typed. `apps/server/src/golden-cli.ts` (`pnpm
--filter @modelsense/server golden`) walks the committed GLBs with the exact domain
logic the MCP server runs and writes `evals/golden/reference.json`. Tasks reference
values by dotted path (e.g. `DamagedHelmet.totals.triangles`); `evals verify-golden`
fails if any ref stops resolving, so a model change plus a reference regen keeps every
assertion honest.

Golden set: 50 tasks across lookup (12), multi_step (14), measurement (8),
optimization (10), guardrail (6), each with a prompt, model, ordered expected tools
with argument matchers, outcome assertions, and step/latency/cost budgets. Built on
the three committed models (DamagedHelmet, CesiumMilkTruck, Box).

Scoring:
- Deterministic: tool selection (LCS, order-preserving, extras allowed), argument
  validity (ref/regex/contains/one_of/approx matchers), outcome assertions (numbers
  from reference.json, measurements computed from bbox facts, scene-command checks),
  budgets, and a guardrail invariant (a gated tool must never succeed without an
  approval). Completion = assertions pass AND expected tools present in order AND
  within step budget (guardrail: assertions + invariant).
- Judge: Haiku rates context fidelity (answer grounded in tool outputs). Live runs
  only; recorded in the trajectory so CI never calls the API.

Runner drives the real deployed path: `POST /chat` SSE + `/chat/approve` for gated
tools, so the eval measures the same endpoint the browser uses (not a bypass). To
support trajectory scoring, the agent SSE now carries tool `input` on call frames and
`output` (structuredContent) on result frames; the web client ignores the extra
fields. Results go to Parquet keyed by git SHA + timestamp, plus a markdown report
with matplotlib charts in `evals/reports/`.

CI gate (`evals gate`) replays committed trajectories in `evals/fixtures/` through the
deterministic scorers only and fails the build if completion drops below
`evals/baseline.json`. Wired into `.github/workflows/ci.yml` as a second job
(uv + verify-golden + ruff + pytest + gate), fully offline.

Fixtures are synthetic seeds for now (`scripts/seed_fixtures.py`, built from
reference.json, a correct run across all categories) so the gate has something to run
before a live baseline exists. `evals run --save-fixtures` replaces them with real
recordings.

Verified locally: 27 server unit tests (adds suggest_optimizations cases) green;
all four TS packages typecheck; evals ruff clean, 15 pytest tests pass, gate 13/13 at
100% with guardrail compliance 100%. The gate-fails-when-threshold-raised test proves
the regression path (Phase 3 DoD).

Cost note (unchanged from Phase 2 flag): a full 50-task live run is ~$14 at ~$0.28/task
plus a few cents of Haiku judging. Not run yet; `evals run` prints an estimate and
refuses to spend without `--yes`. Flagged for approval before the first baseline run.

## 2026-07-07 - Phase 2: agent loop + human-in-the-loop + Langfuse tracing

Agent service (`apps/agent`):
- Claude Agent SDK (`@anthropic-ai/claude-agent-sdk` 0.3.204) `query()` loop over
  the remote MCP server (Streamable HTTP + bearer). Model `claude-sonnet-5`,
  `maxTurns` capped, `alwaysLoad` on the MCP config so tools skip the ToolSearch
  preamble.
- `POST /chat` streams SSE: assistant text, tool call/result, scene commands
  (highlight / camera / measurement parsed from tool results), approval requests,
  and a done event with turns/cost/latency/tokens.
- Human-in-the-loop: the seven read tools are allowlisted (auto-approved);
  `export_report` is gated through `canUseTool`, which emits an approval event and
  blocks on `POST /chat/approve`. Built-in tools are denied.
- Langfuse tracing (OTEL v5): one trace per turn with a child span per tool call
  plus cost/token metadata; deep link emitted when `LANGFUSE_PROJECT_ID` is set.

Server: added `camera_focus`, `measure`, `export_report` (gated) tools (8 total)
with shared Zod schemas and unit tests.

Web (`apps/web`): chat panel wired to `/chat` over a fetch SSE stream. Applies scene
commands to the R3F canvas live (emissive highlight, camera framing, measurement
line + label), shows an approve/reject card for gated actions, and a trace strip
(turns, latency, cost, tokens, Langfuse link).

Combined prod entry (`apps/agent/src/combined.ts`): mounts the MCP server and agent
routes on one Express app / one port for Render free tier; the agent reaches the MCP
server on localhost. `render.yaml` now builds and starts the combined agent.

Verified live (local):
- Demo sentence "find every node with 'wheel' and highlight the largest" produces
  the correct trajectory (`load_model` -> `find_elements` -> `highlight_elements`),
  emits the highlight scene command, and completes in ~4 turns. `alwaysLoad` cut
  this from 8 turns / $0.56 / 42s to 4 turns / $0.28 / 11s.
- A stats + highlight turn: 5 turns / $0.14 / 10s.
- Langfuse: "tracing enabled", trace flushed with no errors.
- typecheck (all four packages), lint, and web build green; 27 unit tests pass.

Cost note: an agent turn costs ~$0.14 to $0.28 (Claude Code wrapper context overhead
across turns dominates raw tokens). Flagged for Phase 3: roughly $14 per 50-task
eval run; will reduce with prompt caching and fewer turns before the first full run.

Not yet re-verified locally (dev machine too loaded to spawn more live turns): the
HITL approval round-trip end to end and the combined build run. The code typechecks
and lints; both are local-only checks (CI never runs live turns).

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
