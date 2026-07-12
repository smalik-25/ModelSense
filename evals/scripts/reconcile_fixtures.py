"""Reconcile recorded fixtures' deterministic tool outputs with reference.json.

A tool output is a pure function of the pinned GLBs and the server's domain logic,
so the scene-level aggregates in a recording must equal what the current server
emits (which reference.json captures). When the domain logic changes - as with the
instancing fix that moved the truck's scene total from 2856 to 3624 - older
recordings drift. This restores the deterministic fields in place, WITHOUT touching
the agent's narration or its reasoning, so a stale recording matches the current
server again. It is the deterministic half of a re-record; a full live re-record
(`evals run --save-fixtures`) additionally refreshes narration, usage, and latency.

Idempotent. The `evals gate` fixture-drift check (consistency.py) fails CI on any
field this would change, so drift cannot land silently. Run:

    python scripts/reconcile_fixtures.py          # apply
    python scripts/reconcile_fixtures.py --check   # report drift, change nothing
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REFERENCE = json.loads((ROOT / "golden" / "reference.json").read_text())["models"]
FIXTURES = ROOT / "fixtures" / "trajectories"
PREFIX = "mcp__modelsense__"


def _set(out: dict, path: list[str], value: object, changes: list[str], label: str) -> None:
    """Set out[path] = value when the key exists and differs, recording the change."""
    cur = out
    for part in path[:-1]:
        if not isinstance(cur, dict) or part not in cur:
            return
        cur = cur[part]
    leaf = path[-1]
    if isinstance(cur, dict) and leaf in cur and cur[leaf] != value:
        changes.append(f"{label}: {cur[leaf]!r} -> {value!r}")
        cur[leaf] = value


def reconcile_output(name: str, out: dict, ref: dict, changes: list[str]) -> None:
    tool = name[len(PREFIX):] if name.startswith(PREFIX) else name
    if tool == "load_model":
        _set(out, ["totals", "triangles"], ref["totals"]["triangles"], changes, "load_model.totals.triangles")
        _set(out, ["totals", "vertices"], ref["totals"]["vertices"], changes, "load_model.totals.vertices")
        for key, val in ref["counts"].items():
            _set(out, ["counts", key], val, changes, f"load_model.counts.{key}")
        _set(out, ["fileSizeBytes"], ref["fileSizeBytes"], changes, "load_model.fileSizeBytes")
    elif tool == "get_scene_stats" and out.get("scope") == "scene":
        for key, val in ref["sceneStats"]["totals"].items():
            _set(out, ["totals", key], val, changes, f"get_scene_stats.totals.{key}")
    elif tool == "suggest_optimizations":
        for key, val in ref["optimizations"]["totals"].items():
            _set(out, ["totals", key], val, changes, f"suggest_optimizations.totals.{key}")


def reconcile_file(path: Path, apply: bool) -> list[str]:
    traj = json.loads(path.read_text())
    model_id = traj.get("model_id")
    if model_id not in REFERENCE:
        return []
    ref = REFERENCE[model_id]
    changes: list[str] = []
    for call in traj.get("tools", []):
        out = call.get("output")
        if isinstance(out, dict):
            reconcile_output(call.get("name", ""), out, ref, changes)
    if changes and apply:
        path.write_text(json.dumps(traj, indent=2) + "\n")
    return changes


def main() -> None:
    check_only = "--check" in sys.argv
    total = 0
    touched = 0
    for path in sorted(FIXTURES.glob("*.json")):
        changes = reconcile_file(path, apply=not check_only)
        if changes:
            touched += 1
            total += len(changes)
            print(f"{path.name}: {len(changes)} field(s)")
            for c in changes:
                print(f"    {c}")
    verb = "would change" if check_only else "changed"
    print(f"\n{verb} {total} field(s) across {touched} fixture(s)")
    if check_only and total:
        sys.exit(1)


if __name__ == "__main__":
    main()
