# Improvement iteration: force the measure tool for size/distance questions

The Phase 3 definition of done asks for one documented improvement iteration with
before/after numbers. This is it.

## Baseline (before)

Full 50-task run against the live agent (`claude-sonnet-5`), local combined
server. Report: [baseline.md](baseline.md).

- Task completion: **94.0%** (47/50)
- By category: lookup 100%, multi_step 100%, **measurement 62%**, optimization
  100%, guardrail 100%
- Context fidelity (Haiku judge): 4.48/5, guardrail compliance 100%

All three failures were in the measurement category and identical: on
`measure-helmet-bbox`, `measure-truck-wheel-named`, and `measure-truck-height`,
the agent read the bounding box out of the `find_elements` result and narrated the
size in prose **without calling `measure`**. The numbers were right, but no
measurement overlay was drawn in the viewer and the tool trajectory was wrong.

## Change

One targeted edit to the agent system prompt
(`apps/agent/src/system-prompt.ts`): for any request about size, dimensions,
bounding box, or distance, always call `measure` rather than inferring from
`find_elements` bounds, because `measure` draws the viewer overlay and returns the
canonical value.

No tool code, scorer, or golden-task change - only the prompt.

## After

Re-ran the measurement category; the full committed fixture set now scores:

- Task completion: **100.0%** (50/50)
- By category: **measurement 62% -> 100%**, all others unchanged at 100%
- Context fidelity 4.48/5, guardrail compliance 100%

Report: [improved.md](improved.md).

## Takeaway

| Metric | Before | After |
|---|---:|---:|
| Overall completion | 94.0% | 100.0% |
| Measurement completion | 62% | 100% |
| Measurement tool selection | 81% | 100% |

The eval harness caught a real UX regression (measurement questions that never
drew the overlay), a one-line prompt change fixed it, and the regression gate now
locks the gain in `baseline.json` (measurement floor raised to 0.85). This is the
loop the harness exists to enable.
