"""Canonical model facts, loaded from evals/golden/reference.json.

The reference file is produced by `apps/server/src/golden-cli.ts` from the
committed GLBs using the exact domain logic the MCP server runs. Golden tasks
reference values here by dotted path (e.g. "DamagedHelmet.totals.triangles")
instead of hand-typing numbers, so a model change plus a reference regen keeps
every assertion honest.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

REFERENCE_PATH = Path(__file__).resolve().parents[2] / "golden" / "reference.json"


class ReferenceError(KeyError):
    """A dotted ref did not resolve against reference.json."""


class Reference:
    def __init__(self, models: dict[str, Any]):
        self._models = models

    @classmethod
    def load(cls, path: Path | None = None) -> Reference:
        p = path or REFERENCE_PATH
        data = json.loads(p.read_text())
        return cls(data["models"])

    @property
    def model_ids(self) -> list[str]:
        return list(self._models)

    def model(self, model_id: str) -> dict[str, Any]:
        if model_id not in self._models:
            raise ReferenceError(f"unknown model_id {model_id!r} in reference.json")
        return self._models[model_id]

    def resolve(self, expr: str) -> Any:
        """Walk a dotted path. List segments may be numeric indices."""
        cur: Any = self._models
        parts = expr.split(".")
        for i, part in enumerate(parts):
            try:
                if isinstance(cur, list):
                    cur = cur[int(part)]
                elif isinstance(cur, dict):
                    cur = cur[part]
                else:
                    raise ReferenceError(
                        f"cannot descend into {'.'.join(parts[:i])!r} (not a container)"
                    )
            except (KeyError, IndexError, ValueError) as exc:
                raise ReferenceError(f"ref {expr!r} failed at segment {part!r}") from exc
        return cur
