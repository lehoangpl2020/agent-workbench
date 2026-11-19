"""
Test script — runs the agent directly (without the server).
Usage: ANTHROPIC_API_KEY=... python example.py
       (the default model comes from model_catalog.py; change it with LLMPlanner(resolve("ollama", "qwen3.5:4b")))
"""

import asyncio
import json
import logging
from agent import CodeAgent
from model_catalog import default_spec
from planner import LLMPlanner
from executor import LocalExecutor
from schemas import AgentRequest

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)


async def main():
    # ── Setup ──────────────────────────────────
    agent = CodeAgent(
        planner=LLMPlanner(default_spec()),
        executor=LocalExecutor(timeout=30),
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
