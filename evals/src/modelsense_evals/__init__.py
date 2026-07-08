"""ModelSense evaluation harness.

Golden tasks (YAML) -> live runner (SSE) -> trajectories -> deterministic
scorers + Haiku context-fidelity judge -> Parquet + markdown report. A CI gate
replays recorded trajectories through the deterministic scorers only.
"""

__version__ = "0.1.0"
