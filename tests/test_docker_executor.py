"""
Integration test cho PersistentSandboxExecutor với container `agent-workbench-sandbox` THẬT.
Không gọi Claude API. Chỉ chạy khi DOCKER_SANDBOX_TESTS=1, bên trong container
server (cần /var/run/docker.sock + volume agent-runs), ví dụ:

  docker compose run --rm --no-deps -e DOCKER_SANDBOX_TESTS=1 \
      -v "$PWD/tests:/app/tests" agent-server \
      sh -c "pip install -q pytest httpx && python -m pytest -q tests"
"""

import asyncio
import os
import time
import uuid

import pytest

pytestmark = pytest.mark.skipif(
    os.getenv("DOCKER_SANDBOX_TESTS") != "1", reason="needs the real agent-workbench-sandbox container"
)

RUNS_DIR = os.getenv("RUNS_DIR", "/data/runs")


def make():
    from executor import PersistentSandboxExecutor, _KILL_SNIPPET  # noqa: F401
    from workspace import RunWorkspace

    ex = PersistentSandboxExecutor(container_name="agent-workbench-sandbox", timeout=10, runs_dir=RUNS_DIR)
    ws = RunWorkspace(RUNS_DIR, str(uuid.uuid4())).create()
    return ex, ws


def processes_of(ex, ws) -> str:
    """Liệt kê process trong sandbox còn chứa đường dẫn của run."""
    container = ex._get_container()
    snippet = (
        "import os,sys\n"
        "m=sys.argv[1]\n"
        "for p in os.listdir('/proc'):\n"
        "  if p.isdigit() and int(p)!=os.getpid():\n"
        "    try: c=open(f'/proc/{p}/cmdline','rb').read().decode(errors='ignore')\n"
        "    except OSError: continue\n"
        "    if m in c: print(p, c.replace(chr(0),' '))\n"
    )
    _, out = container.exec_run(["python", "-c", snippet, ex._marker(ws)], user="sandbox")
    return out.decode().strip()


def test_runs_code_and_collects_artifacts_per_run():
    ex, ws = make()
    ex2, ws2 = make()
    src = "open('/workspace/output/out.txt','w').write('{}')\nprint('hello from sandbox')"
    r1 = asyncio.run(ex.execute(src.format("one"), workspace=ws, iteration=1))
    r2 = asyncio.run(ex2.execute(src.format("two"), workspace=ws2, iteration=1))
    assert r1.exit_code == 0 and r1.stdout.strip() == "hello from sandbox"
    assert list(r1.artifacts) == ["out.txt"]
    assert (ws.output_dir / "out.txt").read_text() == "one"
    assert (ws2.output_dir / "out.txt").read_text() == "two"


def test_timeout_kills_process_in_sandbox():
    ex, ws = make()
    start = time.monotonic()
    r = asyncio.run(ex.execute("import time\ntime.sleep(60)", workspace=ws, iteration=1, timeout=2))
    assert time.monotonic() - start < 10
    assert r.timed_out and r.exit_code == 124
    assert processes_of(ex, ws) == ""


def test_cancel_kills_process_in_sandbox():
    ex, ws = make()
    code = (
        "import time, pathlib\ntime.sleep(4)\n"
        "pathlib.Path('/workspace/output/after.txt').write_text('x')"
    )

    async def scenario():
        task = asyncio.create_task(ex.execute(code, workspace=ws, iteration=1, timeout=30))
        await asyncio.sleep(1.5)
        assert processes_of(ex, ws) != "", "code should be running"
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(scenario())
    assert processes_of(ex, ws) == ""
    time.sleep(4)
    assert not (ws.output_dir / "after.txt").exists()
