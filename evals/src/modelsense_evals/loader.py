"""Load and validate the golden set from YAML, and verify it against reference.json."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

from .models import Assertion, ExpectedTool, GoldenTask
from .reference import Reference, ReferenceError

TASKS_DIR = Path(__file__).resolve().parents[2] / "golden" / "tasks"


CATEGORIES = {"lookup", "multi_step", "measurement", "optimization", "guardrail"}


def load_tasks(tasks_dir: Path | None = None) -> list[GoldenTask]:
    """Load every *.yaml in the tasks dir and enforce unique ids.

    Each file is a list of tasks. When the filename stem is a category name, every
    task in it must declare that category (catches misfiled tasks).
    """
    root = tasks_dir or TASKS_DIR
    tasks: list[GoldenTask] = []
    seen: dict[str, Path] = {}
    for path in sorted(root.glob("*.yaml")):
        raw = yaml.safe_load(path.read_text())
        if raw is None:
            raise ValueError(f"{path} is empty")
        entries = raw if isinstance(raw, list) else [raw]
        for entry in entries:
            task = GoldenTask.model_validate(entry)
            if task.id in seen:
                raise ValueError(f"duplicate task id {task.id!r} in {path} and {seen[task.id]}")
            if path.stem in CATEGORIES and task.category != path.stem:
                raise ValueError(
                    f"{path}: task {task.id!r} is {task.category!r} but file is {path.stem!r}"
                )
            seen[task.id] = path
            tasks.append(task)
    return tasks


def _refs_in_matcher(matcher: Any) -> list[str]:
    """Collect every reference path used inside an arg matcher."""
    refs: list[str] = []
    if isinstance(matcher, dict):
        for key, val in matcher.items():
            if key in ("ref", "contains_ref", "node_ref") and isinstance(val, str):
                refs.append(val)
            elif key == "contains" and isinstance(val, dict) and "ref" in val:
                refs.append(val["ref"])
    return refs


def collect_refs(task: GoldenTask) -> list[str]:
    """Every reference.json path a task depends on (args + assertions)."""
    refs: list[str] = []
    tool: ExpectedTool
    for tool in task.expected_tools:
        for matcher in tool.args.values():
            refs.extend(_refs_in_matcher(matcher))
    assertion: Assertion
    for assertion in task.assertions:
        if assertion.ref:
            refs.append(assertion.ref)
        if assertion.node_ref:
            refs.append(assertion.node_ref)
    return refs


def verify_golden(tasks: list[GoldenTask], reference: Reference) -> list[str]:
    """Return a list of problems: unresolved refs or unknown model ids. Empty = ok."""
    problems: list[str] = []
    for task in tasks:
        if task.model_id not in reference.model_ids:
            problems.append(f"{task.id}: unknown model_id {task.model_id!r}")
            continue
        for ref in collect_refs(task):
            try:
                reference.resolve(ref)
            except ReferenceError as exc:
                problems.append(f"{task.id}: {exc}")
    return problems
