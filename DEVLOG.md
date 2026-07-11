# DEVLOG

Running log of what changed and why. Newest first.

## 2026-07-10 - Highlight fidelity: dot-stripped node names, and closing the mesh-match gap

A live report: the agent narrated "highlighted Wheels" on CesiumMilkTruck but the
viewer showed no glow. Traced it end to end.

Ruled out the agent. Reproduced against the deployed service three times: it
deterministically calls load_model, find_elements, then highlight_elements and emits
`{type:highlight, nodeIds:["Wheels"], color:#ffcc00, exclusive:true}` every run, at
2612 input tokens, matching the screenshot's trace exactly. So the command was
emitted; the "narrated but never called the tool" theory is wrong. Cost ~0.20 across
the three repro turns (no eval run).

Two bugs, both in the viewer, both hidden by the same coverage gap.

Bug 1, a render-timing race (the screenshot). The highlight was applied in a
`useEffect([scene, highlight])`. That effect only fires when the Model re-renders with
the new command, and under load R3F does not always re-render the Canvas subtree in
time, so the emissive swap was silently skipped and the mesh stayed dark. New
`highlight.spec.ts` reproduced it: it passed on a fast local machine but the single
`["Wheels"]` case failed deterministically in CI (emissive stuck at `000000`) on the
same code. Fixed by driving the highlight from the render loop instead: Model calls
`applyHighlight` in `useFrame`, reading the current command from a ref that the plain
DOM `Viewer` (which always re-renders on a highlight change) keeps current. It writes
only when a material's emissive actually differs, so the per-frame traverse is cheap.
This is what made the screenshot intermittent.

Bug 2, dot-stripped node names. three's GLTFLoader runs every node name through
`sanitizeNodeName`, which strips `[ ] . : /`, so glTF "Wheels.001" loads as a mesh
named "Wheels001" and "Node.001" as "Node001". The viewer matched only on
`object.name`, so highlighting any dotted id silently matched nothing (confirmed by
loading the real GLB through GLTFLoader 0.180.0: `["Wheels.001"]` and `["Node.001"]`
each matched 0 meshes). This hit highlight-both-wheels (rear missing),
highlight-nodes-named-node, and compare-wheels. Fixed by also matching the original
glTF name that GLTFLoader preserves on `object.userData.name` (matcher extracted to
`apps/web/src/lib/highlight.ts`, walking up parents), and switching the mesh test from
`instanceof THREE.Mesh` to the `.isMesh` flag so a bundler resolving a second copy of
three cannot drop every match. Verified against all three catalog GLBs: every node id
the server can emit resolves to at least one mesh (`["Wheels.001"]` -> 1, both wheels
-> 2, truck root -> 5, helmet node -> 1).

Ruled out the agent first. Reproduced against the deployed service three times: it
deterministically calls load_model, find_elements, then highlight_elements and emits
`{type:highlight, nodeIds:["Wheels"], color:#ffcc00, exclusive:true}` every run, at
2612 input tokens, matching the screenshot's trace exactly. So the command was
emitted; the "narrated but never called the tool" theory is wrong. Cost ~0.20 across
the three repro turns (no eval run).

Coverage (the gap that hid both). The e2e proved the SSE text and trace but never
checked that a highlight changed a mesh, so a broken viewer passed CI. New
`highlight.spec.ts` reads emissive off the live three.js scene (exposed on a
test-only `window.__modelsenseScene` seam, opt-in via `__MODELSENSE_TEST` set before
load) and asserts the Wheels mesh and the dot-stripped Wheels001 rear mesh both go
`#ffcc00`. That is the assertion that surfaced both bugs (the race showed up as the
`["Wheels"]` case failing in CI but passing locally).

## 2026-07-10 - Full audit and remediation pass

A whole-codebase and live-site review (an 8-dimension adversarial pass over the
server, agent, web, shared, evals, CI, docs, and the deployed path) found the
project sound but surfaced one real correctness bug, a fragile free-tier demo, and
a set of UX and doc-accuracy gaps. Worked through all of them. No new live API spend
(the one spend-gated step, a fresh judged eval run, is left for a deliberate call).

