"""
Test script — runs the agent directly (without the server).
Usage: PYTHONPATH=src python scripts/example.py   (from the repository root; needs a running Ollama with qwen3.5:4b pulled; this makes real model calls)
       (the default model comes from llm/catalog.py; change it with LLMPlanner(resolve("anthropic", "claude-sonnet-4-6")),
       which needs ANTHROPIC_API_KEY and is billed by Anthropic)
"""

import asyncio
import json
import logging
from agent_workbench.core.agent import CodeAgent
from agent_workbench.config import Settings
from agent_workbench.llm.catalog import default_spec
from agent_workbench.core.planner import LLMPlanner
from agent_workbench.execution import LocalExecutor
from agent_workbench.domain.schemas import AgentRequest

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)


async def main():
    # ── Setup ──────────────────────────────────
    settings = Settings.from_env()
    agent = CodeAgent(
        planner=LLMPlanner(default_spec(), max_output_tokens=settings.max_output_tokens),
        executor=LocalExecutor(timeout=30, python=settings.local_python),
        max_iterations=3,
    )

    # ── Test cases ─────────────────────────────
    test_cases = [
        "Calculate the first 20 Fibonacci numbers and print them",
        "Generate a random 5x5 matrix and compute its eigenvalues",
        "What is the sum of all prime numbers less than 1000?",
    ]

    for i, task in enumerate(test_cases, 1):
        print(f"\n{'='*60}")
        print(f"Test {i}: {task}")
        print(f"{'='*60}")

        request = AgentRequest(
            message=task,
            max_iterations=3,
            timeout_seconds=30,
        )

        response = await agent.run(request)

        print(f"\nStatus: {response.status}")
        print(f"Iterations: {response.iterations}")
        print(f"Answer:\n{response.answer[:500]}")

        if response.code_blocks:
            print(f"\nFinal code:\n{response.code_blocks[-1].code[:300]}")

        print(f"\n{'─'*60}")


if __name__ == "__main__":
    asyncio.run(main())
