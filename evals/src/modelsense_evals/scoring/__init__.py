"""Scoring entry points."""

from __future__ import annotations

from ..models import GoldenTask, TaskScore, Trajectory
from ..reference import Reference
from .deterministic import score_task, strip_tool
from .judge import judge_context_fidelity

__all__ = ["score_task", "strip_tool", "judge_context_fidelity", "score_all"]


def score_all(
    tasks: dict[str, GoldenTask],
    trajectories: list[Trajectory],
    reference: Reference,
    *,
    run_judge: bool = False,
    judge_model: str = "claude-haiku-4-5",
) -> list[TaskScore]:
    """Score every trajectory. `run_judge` adds context fidelity for judge-flagged
    tasks (live only; needs the Anthropic API). Missing tasks are skipped."""
    scores: list[TaskScore] = []
    for traj in trajectories:
        task = tasks.get(traj.task_id)
        if task is None:
            continue
        score = score_task(task, traj, reference)
        if run_judge and task.judge and not traj.error:
            try:
                fidelity, reason = judge_context_fidelity(task, traj, model=judge_model)
                score.context_fidelity = round(fidelity, 3)
                score.notes.append(f"judge: {reason}")
            except Exception as exc:  # noqa: BLE001 - judge failure must not abort scoring
                score.notes.append(f"judge unavailable: {exc}")
        elif traj.context_fidelity is not None:
            # Reproduce fidelity offline from a persisted judged run (no API call).
            score.context_fidelity = round(traj.context_fidelity, 3)
        scores.append(score)
    return scores
