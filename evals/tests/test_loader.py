"""The golden set loads, has the planned shape, and every ref resolves."""

from __future__ import annotations

from collections import Counter

from modelsense_evals.loader import load_tasks, verify_golden
from modelsense_evals.reference import Reference

EXPECTED_COUNTS = {
    "lookup": 12,
    "multi_step": 14,
    "measurement": 8,
    "optimization": 10,
    "guardrail": 6,
}


def test_loads_fifty_tasks():
    tasks = load_tasks()
    assert len(tasks) == 50


def test_category_counts_match_plan():
    counts = Counter(t.category for t in load_tasks())
    assert dict(counts) == EXPECTED_COUNTS


def test_task_ids_unique():
    ids = [t.id for t in load_tasks()]
    assert len(ids) == len(set(ids))


def test_every_reference_resolves():
    problems = verify_golden(load_tasks(), Reference.load())
    assert problems == [], problems
