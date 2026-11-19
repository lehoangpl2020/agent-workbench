"""
`python -m agent_workbench`: run the API + web UI with uvicorn (run from the repository root with PYTHONPATH=src;
./run.sh local does that). Docker runs `uvicorn agent_workbench.api.app:app` instead.
"""

import logging

import uvicorn

from agent_workbench.api.app import app
from agent_workbench.config import Settings

logger = logging.getLogger("agent_workbench")


def main() -> None:
    settings = Settings.from_env()
    if settings.host not in ("127.0.0.1", "localhost", "::1"):
        logger.warning(f"⚠️  Listening on {settings.host}: other machines on the network can run code here. "
                       "There is no authentication.")
    uvicorn.run(app, host=settings.host, port=settings.port)


if __name__ == "__main__":
    main()
