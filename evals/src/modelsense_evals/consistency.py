"""Deterministic fixture-vs-reference consistency check.

A recorded tool output is a pure function of the pinned GLBs and the server's
domain logic, so it must agree with reference.json (regenerated from the same GLBs
by `apps/server/src/golden-cli.ts`). A fixture whose tool output disagrees is a
STALE recording: it was captured against an older server and no longer represents
a correct run.

This is the guard the outcome assertions miss. The assertions only pin the fields
a task names (e.g. the largest mesh's triangle count), so a fixture can still carry
an incidental stale number the agent narrated and be scored COMPLETE. The instancing
fix is the concrete case: it changed the truck's scene total from 2856 to 3624, and
25 truck fixtures kept narrating tool outputs of 2856. This check compares every
recorded tool output against the reference, deterministically, so CI fails on drift.
"""

from __future__ import annotations

from typing import Any

from .models import Trajectory
from .reference import Reference
from .scoring.deterministic import strip_tool

_MISSING = object()


def _dig(obj: Any, path: list[str]) -> Any:
    cur = obj
    for part in path:
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return _MISSING
    return cur


def _eq(a: Any, b: Any) -> bool:
    if isinstance(a, bool) or isinstance(b, bool):
        return a == b
    if isinstance(a, int | float) and isinstance(b, int | float):
        return abs(a - b) < 1e-6
    return a == b


def check_consistency(trajectory: Trajectory, reference: Reference) -> list[str]:
    """Return one message per recorded tool-output value that disagrees with
    reference.json. Empty when the fixture is consistent, or when its model or the
    relevant fields are absent (only present fields are compared, so error outputs
    and partial fixtures never false-positive)."""
    drift: list[str] = []
    if not trajectory.model_id:
        return drift
    try:
        ref = reference.model(trajectory.model_id)
    except Exception:  # noqa: BLE001 - unknown model id: nothing to compare against
        return drift

    def compare(out: dict[str, Any], path: list[str], expected: Any, label: str) -> None:
        actual = _dig(out, path)
        if actual is _MISSING or expected is None:
            return
        if not _eq(actual, expected):
            drift.append(f"{trajectory.task_id}: {label}={actual!r} != reference {expected!r}")

    node_tris = {n["id"]: n.get("triangles") for n in ref.get("nodes", [])}

    for call in trajectory.tools:
        name = strip_tool(call.name)
        out = call.output
        if not isinstance(out, dict):
            continue
        if name == "load_model":
            compare(out, ["totals", "triangles"], ref["totals"]["triangles"], "load_model.totals.triangles")
            compare(out, ["totals", "vertices"], ref["totals"]["vertices"], "load_model.totals.vertices")
            for key, val in ref["counts"].items():
                compare(out, ["counts", key], val, f"load_model.counts.{key}")
        elif name == "get_scene_stats" and out.get("scope") == "scene":
            totals = ref["sceneStats"]["totals"]
            compare(out, ["totals", "triangles"], totals["triangles"], "get_scene_stats.totals.triangles")
            compare(out, ["totals", "vertices"], totals["vertices"], "get_scene_stats.totals.vertices")
        elif name == "suggest_optimizations":
            totals = ref["optimizations"]["totals"]
            compare(out, ["totals", "triangles"], totals["triangles"], "suggest_optimizations.totals.triangles")
            compare(
                out,
                ["totals", "textureGpuBytes"],
                totals["textureGpuBytes"],
                "suggest_optimizations.totals.textureGpuBytes",
            )
        elif name == "find_elements":
            for el in out.get("elements", []) or []:
                if isinstance(el, dict) and el.get("id") in node_tris:
                    expected = node_tris[el["id"]]
                    if expected is not None and not _eq(el.get("triangles"), expected):
                        drift.append(
                            f"{trajectory.task_id}: find_elements[{el['id']}].triangles="
                            f"{el.get('triangles')!r} != reference {expected!r}"
                        )
    return drift
