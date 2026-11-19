# Troubleshooting

Common problems when installing and running Agent Workbench. For the standard setup see the [README](../README.md). Provider-specific problems (wrong key, Ollama unreachable, model not pulled) are covered in [providers.md](providers.md), sections 3 and 5.

Run every `docker compose` and `python ...` command **from the repository root** (the directory with `docker-compose.yml`). Compose looks for `.env` there, and the code uses flat imports (`from schemas import ...`).

## 1. How environment variables are read

| How you run it | Is `.env` read? | Notes |
|---|---|---|
| `docker compose up` | **Yes**, but only to substitute the `${...}` variables in `docker-compose.yml` | Variables passed to the container: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OLLAMA_BASE_URL`, `MAX_ITERATIONS`, `EXECUTION_TIMEOUT`; `BIND_ADDRESS` and `HOST_PORT` are used for the published port. `USE_DOCKER`, `SANDBOX_MODE`, etc. are fixed in Compose. |
| `./run.sh local\|hybrid\|docker` (Git Bash/WSL) | **Yes** (`source .env`) | |
| `python server.py` | **No** | The project does not use python-dotenv. Set variables in your shell, or use VS Code's `envFile` (section 4). |

**Shell variables win over `.env`.** If a PowerShell session or `~/.bashrc` still has an old `ANTHROPIC_API_KEY`, Compose uses that key.

### Checking a key without exposing it

```bash
# Inside the container: print only the length
docker compose exec agent-server sh -c 'if [ -n "$ANTHROPIC_API_KEY" ]; then echo "key set (${#ANTHROPIC_API_KEY} chars)"; else echo "key EMPTY"; fi'
```

Or open the UI: the **Provider** field shows which providers are *not configured*.

Do **not** run `cat .env`, `docker compose config` (it prints the whole resolved config, **including keys**), `docker inspect <container>` (it has an `Env` section) or `printenv`, and do not screenshot their output. If a key is exposed, revoke it in the provider's console and create a new one.

If you use `run.sh`, `.env` must have LF line endings: with CRLF, `source .env` appends a `\r` to the end of each value.

## 2. Symptom table

| Symptom | Cause | Fix |
|---|---|---|
| `WARN ... The "ANTHROPIC_API_KEY" variable is not set` on `docker compose up` | Wrong directory, or `.env` has no such key | Harmless if you do not use that provider (for example you only use Ollama). Otherwise `cd` to the right directory, add the key to `.env`, then `docker compose up -d --force-recreate agent-server` |
| Creating a run is rejected: `400`, `detail.code = not_configured` | The key of the selected provider is missing | As above. There is no fallback to another provider |
| Run **Failed**, `llm` log has `error_kind: auth` | Wrong or revoked key | Fix `.env`, check whether an old shell variable overrides it, then `--force-recreate agent-server` |
| `model_not_found` | Wrong model ID, or the key may not use that model | The model list lives in `model_catalog.py`. See [providers.md](providers.md), section 1 |
| `Server unreachable` / `Connection refused` | The server is not running or crashed | `docker compose ps`, `docker compose logs agent-server` |
| Other machines on the network cannot open `:8668` | **By design.** The port is published on `127.0.0.1` only | Leave it. To demo to another machine: `BIND_ADDRESS=0.0.0.0` in `.env`. The server has no auth, so anyone who can reach it can run code and use your key |
| Calling the API from another web page fails with a CORS error | **By design.** CORS only allows `http://localhost:5173` and `http://127.0.0.1:5173` (Vite dev) | Change `CORS_ORIGINS` if you really need to |
| `Bind for 0.0.0.0:8668 failed` / `127.0.0.1:8668 ... port is already allocated` | Port 8668 is taken, often by a hybrid-mode server | Set `HOST_PORT` in `.env`, stop the Python server, or `docker compose stop agent-server` before running hybrid |
| `409 Another run is in progress` | Only one run at a time | Wait, or press **Stop** |
| Run **Failed** with `Sandbox error: Container 'agent-workbench-sandbox' not found. Run: docker compose up sandbox -d` | The sandbox was not created | `docker compose up -d sandbox` |
| `Sandbox cannot see /workspace/runs/<id>/code/iter_01.py` | Hybrid mode: the server and sandbox do not share the runs directory | Start the sandbox with `SANDBOX_RUNS_MOUNT=./data/runs` and the server with `RUNS_DIR=./data/runs` (section 4), or use `./run.sh hybrid` |
| `Conflict. The container name "/agent-workbench-sandbox" is already in use` | An old `agent-workbench-sandbox` container exists that was not created by Compose | `docker ps -a --filter name=agent-workbench-sandbox`; if you are sure it is a stale one, `docker rm -f agent-workbench-sandbox` |
| `Permission denied ... docker.sock` (hybrid inside WSL) | The WSL user is not in the `docker` group | `sudo usermod -aG docker $USER`, then `wsl --shutdown` and reopen |
| `docker: command not found` inside WSL | WSL integration is off | Docker Desktop → Settings → Resources → WSL integration → enable your distro |
| `agent-server` keeps `Restarting` | The server fails on startup, for example it cannot reach the Docker socket | `docker compose logs agent-server` |
| Docker reports `additional privileges requested: pass "--allow=fs.read=..."` | The Bake builder | `docker build -f Dockerfile.sandbox -t agent-workbench-sandbox:latest . && docker build -f Dockerfile.server -t agent-workbench-agent-server . && docker compose up -d --no-build` |
| `ModuleNotFoundError: No module named 'seaborn'` (or another package) in the **sandbox** | The package is not in the image | The persistent sandbox runs `pip install` and re-runs the code (needs network). Installed packages stay until the sandbox is recreated |
| `ModuleNotFoundError: No module named 'matplotlib'` in **local mode** | Local mode only has the packages of the Python environment that runs the server, and it does not auto-install | Use Docker Compose, or install the package into the environment of `LOCAL_PYTHON` |
| The UI shows *Local mode: code is not isolated* | The server runs `LocalExecutor` (`python server.py` without `USE_DOCKER=true`) | Normal during development. Use Docker Compose if you want the sandbox |
| `ModuleNotFoundError: No module named 'schemas'` | `python server.py` was run from the wrong directory | `cd` into the repository root |
| Status **Code run limit reached** although the output looks right | The model reviewed the output in the final-review turn but did not answer `DONE`, or the last run failed | Read the log of the last iteration. Raise *Max code runs* or make the prompt clearer. Semantics: [architecture.md](architecture.md#run-status) |
| Log `Exit code 0 but the output looks like an error — treating this run as failed` | The false-success heuristic: the first stdout line (under 200 characters) contains `error:`, `not found`, `could not`, ... | Intentional. If it misfires, ask the code to print something else on the first line |
| Run **Failed**: `Interrupted: the server restarted while this run was in progress.` | The server was stopped or restarted during the run | Run it again. Resuming is not supported |
| `docker logs agent-workbench-sandbox` is empty | The sandbox only runs `tail -f /dev/null`; code runs through `docker exec` | Read `docker compose logs -f agent-server`, or the **Logs** tab in the UI |
| PowerShell: `curl` fails with odd `Invoke-WebRequest` errors | In Windows PowerShell 5.1, `curl` is an alias | Use `curl.exe` or `Invoke-RestMethod` |
| WSL: `ensurepip is not available` when creating a venv | `python3-venv` is missing | `sudo apt install -y python3-venv` |

## 3. Inspecting and cleaning up data

```bash
# Code + output of one run (the run id is in the UI URL: #/runs/<id>)
docker exec agent-workbench-sandbox ls -R /workspace/runs/<run_id>
docker exec -it agent-workbench-sandbox bash                 # a shell inside the sandbox

docker compose up -d --force-recreate sandbox     # a clean sandbox (drops auto-installed packages)
docker compose down                               # stop, KEEP history + artifacts (data/db/agent.db, volume agent-runs)
docker compose down -v                            # stop and DELETE the run artifacts (volume agent-runs); never needed for the database
```

Run history (prompts, code, output) lives in `data/db/agent.db` (a bind mount) and the `agent-runs` volume under Compose, or in `data/` when running with Python. When sharing the project, **never** include `.env`, `data/` or `.venv/`: `data/` holds the unredacted history and any migration backups.

### Opening the SQLite database in DB Browser for SQLite

Compose mounts `./data/db` into the server container as `/data/db`, so the live database is a normal file on the host: `data\db\agent.db` in the repository root (the container still uses `DB_PATH=/data/db/agent.db`). It is Git-ignored.

1. Start the stack once (`docker compose up -d --build`) so the file exists.
2. In DB Browser for SQLite choose **File → Open Database Read Only** and select `data\db\agent.db`. Use read-only so you cannot lock or change the history by accident; the tables are `runs`, `iterations` and `run_logs`.
3. DB Browser shows a snapshot of what it read. To see new runs or log entries, use **Refresh** (or close and reopen the file). Do not leave a transaction open in the *Execute SQL* tab while the server is writing.

The file is a plain SQLite database, so copying it while a run is active may give an inconsistent copy; stop the server first (`docker compose stop agent-server`) if you want to copy it.

### Migrating an existing history from the old `agent-db` volume (once)

Older versions kept the database in the named volume `agent-workbench_agent-db`. To move it to `data/db/agent.db` without losing history, run this from the repository root in PowerShell. It never deletes the volume, and it refuses to overwrite an existing `data\db\agent.db`.

```powershell
# 1. Wait until no run is active: "active_run_id" must be null.
curl.exe -s http://localhost:8668/health

# 2. Stop only the server (never `docker compose down -v`). The sandbox keeps running.
docker compose stop agent-server

# 3. Copy. The script (a) saves a raw copy of every file in the volume, including any -wal/-shm files,
#    under data\db-backups\, (b) writes a consistent database with SQLite's backup API (which also
#    applies WAL content), and (c) checks integrity and row counts.
New-Item -ItemType Directory -Force data\db, data\db-backups | Out-Null
@'
import glob, os, shutil, sqlite3, sys, time
src, dst = "/src/agent.db", "/dst/db/agent.db"
if os.path.exists(dst):
    sys.exit(f"{dst} already exists: inspect it and back it up before migrating")
stamp = time.strftime("%Y%m%d-%H%M%S")
raw = f"/dst/db-backups/agent-db-volume-{stamp}"
os.makedirs(raw)
for f in glob.glob(src + "*"):
    shutil.copy2(f, raw)
s = sqlite3.connect(src)
d = sqlite3.connect(dst)
s.backup(d)
tables = [r[0] for r in s.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%'")]
for t in tables:
    a = s.execute(f'select count(*) from "{t}"').fetchone()[0]
    b = d.execute(f'select count(*) from "{t}"').fetchone()[0]
    print(f"{t}: source={a} copy={b}", "OK" if a == b else "MISMATCH")
    if a != b:
        sys.exit(1)
print("integrity_check:", d.execute("pragma integrity_check").fetchone()[0])
print("raw backup:", raw)
'@ | docker run --rm -i -v agent-workbench_agent-db:/src -v "${PWD}\data:/dst" --entrypoint python agent-workbench-agent-server -

# 4. Start the server on the new bind mount and check that the history is still there.
docker compose up -d agent-server
curl.exe -s http://localhost:8668/api/runs
```

Keep the `agent-workbench_agent-db` volume and `data\db-backups\` until you are happy with the result; the volume is the recovery copy. To roll back, restore the old `agent-db:/data/db` mount in `docker-compose.yml` and start the server again. Run artifacts are not part of this migration: `agent-runs` is unchanged.

## 4. Debugging the server in VS Code (hybrid)

The sandbox runs in Docker and the server runs as Python so you can set breakpoints.

1. Create a venv and install dependencies once: `python -m venv .venv`, then `.venv\Scripts\pip install -r requirements-dev.txt` (Windows) or `.venv/bin/pip …` (WSL). A venv created on Windows cannot be used in WSL and vice versa.
2. Start a sandbox that shares the runs directory with the server:

   ```powershell
   $env:SANDBOX_RUNS_MOUNT = "./data/runs"; docker compose up -d sandbox
   docker compose stop agent-server   # frees port 8668 if Compose is running
   ```

3. Create `.vscode/launch.json` (a suggestion; the repository does not ship this file):

   ```jsonc
   {
     "version": "0.2.0",
     "configurations": [
       {
         "name": "agent-workbench: server (hybrid)",
         "type": "debugpy",
         "request": "launch",
         "program": "${workspaceFolder}/server.py",
         "cwd": "${workspaceFolder}",
         // VS Code loads .env into the process; Python does not do this by itself
         "envFile": "${workspaceFolder}/.env",
         // "env" takes precedence over envFile
         "env": {
           "USE_DOCKER": "true",
           "SANDBOX_MODE": "persistent",
           "SANDBOX_CONTAINER_NAME": "agent-workbench-sandbox",
           "RUNS_DIR": "./data/runs"
         },
         "justMyCode": false
       }
     ]
   }
   ```

4. Useful breakpoints:
   - `planner.py` `LLMPlanner.generate_code`: the `messages` sent to the model (built by `prompts.build_messages`);
   - `agent.py` `CodeAgent._loop`: the stop conditions;
   - `executor.py` `_run_with_auto_install`: auto-install.
5. Press F5, then open http://127.0.0.1:8668. The UI needs a build in `static/`; if there is none, run `cd web && npm run dev` and open http://localhost:5173. Or call the server with `python client.py --stream "..."`.

Stopping at a breakpoint for too long can make the CLI client report `ReadTimeout` (600-second timeout). When you are done, stop debugging and run `docker compose up -d agent-server`.

## 5. PowerShell equivalents

```powershell
# Enter a key for the current session without writing it to a file (shell variables win over .env)
$sec = Read-Host -AsSecureString "ANTHROPIC_API_KEY"
$env:ANTHROPIC_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))

curl.exe -s http://localhost:8668/health
Invoke-RestMethod http://localhost:8668/health

# Raw SSE
curl.exe -N http://localhost:8668/api/execute/stream -H "Content-Type: application/json" -d '{\"message\": \"Calculate 2 + 2 and print the result\"}'

# Run the CLI client inside the container (no local Python needed)
docker compose exec agent-server python client.py --stream "Calculate 2 + 2 and print the result"
```

`Read-Host` only works when you type in an interactive terminal.
