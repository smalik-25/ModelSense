"""LLM-as-judge for context fidelity: is the agent's final answer faithful to and
supported by the tool outputs, with no invented numbers?

This is the ONE dimension deterministic checks cannot capture. It runs only on
live runs (needs the Anthropic API) and only for tasks flagged `judge: true`. The
CI gate runs the deterministic scorers only (run_judge=False), so it never calls
the API; a judged run may persist its per-task score into the trajectory
(`Trajectory.context_fidelity`), which `evals score` reuses to reproduce fidelity
offline. Model: Haiku, per the project cost policy.
"""

from __future__ import annotations

import json
import os
from typing import Any

from ..models import GoldenTask, Trajectory

JUDGE_SYSTEM = (
    "You are a strict evaluator of an AI agent that inspects 3D models via tools. "
    "You are given the user's question, the JSON outputs the agent's tools returned, "
    "and the agent's final natural-language answer. Rate ONLY context fidelity: is the "
    "answer fully supported by the tool outputs, with no invented or contradicted numbers "
    "or entities? Ignore style and completeness. Respond with a JSON object "
    '{"score": <1-5 integer>, "reason": "<one sentence>"} where 5 means every claim is '
    "grounded in the tool outputs and 1 means the answer contradicts or fabricates them."
)


def _tool_digest(trajectory: Trajectory, limit: int = 4000) -> str:
    rows = [
        {"tool": t.name.split("__")[-1], "input": t.input, "output": t.output}
        for t in trajectory.tools
    ]
    blob = json.dumps(rows, default=str)
    return blob[:limit]


def judge_context_fidelity(
    task: GoldenTask,
    trajectory: Trajectory,
    model: str = "claude-haiku-4-5",
    client: Any = None,
) -> tuple[float, str]:
    """Return (score_0_to_1, reason). Raises if the API key or SDK is unavailable."""
    if client is None:
        from anthropic import Anthropic  # imported lazily so CI never needs the SDK

        if not os.environ.get("ANTHROPIC_API_KEY"):
            raise RuntimeError("ANTHROPIC_API_KEY not set; cannot run the judge")
        client = Anthropic()

    user = (
        f"User question:\n{task.prompt}\n\n"
        f"Tool outputs (JSON):\n{_tool_digest(trajectory)}\n\n"
        f"Agent final answer:\n{trajectory.final_text}"
    )
    resp = client.messages.create(
        model=model,
        max_tokens=200,
        system=JUDGE_SYSTEM,
        messages=[{"role": "user", "content": user}],
    )
    raw = "".join(block.text for block in resp.content if block.type == "text")
    score, reason = _parse(raw)
    return score / 5.0, reason


def _parse(raw: str) -> tuple[int, str]:
    start, end = raw.find("{"), raw.rfind("}")
    if start >= 0 and end > start:
        try:
            data = json.loads(raw[start : end + 1])
            score = int(data.get("score", 0))
            return max(1, min(5, score)), str(data.get("reason", ""))
        except (json.JSONDecodeError, ValueError, TypeError):
            pass
    return 1, f"unparseable judge response: {raw[:120]}"
