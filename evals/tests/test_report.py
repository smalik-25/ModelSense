"""The report generator produces metrics, markdown, and charts from scores."""

from __future__ import annotations

from pathlib import Path

from modelsense_evals.ci_gate import FIXTURES_DIR
from modelsense_evals.loader import load_tasks
from modelsense_evals.models import RunConfig
from modelsense_evals.reference import Reference
from modelsense_evals.report import summarize, write_report
from modelsense_evals.scoring import score_all
from modelsense_evals.storage import load_trajectories, scores_to_frame


def _scores():
    tasks = {t.id: t for t in load_tasks()}
    trajectories = load_trajectories(FIXTURES_DIR)
    return score_all(tasks, trajectories, Reference.load(), run_judge=False)


def test_summarize_metrics_present():
    config = RunConfig(git_sha="testsha000000", timestamp="2026-01-01T00-00-00Z")
    df = scores_to_frame(_scores(), config)
    s = summarize(df)
    assert 0.0 <= s["completion_rate"] <= 1.0
    assert s["tasks"] == len(df)
    assert s["guardrail_compliance"] == 1.0
    assert s["mean_cost_usd"] > 0


def test_write_report_emits_markdown_and_charts(tmp_path: Path):
    config = RunConfig(git_sha="testsha000000", timestamp="2026-01-01T00-00-00Z")
    scores = _scores()
    df = scores_to_frame(scores, config)
    report_path = write_report(scores, config, df, reports_dir=tmp_path)
    assert report_path.exists()
    assert "# ModelSense eval report" in report_path.read_text()
    assert (tmp_path / "latest.md").exists()
    charts = list(tmp_path.glob("*.png"))
    assert len(charts) == 2
