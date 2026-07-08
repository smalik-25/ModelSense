# E2E benchmark: hand-written vs agent-generated Playwright tests

The project keeps two Playwright suites for the web app (see
[AGENTS.md](../AGENTS.md)): a small hand-written baseline and an agent-generated
set produced by Playwright's planner/generator/healer loop. This note compares
them on the axes that matter for a test suite: coverage, flakiness, and
maintenance cost.

## Method

- Both suites run against the same built app with the agent mocked at the network
  layer (`tests/e2e/handwritten/lib/mockAgent.ts`), headless Chromium, same CI
  runner.
- Coverage is measured as distinct user-visible behaviors asserted (viewer load,
  streamed reply, trace strip, approve, reject, model switch, ...), not line
  coverage, since the interesting surface is interaction not code paths.
- Flakiness is the failure rate across 20 headless runs of each suite.
- Maintenance cost is the reviewer time to land the suite plus the count of
  brittle locators (CSS/nth-child rather than role/testid).

## Results

Fill in after running the generate/heal loop locally (`npx playwright
init-agents --loop=claude`, generate into `tests/e2e/generated/`, review, then run
each suite 20x).

| Metric | Hand-written | Agent-generated |
|---|---|---|
| Specs | 3 | _tbd_ |
| Behaviors asserted | 6 | _tbd_ |
| Brittle locators | 0 (role + testid only) | _tbd_ |
| Flaky runs / 20 | _tbd_ | _tbd_ |
| Reviewer time to land | ~30 min | _tbd_ |
| Unique behaviors the other suite missed | _tbd_ | _tbd_ |

## Expected findings (hypothesis, to confirm)

- The hand-written set is smaller, asserts the exact contract (specific trace
  numbers, approval tool name), and uses only role/testid locators, so it is
  stable and cheap to maintain but only covers what a human thought to script.
- The generated set surfaces interactions a human did not script (rapid model
  switching mid-stream, empty-input handling) but leans on brittle locators and
  needs a review pass to remove redundant or over-specified assertions.
- Net: keep both. Hand-written for the load-bearing flows and the regression
  contract; generated for breadth, gated behind review and provenance headers.

## Reproduce

```bash
cd apps/web
pnpm exec playwright install chromium
pnpm run test:e2e                    # hand-written (and generated, once present)
for i in $(seq 20); do pnpm run test:e2e || echo "flake run $i"; done
```
