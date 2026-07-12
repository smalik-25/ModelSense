"""Tests for the deterministic fixture-vs-reference drift check (consistency.py).

This is the guard that makes a stale recording fail CI instead of silently scoring
complete on an incidental wrong number (finding H2)."""

from __future__ import annotations

from pathlib import Path

from modelsense_evals.consistency import check_consistency
from modelsense_evals.models import Trajectory
from modelsense_evals.reference import Reference
from modelsense_evals.storage import load_trajectories

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "trajectories"


def _traj(**kw) -> Trajectory:
    return Trajectory.model_validate({"task_id": "t", **kw})


def test_flags_drifted_load_model_output():
    ref = Reference.load()
    # The pre-instancing truck totals: exactly the stale values H2 caught.
    traj = _traj(
        model_id="CesiumMilkTruck",
        tools=[
            {
                "name": "mcp__modelsense__load_model",
                "input": {"model_id": "CesiumMilkTruck"},
                "output": {"totals": {"triangles": 2856, "vertices": 3995}, "counts": {}},
            }
        ],
    )
    drift = check_consistency(traj, ref)
    assert any("load_model.totals.triangles" in d and "2856" in d for d in drift)
    assert any("load_model.totals.vertices" in d for d in drift)


def test_consistent_output_has_no_drift():
    ref = Reference.load()
    traj = _traj(
        model_id="CesiumMilkTruck",
        tools=[
            {
                "name": "mcp__modelsense__load_model",
                "input": {"model_id": "CesiumMilkTruck"},
                "output": {"totals": {"triangles": 3624, "vertices": 4823}},
            }
        ],
    )
    assert check_consistency(traj, ref) == []


def test_flags_drifted_find_elements_node():
    ref = Reference.load()
    traj = _traj(
        model_id="CesiumMilkTruck",
        tools=[
            {
                "name": "mcp__modelsense__find_elements",
                "input": {"query": ""},
                "output": {"total": 1, "elements": [{"id": "Cesium_Milk_Truck", "triangles": 999}]},
            }
        ],
    )
    drift = check_consistency(traj, ref)
    assert any("find_elements[Cesium_Milk_Truck]" in d for d in drift)


def test_unknown_model_or_error_output_is_ignored():
    ref = Reference.load()
    assert check_consistency(_traj(model_id="Nope"), ref) == []
    err = _traj(
        model_id="CesiumMilkTruck",
        tools=[{"name": "mcp__modelsense__load_model", "output": {"text": "boom"}, "is_error": True}],
    )
    assert check_consistency(err, ref) == []


def test_committed_fixtures_agree_with_reference():
    # After reconciliation every recorded fixture must match reference.json so the
    # gate's drift check passes. Regression guard for the whole H2 fix.
    ref = Reference.load()
    drift: list[str] = []
    for traj in load_trajectories(FIXTURES):
        drift.extend(check_consistency(traj, ref))
    assert drift == [], drift
