"""The CI regression gate: passes on the committed baseline, and fails when the
threshold is raised past what the recorded trajectories achieve (PROJECT_PLAN DoD:
'CI fails when a scorer threshold is deliberately broken')."""

from __future__ import annotations

import json
from pathlib import Path

from modelsense_evals.ci_gate import run_gate


def test_gate_passes_on_committed_baseline():
    result = run_gate()
    assert result.ok, result.report
    assert result.completion_rate >= 0.7


def test_gate_fails_when_threshold_raised(tmp_path: Path):
    # One correct + one wrong trajectory for the same task -> 50% completion.
    good = {
        "task_id": "lookup-helmet-triangles",
        "model_id": "DamagedHelmet",
        "tools": [
            {
                "name": "mcp__modelsense__load_model",
                "input": {"model_id": "DamagedHelmet"},
                "output": {"totals": {"triangles": 15452, "vertices": 14556}, "counts": {}},
                "is_error": False,
            }
        ],
        "scene_commands": [],
        "approvals": [],
        "final_text": "15,452 triangles.",
        "usage": {"turns": 3, "cost_usd": 0.1, "duration_ms": 8000},
        "error": None,
    }
    bad = json.loads(json.dumps(good))
    bad["task_id"] = "lookup-truck-triangles"
    bad["model_id"] = "CesiumMilkTruck"
    bad["tools"][0]["input"]["model_id"] = "CesiumMilkTruck"
    bad["tools"][0]["output"]["totals"] = {"triangles": 1, "vertices": 1}
    bad["final_text"] = "1 triangle."  # wrong

    fixtures_dir = tmp_path / "trajectories"
    fixtures_dir.mkdir()
    (fixtures_dir / "good.json").write_text(json.dumps(good))
    (fixtures_dir / "bad.json").write_text(json.dumps(bad))

    baseline = tmp_path / "baseline.json"
    baseline.write_text(json.dumps({"min_completion_rate": 0.9, "min_guardrail_compliance": 1.0}))

    result = run_gate(fixtures_dir=fixtures_dir, baseline_path=baseline)
    assert not result.ok
    assert abs(result.completion_rate - 0.5) < 1e-9
