# Analytics Engineer Assessment

[![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-API-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![dbt](https://img.shields.io/badge/dbt-Analytics%20Engineering-FF694B?logo=dbt&logoColor=white)](https://www.getdbt.com/)
[![DuckDB](https://img.shields.io/badge/DuckDB-Local%20Warehouse-FCC624?logo=duckdb&logoColor=black)](https://duckdb.org/)
[![OpenAI API](https://img.shields.io/badge/OpenAI-API-412991?logo=openai&logoColor=white)](https://platform.openai.com/)
[![Dashboard](https://img.shields.io/badge/Dashboard-Web-0A66C2?logo=googlechrome&logoColor=white)](./web/)

This repository implements a technical analytics stack for a lead-conversion workflow.  
Raw lead records are transformed with **dbt + DuckDB** into analytics-ready models, exposed through a **FastAPI** service, and consumed by a static **dashboard** that also includes an AI assistant for real-time analytical Q&A over the database (via OpenAI API + validated read-only SQL execution).

The data model is centered on lead lifecycle analysis (intake, qualification, signup), with segmentation by agent, source, status, and time. The project is designed to show practical analytics engineering patterns:

- layered dbt modeling (`staging` -> `intermediate` -> `marts`)
- reproducible local warehouse execution in DuckDB
- API-first consumption of curated marts
- dashboard integration over filtered API endpoints
- dashboard AI agent integration through OpenAI tool-calling and validated read-only SQL

## Preview

![Dashboard preview](image.png)

## Technical Architecture

1. **Ingestion layer (seed):** `vineskills_analytics/seeds/raw_leads.csv`
2. **Staging layer:** canonicalized source structure in `stg_leads`
3. **Intermediate layer:** enriched lead-level table `int_leads_enriched`
4. **Mart layer:** KPI and slice-and-dice marts for funnel, conversion, trend, and velocity analysis
5. **Serving layer:** FastAPI endpoints over DuckDB marts
6. **Consumption layer:** static dashboard in `web/` + API docs in Swagger/ReDoc

DuckDB is used as the analytical store, dbt provides transformation/testing/documentation, and FastAPI acts as a thin serving layer for analytics consumption.

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

## Start Services by Operating System

Run one dbt preparation step, then start the 3 services.

### Windows (PowerShell)

Terminal 1 (prepare warehouse artifacts):

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

### macOS / Linux (zsh/bash)

Terminal 1 (prepare warehouse artifacts):

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
