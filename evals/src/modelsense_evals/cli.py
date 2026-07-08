"""Command line entry point: `evals <run|score|report|gate|verify-golden>`.

- verify-golden / gate : offline, deterministic, safe for CI.
- run                  : LIVE, spends tokens; guarded behind --yes.
- score / report       : re-score recorded trajectories offline.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

from .ci_gate import run_gate
from .loader import load_tasks, verify_golden
from .models import RunConfig
from .reference import Reference
from .report import summarize, write_report
from .runner import run_suite
from .scoring import score_all
from .storage import load_trajectories, save_trajectory, scores_to_frame, write_parquet

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_AGENT_URL = "http://localhost:8787"
# Rough per-task cost from the Phase 2 DEVLOG (~$0.28/turn observed).
COST_PER_TASK_ESTIMATE = 0.28


def _git_sha() -> str:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True, stderr=subprocess.DEVNULL
        ).strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return "unknown"


def _timestamp() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H-%M-%SZ")


def _select(tasks, category, limit):
    if category:
        tasks = [t for t in tasks if t.category == category]
    if limit:
        tasks = tasks[:limit]
    return tasks


def cmd_verify_golden(args) -> int:
    reference = Reference.load()
    tasks = load_tasks()
    problems = verify_golden(tasks, reference)
    print(f"Loaded {len(tasks)} golden tasks across {len({t.category for t in tasks})} categories.")
    counts: dict[str, int] = {}
    for t in tasks:
        counts[t.category] = counts.get(t.category, 0) + 1
    for cat, c in sorted(counts.items()):
        print(f"  {cat}: {c}")
    if problems:
        print(f"\n{len(problems)} problem(s):")
        for p in problems:
            print(f"  - {p}")
        return 1
    print("\nAll task references resolve against reference.json.")
    return 0


def cmd_gate(args) -> int:
    result = run_gate()
    print(result.report)
    return 0 if result.ok else 1


def cmd_run(args) -> int:
    tasks = _select(load_tasks(), args.category, args.limit)
    if not tasks:
        print("No tasks selected.")
        return 1
    est = len(tasks) * COST_PER_TASK_ESTIMATE
    print(f"About to run {len(tasks)} tasks against {args.agent_url} (LIVE).")
    print(f"Estimated cost: ~${est:.2f} at ~${COST_PER_TASK_ESTIMATE:.2f}/task (Phase 2 baseline).")
    if not args.yes:
        print("Refusing to spend without --yes. Re-run with --yes to proceed.")
        return 2

    config = RunConfig(
        agent_url=args.agent_url,
        git_sha=_git_sha(),
        timestamp=_timestamp(),
        use_judge=not args.no_judge,
    )
    reference = Reference.load()
    out_dir = ROOT / "results" / f"{config.git_sha[:12]}_{config.timestamp}"
    traj_dir = out_dir / "trajectories"

    def on_progress(i, n, task, traj):
        status = "ERR" if traj.error else "ok"
        print(f"[{i}/{n}] {task.id} ({status}) {traj.usage.turns} turns ${traj.usage.cost_usd:.3f}")
        save_trajectory(traj, traj_dir / f"{task.id}.json")

    trajectories = run_suite(tasks, args.agent_url, on_progress=on_progress)
    _finish(trajectories, {t.id: t for t in tasks}, reference, config, out_dir, use_judge=config.use_judge)
    if args.save_fixtures:
        for traj in trajectories:
            save_trajectory(traj, ROOT / "fixtures" / "trajectories" / f"{traj.task_id}.json")
        print(f"Copied {len(trajectories)} trajectories into fixtures/trajectories/")
    return 0


def cmd_score(args) -> int:
    traj_dir = Path(args.trajectories)
    trajectories = load_trajectories(traj_dir)
    if not trajectories:
        print(f"No trajectories in {traj_dir}")
        return 1
    reference = Reference.load()
    tasks = {t.id: t for t in load_tasks()}
    config = RunConfig(git_sha=_git_sha(), timestamp=_timestamp(), use_judge=args.judge)
    _finish(trajectories, tasks, reference, config, traj_dir.parent, use_judge=args.judge)
    return 0


def _finish(trajectories, tasks, reference, config, out_dir, *, use_judge) -> None:
    scores = score_all(tasks, trajectories, reference, run_judge=use_judge, judge_model=config.judge_model)
    df = scores_to_frame(scores, config)
    parquet = write_parquet(df, config, out_dir)
    report = write_report(scores, config, df)
    s = summarize(df)
    print(
        f"\nCompletion {s['completion_rate'] * 100:.1f}% | tool-select "
        f"{s['tool_selection_accuracy'] * 100:.1f}% | mean cost ${s['mean_cost_usd']:.3f} | "
        f"total ${s['total_cost_usd']:.2f}"
    )
    print(f"Parquet: {parquet}")
    print(f"Report:  {report}")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="evals", description="ModelSense evaluation harness")
    sub = p.add_subparsers(dest="command", required=True)

    sub.add_parser("verify-golden", help="validate the golden set against reference.json")
    sub.add_parser("gate", help="CI regression gate over recorded fixtures (offline)")

    run = sub.add_parser("run", help="run the golden set against the LIVE agent (spends tokens)")
    run.add_argument("--agent-url", default=DEFAULT_AGENT_URL)
    run.add_argument("--category", choices=[
        "lookup", "multi_step", "measurement", "optimization", "guardrail",
    ])
    run.add_argument("--limit", type=int)
    run.add_argument("--no-judge", action="store_true", help="skip the Haiku context-fidelity judge")
    run.add_argument("--save-fixtures", action="store_true", help="copy trajectories into fixtures/")
    run.add_argument("--yes", action="store_true", help="confirm live spend")

    score = sub.add_parser("score", help="re-score recorded trajectories offline")
    score.add_argument("trajectories", help="directory of trajectory JSON files")
    score.add_argument("--judge", action="store_true", help="also run the judge (needs API key)")

    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    handlers = {
        "verify-golden": cmd_verify_golden,
        "gate": cmd_gate,
        "run": cmd_run,
        "score": cmd_score,
    }
    return handlers[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
