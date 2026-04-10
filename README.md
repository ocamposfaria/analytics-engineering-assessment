# Analytics Engineer Assessment

End-to-end analytics project: **dbt** on DuckDB builds curated marts, **FastAPI** serves them, and a static **web dashboard** consumes the API.

## Preview

![Dashboard preview](image.png)

## Repository Layout

| Path | Purpose |
|---|---|
| `backend/` | Python backend (`api.py`, `assistant_chat.py`, runtime SQLite under `backend/data/`) |
| `web/` | Dashboard (`index.html`, `app.css`, `dashboard.js`) |
| `vineskills_analytics/` | dbt project (models, seeds, docs config, profiles) |
| `requirements.txt` | Python dependencies |

## Prerequisites

- Python 3.10+
- `pip`
- Optional: `OPENAI_API_KEY` for assistant endpoints

Install dependencies once from the repository root:

```bash
pip install -r requirements.txt
```

Optional local config: copy `.env.example` to `.env` and set your values.

## Start Services by Operating System

Run one short dbt preparation step, then start the 3 services.

### Windows (PowerShell)

Terminal 1 (build dbt artifacts):

```powershell
cd .\vineskills_analytics
dbt build
dbt docs generate
cd ..
```

Terminal 2 (FastAPI):

```powershell
uvicorn backend.api:app --reload --host 127.0.0.1 --port 8000
```

Terminal 3 (dbt docs):

```powershell
cd .\vineskills_analytics
dbt docs serve --port 8081
```

Terminal 4 (dashboard static server):

```powershell
python -m http.server 8080
```

### macOS (zsh/bash)

Terminal 1 (build dbt artifacts):

```bash
cd vineskills_analytics
dbt build
dbt docs generate
cd ..
```

Terminal 2 (FastAPI):

```bash
uvicorn backend.api:app --reload --host 127.0.0.1 --port 8000
```

Terminal 3 (dbt docs):

```bash
cd vineskills_analytics
dbt docs serve --port 8081
```

Terminal 4 (dashboard static server):

```bash
python3 -m http.server 8080
```

### Linux (bash/zsh)

Terminal 1 (build dbt artifacts):

```bash
cd vineskills_analytics
dbt build
dbt docs generate
cd ..
```

Terminal 2 (FastAPI):

```bash
uvicorn backend.api:app --reload --host 127.0.0.1 --port 8000
```

Terminal 3 (dbt docs):

```bash
cd vineskills_analytics
dbt docs serve --port 8081
```

Terminal 4 (dashboard static server):

```bash
python3 -m http.server 8080
```

## URLs

- FastAPI Swagger: `http://127.0.0.1:8000/docs`
- FastAPI ReDoc: `http://127.0.0.1:8000/redoc`
- FastAPI Health: `http://127.0.0.1:8000/health`
- dbt Docs: `http://127.0.0.1:8081`
- Dashboard: `http://127.0.0.1:8080/web/`

## Environment Variables

| Variable | Role |
|---|---|
| `DUCKDB_PATH` | Path to DuckDB used by API and assistant |
| `OPENAI_API_KEY` | Required for assistant endpoints |
| `OPENAI_MODEL` | Optional model override for assistant |
| `ASSISTANT_SQLITE_PATH` | Optional override for assistant SQLite path |

## Notes

- The dashboard calls `http://127.0.0.1:8000` by default (`window.DASH_API_BASE` in `web/dashboard.js`).
- Stop services with `Ctrl + C` in each terminal.