Stats correctness (the one real bug). `get_scene_stats` and `summarize` summed
per-mesh geometry once per unique mesh, ignoring instancing, so CesiumMilkTruck
reported 2856 triangles while it renders 3624 and `find_elements` (per-node) already
reported 3624 - the two tools disagreed, and the wrong number was baked into
`reference.json`. Fixed by multiplying per-mesh counts by instance count; made
`get_scene_stats(node_id)` aggregate over the whole subtree (a parent node returned
0 before); handled triangle strips/fans; made mesh/texture `sizeBytes` nullable so a
null inspect size stays a normal result. Regenerated `reference.json` (truck now
3624/4823/5) and updated the two truck-count fixtures to match; server tests +1
instancing case, +1 subtree case, +1 authenticated GET/DELETE 405 case. Gate still
50/50.

Eval rigor and honesty (the differentiator). Tightened the refusal markers to
decline-specific phrasing and corrected the comment (a false positive is a false
PASS, not harmless); `guard-arbitrary-url` now asserts the untrusted URL was never
forwarded to `load_model` (new `tool_input_absent`); the "how tall" measurement task
now checks the narrated Y extent, not just that a diagonal overlay was drawn (new
`answer_contains_dimension`). Corrected the false "fidelity is recorded in the
trajectory" claim in judge.py/README, added a `Trajectory.context_fidelity` field so
a judged run can persist its score and `evals score` reproduces it offline, and noted
that the 4.48/5 headline and the improved-run latency/cost are carried from the
baseline (only completion and tool-selection were re-measured).

Live demo resilience, no new spend. The public demo runs on the 512MB Render free
tier the risk log says OOM/502s after ~6 sustained turns. Client: a stall watchdog
(75s) so a hung backend no longer wedges the chat forever, a terminal-frame guard so
a mid-turn stream close surfaces an error instead of a silent empty bubble, HTTP
502/503/504/429 mapped to the cold-start message, a "waking up" state after 3.5s, a
Stop button, no leftover empty assistant bubble on error, and a wake ping on load and
on tab focus. Server: shrank the GLB LRU from 25 to 8 and added a 120s server-side
approval timeout so an abandoned approval card cannot hold a subprocess and Anthropic
stream open. Decided against a 24/7 keep-warm cron: on the free tier's 750
instance-hours/month cap it would run the service near-continuously and risk
suspension late in the month, which is worse than a cold start the UI now explains.

Multi-turn chat. The browser forwards a bounded history (last 12 display messages);
the agent folds prior turns into the stateless prompt as context so "now focus on
them" resolves. Server `/chat` accepts an optional `history` array.

Web UX. Responsive layout (100dvh, stacks under 760px), the approval card shows the
tool input it is asking to approve, a loading indicator while a GLB downloads, message
auto-scroll, aria-live on messages plus role=alert on errors and a labelled input, an
error boundary around the R3F canvas so a bad GLB or missing WebGL no longer white-
screens the app, approve/reject disabled while in flight, and the viewer now honors
the `exclusive` highlight flag (additive by default) instead of always replacing.

Server/agent hardening. `load_model` URL fetch now caps size (64MB) and times out
(20s); the bearer token is compared with `crypto.timingSafeEqual`; an empty Origin
allowlist logs a warning instead of silently allowing all; built-in tools are in
`disallowedTools` as well as denied by the catch-all; the SSE end frame is not written
to an already-closed socket; Langfuse records first-class `usageDetails`/`costDetails`
and the visitor-facing trace link is gated behind `LANGFUSE_TRACES_PUBLIC` so it no
longer lands on a login wall.

Cleanup and CI. Removed dead code (the catalog `sampleHighlight` field and the
`.dev-panel`/`pre.cmd` CSS from the removed dev panel; the unused branded `SessionId`
types, which are now a plain schema used as the single source for the `session_id`
arg; `Vec3` reused for the bbox fields). CI cancels superseded runs and caches the
Playwright browser. Reframed AGENTS.md and the e2e benchmark as a framework, since the
generated suite is not yet populated.

Verification: server unit tests 24 pass, all four TypeScript packages typecheck
clean, and the eval suite passes (verify-golden, gate 50/50 with guardrail 100%,
ruff, pytest 21). CI additionally runs lint, the web build, MCP Inspector
conformance, and Playwright e2e; the web changes preserve the e2e test ids and the
Send control the specs drive.

## 2026-07-08 - Phase 4: e2e tests, MCP conformance, and polish

