"""
Execution adapters: run model-written code locally or in a Docker sandbox.

    base.py               BaseExecutor (the shared execute() flow) + RawRun, SandboxUnavailable
    local.py              LocalExecutor              subprocess on the host (dev only, NOT isolated)
    docker_ephemeral.py   SandboxExecutor            one new container per code run
    docker_persistent.py  PersistentSandboxExecutor  `docker exec` into the running sandbox container

A new executor subclasses BaseExecutor and implements _run() and _kill(); nothing else changes.
"""

from agent_workbench.execution.base import BaseExecutor, ProgressFn, RawRun, SandboxUnavailable
from agent_workbench.execution.docker_ephemeral import SandboxExecutor
from agent_workbench.execution.docker_persistent import PersistentSandboxExecutor
from agent_workbench.execution.local import LocalExecutor

__all__ = ["BaseExecutor", "LocalExecutor", "PersistentSandboxExecutor", "ProgressFn", "RawRun",
           "SandboxExecutor", "SandboxUnavailable"]
