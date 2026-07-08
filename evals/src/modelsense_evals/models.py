"""Typed data models shared across the eval harness.

Three families:
- Golden set: `GoldenTask` and its parts (what we ask, what we expect).
- Trajectory: `Trajectory` and its parts (what the agent actually did).
- Scoring: `TaskScore` and its parts (how well it matched).

Everything is Pydantic so YAML tasks and recorded JSON trajectories validate on
load and drift shows up immediately.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

Category = Literal["lookup", "multi_step", "measurement", "optimization", "guardrail"]
Difficulty = Literal["easy", "medium", "hard"]

# --- golden set ------------------------------------------------------------


class ExpectedTool(BaseModel):
    """One expected tool call. `args` maps arg name -> matcher (see scoring)."""

    model_config = ConfigDict(extra="forbid")
    name: str
    args: dict[str, Any] = Field(default_factory=dict)


class Assertion(BaseModel):
    """An outcome check. `kind` selects the scorer; the rest are its operands.

    Operand value comes from `value` (literal) or `ref` (a dotted path into
    reference.json, e.g. "DamagedHelmet.totals.triangles").
    """

    model_config = ConfigDict(extra="forbid")
    kind: Literal[
        "answer_contains_number",
        "answer_contains_text",
        "answer_matches",
        "scene_command",
        "highlight_includes",
        "camera_targets",
        "measurement_value",
        "tool_output",
        "tool_called",
        "tool_not_called",
        "gated_denied",
        "gated_approved",
        "refusal",
    ]
    value: Any = None
    ref: str | None = None
    tolerance: float = 0.0
    # scene_command / highlight_includes / camera_targets / measurement_value
    command_type: Literal["highlight", "camera_focus", "measurement"] | None = None
    node: str | None = None
    node_ref: str | None = None
    # measurement_value: when node_b is set, the target is the center-to-center
    # distance between node and node_b; otherwise node's bbox diagonal.
    node_b: str | None = None
    # tool_output
    tool: str | None = None
    path: str | None = None


class Budgets(BaseModel):
    model_config = ConfigDict(extra="forbid")
    max_steps: int = 6
    max_latency_ms: int = 45000
    max_cost_usd: float = 0.60


class GoldenTask(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    category: Category
    difficulty: Difficulty
    prompt: str
    model_id: str
    expected_tools: list[ExpectedTool] = Field(default_factory=list)
    assertions: list[Assertion] = Field(default_factory=list)
    budgets: Budgets = Field(default_factory=Budgets)
    # Whether the judge scores context fidelity for this task (live runs only).
    judge: bool = False
    # For gated tools: does the (simulated) human approve when asked?
    approve_gated: bool = False
    tags: list[str] = Field(default_factory=list)


# --- trajectory (what actually happened) -----------------------------------


class ToolCall(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str
    input: dict[str, Any] = Field(default_factory=dict)
    output: Any = None
    is_error: bool = False


class Approval(BaseModel):
    model_config = ConfigDict(extra="ignore")
    tool: str
    decision: Literal["approve", "deny"]


class Usage(BaseModel):
    model_config = ConfigDict(extra="ignore")
    turns: int = 0
    cost_usd: float = 0.0
    duration_ms: float = 0.0
    input_tokens: int = 0
    output_tokens: int = 0


class Trajectory(BaseModel):
    """A single agent run, either recorded live or hand-authored as a fixture."""

    model_config = ConfigDict(extra="ignore")
    task_id: str
    prompt: str = ""
    model_id: str = ""
    tools: list[ToolCall] = Field(default_factory=list)
    scene_commands: list[dict[str, Any]] = Field(default_factory=list)
    approvals: list[Approval] = Field(default_factory=list)
    final_text: str = ""
    usage: Usage = Field(default_factory=Usage)
    error: str | None = None


# --- scoring ---------------------------------------------------------------


class AssertionResult(BaseModel):
    kind: str
    passed: bool
    detail: str = ""


class TaskScore(BaseModel):
    task_id: str
    category: Category
    difficulty: Difficulty
    completed: bool
    tool_selection: float
    arg_validity: float
    assertions_passed: int
    assertions_total: int
    assertion_results: list[AssertionResult] = Field(default_factory=list)
    within_budget: bool
    guardrail_ok: bool | None = None
    context_fidelity: float | None = None
    turns: int = 0
    cost_usd: float = 0.0
    latency_ms: float = 0.0
    error: str | None = None
    notes: list[str] = Field(default_factory=list)


class RunConfig(BaseModel):
    """Everything needed to reproduce a run, stamped into every result file."""

    model_config = ConfigDict(extra="ignore")
    agent_url: str = "http://localhost:8787"
    agent_model: str = "claude-sonnet-5"
    judge_model: str = "claude-haiku-4-5"
    git_sha: str = "unknown"
    timestamp: str = "unknown"
    use_judge: bool = True
