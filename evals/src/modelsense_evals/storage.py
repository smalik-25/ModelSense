"""Persistence: trajectory JSON in/out and the per-run Parquet results file."""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

from .models import RunConfig, TaskScore, Trajectory

RESULTS_DIR = Path(__file__).resolve().parents[2] / "results"


def save_trajectory(traj: Trajectory, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(traj.model_dump(), indent=2, default=str) + "\n")


def load_trajectories(directory: Path) -> list[Trajectory]:
    """Load every *.json trajectory in a directory, sorted by filename."""
    out: list[Trajectory] = []
    for path in sorted(directory.glob("*.json")):
        out.append(Trajectory.model_validate_json(path.read_text()))
    return out


def scores_to_frame(scores: list[TaskScore], config: RunConfig) -> pd.DataFrame:
    rows = []
    for s in scores:
        rows.append(
            {
                "task_id": s.task_id,
                "category": s.category,
                "difficulty": s.difficulty,
                "completed": s.completed,
                "tool_selection": s.tool_selection,
                "arg_validity": s.arg_validity,
                "assertions_passed": s.assertions_passed,
                "assertions_total": s.assertions_total,
                "within_budget": s.within_budget,
                "guardrail_ok": s.guardrail_ok,
                "context_fidelity": s.context_fidelity,
                "turns": s.turns,
                "cost_usd": s.cost_usd,
                "latency_ms": s.latency_ms,
                "error": s.error,
                "notes": json.dumps(s.notes),
                "git_sha": config.git_sha,
                "timestamp": config.timestamp,
                "agent_model": config.agent_model,
            }
        )
    return pd.DataFrame(rows)


def write_parquet(df: pd.DataFrame, config: RunConfig, results_dir: Path | None = None) -> Path:
    out_dir = results_dir or RESULTS_DIR
    out_dir.mkdir(parents=True, exist_ok=True)
    safe_ts = config.timestamp.replace(":", "").replace("-", "")
    path = out_dir / f"{config.git_sha[:12]}_{safe_ts}.parquet"
    df.to_parquet(path, engine="pyarrow", index=False)
    return path
