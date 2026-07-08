"""Run golden tasks against the LIVE agent `/chat` SSE endpoint and record
trajectories. This is the only part of the harness that spends tokens, so it is
invoked explicitly (`evals run`) and never by CI.

It drives the exact endpoint the browser uses (`/chat` + `/chat/approve`), so the
eval measures the deployed path, not a bypass.
"""

from __future__ import annotations

import json
from typing import Any

import httpx

from .models import Approval, GoldenTask, ToolCall, Trajectory, Usage


def _iter_sse(resp: httpx.Response):
    """Yield decoded `data:` payloads (dicts) from an SSE response."""
    frame: list[str] = []
    for line in resp.iter_lines():
        if line == "":
            data = next((ln[6:] for ln in frame if ln.startswith("data: ")), None)
            frame = []
            if data:
                try:
                    yield json.loads(data)
                except json.JSONDecodeError:
                    continue
        else:
            frame.append(line)


def run_task(
    task: GoldenTask,
    agent_url: str,
    *,
    timeout: float = 120.0,
    client: httpx.Client | None = None,
) -> Trajectory:
    """Execute one task and return its recorded trajectory."""
    owns_client = client is None
    client = client or httpx.Client(timeout=timeout)
    calls: dict[str, ToolCall] = {}
    order: list[str] = []
    scene_commands: list[dict[str, Any]] = []
    approvals: list[Approval] = []
    final_text = ""
    usage = Usage()
    error: str | None = None

    try:
        with client.stream(
            "POST",
            f"{agent_url}/chat",
            json={"message": task.prompt, "modelId": task.model_id},
        ) as resp:
            resp.raise_for_status()
            for event in _iter_sse(resp):
                kind = event.get("t")
                if kind == "text":
                    final_text += event.get("text", "")
                elif kind == "tool" and event.get("phase") == "call":
                    tid = event.get("id") or f"anon-{len(order)}"
                    calls[tid] = ToolCall(name=event.get("name", ""), input=event.get("input") or {})
                    order.append(tid)
                elif kind == "tool" and event.get("phase") == "result":
                    tid = event.get("id")
                    if tid in calls:
                        calls[tid].output = event.get("output")
                        calls[tid].is_error = not event.get("ok", True)
                elif kind == "scene":
                    scene_commands.append(event.get("command", {}))
                elif kind == "approval":
                    decision = "approve" if task.approve_gated else "deny"
                    approvals.append(Approval(tool=event.get("tool", ""), decision=decision))
                    client.post(
                        f"{agent_url}/chat/approve",
                        json={"id": event.get("id"), "approved": task.approve_gated},
                    )
                elif kind == "error":
                    error = event.get("message", "agent error")
                elif kind == "done":
                    usage = Usage(
                        turns=event.get("turns", 0),
                        cost_usd=event.get("costUsd", 0.0),
                        duration_ms=event.get("durationMs", 0.0),
                        input_tokens=event.get("inputTokens", 0),
                        output_tokens=event.get("outputTokens", 0),
                    )
    except (httpx.HTTPError, httpx.StreamError) as exc:
        error = f"transport: {exc}"
    finally:
        if owns_client:
            client.close()

    return Trajectory(
        task_id=task.id,
        prompt=task.prompt,
        model_id=task.model_id,
        tools=[calls[tid] for tid in order],
        scene_commands=scene_commands,
        approvals=approvals,
        final_text=final_text,
        usage=usage,
        error=error,
    )


def run_suite(
    tasks: list[GoldenTask],
    agent_url: str,
    *,
    on_progress=None,
) -> list[Trajectory]:
    trajectories: list[Trajectory] = []
    with httpx.Client(timeout=120.0) as client:
        for i, task in enumerate(tasks, 1):
            traj = run_task(task, agent_url, client=client)
            trajectories.append(traj)
            if on_progress:
                on_progress(i, len(tasks), task, traj)
    return trajectories
