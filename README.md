# Analytics Engineer Assessment

End-to-end analytics exercise: a **dbt** project on DuckDB builds curated marts from lead data; a **FastAPI** backend serves those marts to a **static dashboard** and to an **OpenAI tool-calling assistant** that runs read-only SQL.

## Repository layout

| Path | Purpose |
|------|--------|
| `web/` | Dashboard: `index.html`, `app.css`, `dashboard.js` (and `styles.css`) |
| `api.py` | FastAPI app: `/api/dashboard`, filters, debug endpoints, assistant routes |
| `assistant_chat.py` | Assistant agent, SQLite session store under `data/` |
| `data/` | Created at runtime for `assistant_chat.sqlite` (see `ASSISTANT_SQLITE_PATH`) |
| `vineskills_analytics/` | dbt project (models, seeds, analyses, `profiles.yml`) |
| `docs/` | Working notes (e.g. narrative draft for the dashboard) |
| `requirements.txt` | Single consolidated Python dependency list |
| `index.html` (root) | Redirects to `web/index.html` so the dashboard stays easy to open from the repo root |

## Prerequisites

- Python 3.10+ (recommended)
- An OpenAI API key in the environment if you use the data assistant (`OPENAI_API_KEY`)

## Python environment

From the repository root:

```bash
pip install -r requirements.txt
```

To configure assistant credentials safely, copy `.env.example` to `.env` and set your real values locally.
The API loads `.env` automatically on startup.

The file `vineskills_analytics/requirements.txt` only references the root file, so `pip install -r vineskills_analytics/requirements.txt` from inside that folder installs the same stack.

## Start the project (recommended)

From the repository root on Windows PowerShell:

```powershell
.\start_project.ps1
```

What this script does:

1. Runs `dbt docs generate`.
2. Starts FastAPI at `http://127.0.0.1:8000` (Swagger in `/docs`).
3. Starts dbt docs at `http://127.0.0.1:8081`.
4. Starts a static web server for the dashboard at `http://127.0.0.1:8080/web/`.
5. Opens all 3 pages automatically in your browser:
   - `http://127.0.0.1:8000/docs`
   - `http://127.0.0.1:8081`
   - `http://127.0.0.1:8080/web/`

If any service is already running, the script detects the port and skips starting a duplicate process (prevents "address already in use" errors).

To stop everything, close the PowerShell windows opened by the script.

## Build the warehouse (dbt)

```bash
cd vineskills_analytics
dbt build
```

This materializes DuckDB (default path: `vineskills_analytics/target/vineskills.duckdb`, overridable with `DUCKDB_PATH` when running the API).

## Run the API

From the repository root (so imports and paths resolve as in development):

```bash
uvicorn api:app --reload --host 127.0.0.1 --port 8000
```

The dashboard expects the API at `http://127.0.0.1:8000` by default (`window.DASH_API_BASE` in `web/dashboard.js` overrides this).

## Open the dashboard

- **Direct file:** open `web/index.html` in a browser, or open the root `index.html` (it redirects to `web/`).
- **Local HTTP server** from the repo root (example): `python -m http.server 8080` then visit `http://127.0.0.1:8080/web/` (or `http://127.0.0.1:8080/` via the root redirect).

## Environment variables (reference)

| Variable | Role |
|----------|------|
| `DUCKDB_PATH` | Path to the DuckDB file used by the API and assistant |
| `OPENAI_API_KEY` | Required for assistant endpoints |
| `OPENAI_MODEL` | Optional model override (default in `assistant_chat.py`) |
| `ASSISTANT_SQLITE_PATH` | Optional path for assistant conversation SQLite |

## License / context

Assessment / portfolio project; adjust as needed for your use case.
