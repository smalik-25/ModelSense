"""CI regression gate. Replays RECORDED trajectories through the deterministic
scorers (no live API, no judge) and fails the build if completion drops below the
committed baseline. This is what runs in GitHub Actions.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from .loader import load_tasks
from .reference import Reference
from .scoring import score_all
from .storage import load_trajectories

FIXTURES_DIR = Path(__file__).resolve().parents[2] / "fixtures" / "trajectories"
BASELINE_PATH = Path(__file__).resolve().parents[2] / "baseline.json"


@dataclass
class GateResult:
    ok: bool
    report: str
    completion_rate: float


def load_baseline(path: Path | None = None) -> dict:
    return json.loads((path or BASELINE_PATH).read_text())


def run_gate(
    *,
    fixtures_dir: Path | None = None,
    baseline_path: Path | None = None,
    tasks_dir: Path | None = None,
    reference_path: Path | None = None,
) -> GateResult:
    reference = Reference.load(reference_path)
    tasks = {t.id: t for t in load_tasks(tasks_dir)}
    trajectories = load_trajectories(fixtures_dir or FIXTURES_DIR)
    if not trajectories:
        return GateResult(False, "no recorded trajectories to gate on", 0.0)

    scores = score_all(tasks, trajectories, reference, run_judge=False)
    baseline = load_baseline(baseline_path)

    n = len(scores)
    completed = sum(1 for s in scores if s.completed)
    rate = completed / n if n else 0.0

    lines = [
        f"Regression gate: {completed}/{n} recorded tasks complete ({rate * 100:.1f}%)",
    ]
    failures: list[str] = []

    # Coverage: every golden task must have a recorded fixture, so a silently
    # dropped fixture (which would otherwise inflate the completion rate) fails.
    scored_ids = {s.task_id for s in scores}
    uncovered = sorted(set(tasks) - scored_ids)
    if uncovered:
        preview = ", ".join(uncovered[:5]) + ("..." if len(uncovered) > 5 else "")
        failures.append(f"{len(uncovered)} golden task(s) have no recorded fixture: {preview}")

    min_rate = baseline.get("min_completion_rate", 0.0)
    if rate < min_rate:
        failures.append(f"completion {rate * 100:.1f}% < baseline {min_rate * 100:.1f}%")

    # Per-category floors.
    by_cat: dict[str, list[bool]] = {}
    for s in scores:
        by_cat.setdefault(s.category, []).append(s.completed)
    for cat, floor in baseline.get("min_by_category", {}).items():
        vals = by_cat.get(cat, [])
        cat_rate = sum(vals) / len(vals) if vals else 0.0
        lines.append(f"  {cat}: {cat_rate * 100:.0f}% ({len(vals)} tasks, floor {floor * 100:.0f}%)")
        if not vals:
            # A category with a floor but no recorded tasks is a coverage regression.
            failures.append(f"{cat} has no recorded tasks (floor {floor * 100:.0f}%)")
        elif cat_rate < floor:
            failures.append(f"{cat} {cat_rate * 100:.0f}% < floor {floor * 100:.0f}%")

    # Guardrail compliance is a hard safety floor.
    guard = [s.guardrail_ok for s in scores if s.category == "guardrail" and s.guardrail_ok is not None]
    if guard:
        guard_rate = sum(guard) / len(guard)
        min_guard = baseline.get("min_guardrail_compliance", 1.0)
        lines.append(f"  guardrail compliance: {guard_rate * 100:.0f}% (floor {min_guard * 100:.0f}%)")
        if guard_rate < min_guard:
            failures.append(f"guardrail compliance {guard_rate * 100:.0f}% < {min_guard * 100:.0f}%")

    if failures:
        lines.append("FAIL:")
        lines.extend(f"  - {f}" for f in failures)
    else:
        lines.append("PASS: all thresholds met")

    return GateResult(ok=not failures, report="\n".join(lines), completion_rate=rate)
