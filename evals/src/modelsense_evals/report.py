"""Aggregate scores into the reported metrics, a markdown report, and charts."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pandas as pd

from .models import RunConfig, TaskScore

REPORTS_DIR = Path(__file__).resolve().parents[2] / "reports"
CATEGORY_ORDER = ["lookup", "multi_step", "measurement", "optimization", "guardrail"]


def summarize(df: pd.DataFrame) -> dict[str, Any]:
    """The headline metrics from PROJECT_PLAN section 2 (per run)."""
    n = len(df)
    guard = df[df["category"] == "guardrail"]
    fidelity = df["context_fidelity"].dropna()
    return {
        "tasks": n,
        "completion_rate": _mean(df["completed"]),
        "tool_selection_accuracy": _mean(df["tool_selection"]),
        "arg_validity": _mean(df["arg_validity"]),
        "mean_latency_ms": _mean(df["latency_ms"]),
        "p95_latency_ms": float(df["latency_ms"].quantile(0.95)) if n else 0.0,
        "mean_cost_usd": _mean(df["cost_usd"]),
        "total_cost_usd": float(df["cost_usd"].sum()),
        "context_fidelity": float(fidelity.mean()) if len(fidelity) else None,
        "guardrail_compliance": _mean(guard["guardrail_ok"]) if len(guard) else None,
        "within_budget_rate": _mean(df["within_budget"]),
    }


def by_category(df: pd.DataFrame) -> pd.DataFrame:
    grouped = (
        df.groupby("category")
        .agg(
            tasks=("task_id", "count"),
            completion=("completed", "mean"),
            tool_selection=("tool_selection", "mean"),
            mean_cost=("cost_usd", "mean"),
            mean_latency=("latency_ms", "mean"),
        )
        .reindex([c for c in CATEGORY_ORDER if c in df["category"].unique()])
    )
    return grouped


def _mean(series: pd.Series) -> float:
    s = series.dropna()
    return float(s.mean()) if len(s) else 0.0


def render_charts(df: pd.DataFrame, out_dir: Path, stem: str) -> list[Path]:
    """Completion-by-category and cost/latency charts. Returns written paths."""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    out_dir.mkdir(parents=True, exist_ok=True)
    paths: list[Path] = []

    cat = by_category(df)
    fig, ax = plt.subplots(figsize=(6, 3.2))
    ax.bar(cat.index, (cat["completion"] * 100), color="#3b82f6")
    ax.set_ylabel("completion %")
    ax.set_ylim(0, 100)
    ax.set_title("Task completion by category")
    fig.tight_layout()
    p1 = out_dir / f"{stem}_completion.png"
    fig.savefig(p1, dpi=120)
    plt.close(fig)
    paths.append(p1)

    fig, ax = plt.subplots(figsize=(6, 3.2))
    ax.scatter(df["cost_usd"], df["latency_ms"] / 1000, alpha=0.7, color="#8b5cf6")
    ax.set_xlabel("cost per task ($)")
    ax.set_ylabel("latency (s)")
    ax.set_title("Cost vs latency per task")
    fig.tight_layout()
    p2 = out_dir / f"{stem}_cost_latency.png"
    fig.savefig(p2, dpi=120)
    plt.close(fig)
    paths.append(p2)
    return paths


def render_markdown(
    scores: list[TaskScore], config: RunConfig, df: pd.DataFrame, charts: list[Path]
) -> str:
    s = summarize(df)
    cat = by_category(df)
    lines: list[str] = [
        f"# ModelSense eval report - {config.timestamp}",
        "",
        f"- Commit: `{config.git_sha[:12]}`",
        f"- Agent model: `{config.agent_model}`  |  Judge: `{config.judge_model}`",
        f"- Tasks: {s['tasks']}",
        "",
        "## Headline metrics",
        "",
        "| Metric | Value |",
        "|---|---|",
        f"| Task completion rate | {s['completion_rate'] * 100:.1f}% |",
        f"| Tool selection accuracy | {s['tool_selection_accuracy'] * 100:.1f}% |",
        f"| Argument validity | {s['arg_validity'] * 100:.1f}% |",
        f"| Context fidelity (judge) | {_fmt_fidelity(s['context_fidelity'])} |",
        f"| Guardrail compliance | {_fmt_pct(s['guardrail_compliance'])} |",
        f"| Within budget | {s['within_budget_rate'] * 100:.1f}% |",
        f"| Mean latency | {s['mean_latency_ms'] / 1000:.1f}s |",
        f"| p95 latency | {s['p95_latency_ms'] / 1000:.1f}s |",
        f"| Mean cost / task | ${s['mean_cost_usd']:.3f} |",
        f"| Total run cost | ${s['total_cost_usd']:.2f} |",
        "",
        "## By category",
        "",
        "| Category | Tasks | Completion | Tool selection | Mean cost | Mean latency |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for name, row in cat.iterrows():
        lines.append(
            f"| {name} | {int(row['tasks'])} | {row['completion'] * 100:.0f}% | "
            f"{row['tool_selection'] * 100:.0f}% | ${row['mean_cost']:.3f} | "
            f"{row['mean_latency'] / 1000:.1f}s |"
        )
    lines += ["", "## Charts", ""]
    lines += [f"![{p.stem}]({p.name})" for p in charts]

    failed = [s2 for s2 in scores if not s2.completed]
    lines += ["", f"## Failures ({len(failed)})", ""]
    if not failed:
        lines.append("None.")
    for f in failed:
        note = f.notes[0] if f.notes else "(no note)"
        lines.append(f"- `{f.task_id}` ({f.category}): {note}")
    lines.append("")
    return "\n".join(lines)


def _fmt_pct(v: float | None) -> str:
    return "n/a" if v is None else f"{v * 100:.1f}%"


def _fmt_fidelity(v: float | None) -> str:
    return "n/a" if v is None else f"{v * 5:.2f}/5"


def write_report(
    scores: list[TaskScore], config: RunConfig, df: pd.DataFrame, reports_dir: Path | None = None
) -> Path:
    out_dir = reports_dir or REPORTS_DIR
    stem = f"{config.git_sha[:12]}_{config.timestamp.replace(':', '').replace('-', '')}"
    charts = render_charts(df, out_dir, stem)
    md = render_markdown(scores, config, df, charts)
    report_path = out_dir / f"{stem}.md"
    report_path.write_text(md)
    (out_dir / "latest.md").write_text(md)
    return report_path