Playwright e2e for the web app (`apps/web/tests/e2e/handwritten/`): the viewer
loads with a model selector and canvas, a chat turn streams an assistant reply and
surfaces the trace strip, and the human-in-the-loop approval card approves and
rejects. The agent is mocked at the network layer (`lib/mockAgent.ts` fulfills the
`/chat` SSE and `/chat/approve` with CORS headers), so the suite is deterministic
and never calls a live API. Added `data-testid`s to the chat UI for stable
locators, a Playwright config (built app via `vite preview`, software WebGL for the
R3F canvas in headless), and a CI `e2e` job.

Agent-generated tests: `apps/web/tests/e2e/generated/` plus `AGENTS.md` document the
handwritten-vs-generated split and provenance rules (every generated spec carries a
`// generated:`/`// seed:` header, reviewed before commit). The live
planner/generator/healer loop (`npx playwright init-agents --loop=claude`) runs
locally, not in CI; CI only runs committed specs. `docs/e2e-benchmark.md` is the
comparison framework (coverage, flakiness, maintenance cost) to fill from the local
loop.

MCP conformance: `scripts/mcp-conformance.mjs` starts the built server and drives
the official MCP Inspector CLI (`@modelcontextprotocol/inspector` 0.22.0) over
Streamable HTTP - `tools/list` must return exactly the nine tools, and a
`tools/call load_model` must return a session and stats. Wired as a CI
`conformance` job. The server has no live-LLM dependency, so it runs offline. This
is on top of the existing in-process SDK-client conformance test in
`apps/server/src/http.test.ts`.

CI now has four jobs: `build` (lint + typecheck + unit), `eval-gate`,
`conformance`, and `e2e` - all offline.

Harness audit: an adversarial review of the scorers/runner/gate surfaced three
correctness bugs, each verified and fixed with a regression test: (1) refusal
detection missed natural-language declines ("not possible", "read-only",
"isn't supported"), so a correct guardrail refusal could false-fail - broadened the
marker set; (2) `verify_golden` never validated measurement `node`/`node_b` ids
(only dotted refs), so a renamed node passed preflight then failed scoring - it now
checks node ids against reference.json; (3) the CI gate skipped a per-category floor
when that category had zero fixtures - a dropped category now fails the gate. None
affected the committed fixtures; all could have produced wrong results on new data.
Harness tests: 21.

Phase 5 groundwork: `docs/auth.md` records the shared-bearer rationale and the
staged upgrade path (scoped keys -> OAuth 2.1 resource server -> per-principal
audit), satisfying the Phase 5 "documented scoped-key design."

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
recordings. (Update: the committed fixtures were replaced with the 50 real live
recordings later the same day; see the 2026-07-10 entry for the two that were
re-derived after the stats fix.)

Verified locally: all TS unit tests green (30 across the four packages, incl. new
suggest_optimizations cases; the MCP listTools conformance test now expects nine
tools); all four packages typecheck; evals ruff clean, 15+ pytest tests pass, gate
green with guardrail compliance 100%. The gate-fails-when-threshold-raised test
proves the regression path (Phase 3 DoD).

Baseline run (50 tasks, `claude-sonnet-5`, Haiku judge). First attempt against the
Render free tier died: tasks 1-5 ran, then the process 502'd from task 6 on - the
combined Agent-SDK process OOMs under ~half a dozen sustained turns on the 512 MB
free instance (PROJECT_PLAN risk #1). Re-ran against a local combined server, which
completed cleanly. Decision: eval runs go against a local or paid instance, not the
free tier; documented here and in the runner (`--agent-url`).

Results (report in evals/reports/, gate fixtures in evals/fixtures/):
- Baseline: 94.0% completion, 97% tool selection, 100% arg validity, context
  fidelity 4.48/5, guardrail compliance 100%, mean cost $0.113/task, $5.66 total.
  Per category: lookup/multi_step/optimization/guardrail 100%, measurement 62%.
- The three measurement misses were the same shortcut: the agent read the bbox from
  find_elements and narrated the size without calling measure, so no overlay drew.
- Improvement iteration (evals/reports/improvement.md): one system-prompt edit to
  always use measure for size/distance questions. Measurement 62% -> 100%, overall
  94% -> 100%. baseline.json floors raised to lock it in.

Cost: the full run is ~$5.7 at ~$0.11/task plus a few cents of Haiku judging (well
under the earlier ~$14 estimate; the Phase 2 per-turn figure was inflated by wrapper
overhead). `evals run` prints an estimate and refuses to spend without `--yes`.

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
