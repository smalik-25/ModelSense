# AGENTS.md

How the end-to-end tests for the web app are produced and maintained, and the
split between hand-written and agent-generated specs. This is the "agent vs
baseline" comparison artifact for the project.

## Layout

```
apps/web/tests/e2e/
  handwritten/     trusted, human-authored specs. The baseline.
    lib/mockAgent.ts   network-level mock of the agent (deterministic SSE)
    chat.spec.ts       viewer loads, agent reply streams, trace strip
    approval.spec.ts   human-in-the-loop approve / reject
  generated/       specs produced by Playwright's agentic loop (planner ->
                   generator -> healer via the Playwright MCP server). Reviewed
                   before commit. Empty until the loop is run.
```

## Provenance rules

- **Every generated spec keeps a provenance header** so the origin is never
  ambiguous:
  ```ts
  // generated: planner+generator via @playwright/mcp, <date>, reviewed by <name>
  // seed: apps/web/tests/e2e/handwritten/chat.spec.ts
  ```
- Hand-written specs are the source of truth for the flows that matter (load,
  stream, approve). Generated specs widen coverage; they never replace a
  hand-written spec.
- A generated spec that fails is triaged, not auto-committed. If the healer
  changes it, the diff is reviewed like any other code.

## Running the generate/heal loop (local only)

The agentic loop needs the Playwright MCP server and a live model; it runs on a
developer machine, not in CI.

```bash
cd apps/web
pnpm exec playwright install chromium
# One-time: scaffold the planner/generator/healer agent definitions.
npx playwright init-agents --loop=claude
# Generate specs into tests/e2e/generated from a plan, then review the diff.
```

CI runs only the committed specs (handwritten now, generated once reviewed),
headless, against the built app with the agent mocked. No live API.

## Why the split

The benchmark note in [docs/e2e-benchmark.md](docs/e2e-benchmark.md) compares the
two sets on coverage, flakiness, and maintenance cost. The short version: the
hand-written set is small, stable, and asserts the exact contract; the generated
set finds interactions a human did not script but costs review time and is more
prone to brittle locators. Keeping both, with clear provenance, is the point.
