from __future__ import annotations

import logging
import os
import re
import time
from datetime import date, datetime
from pathlib import Path
from typing import Any

import duckdb
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")
DEFAULT_DB = ROOT / "vineskills_analytics" / "target" / "vineskills.duckdb"
DB_PATH = Path(os.getenv("DUCKDB_PATH", str(DEFAULT_DB))).resolve()

logger = logging.getLogger(__name__)

MARTS = {
    "mart_kpis_global",
    "mart_funnel_by_status",
    "mart_conversion_by_agent",
    "mart_conversion_by_source",
    "mart_conversion_by_agent_source",
    "mart_daily_intake_trend",
    "mart_time_to_signup",
    "mart_qualified_pipeline_open",
}

app = FastAPI(title="Vineskills Conversion API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def _log_startup() -> None:
    logger.info(
        "API startup: title=%s version=%s db_path=%s db_exists=%s",
        app.title,
        app.version,
        DB_PATH,
        DB_PATH.exists(),
    )


def _norm(value: Any) -> Any:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return value


def _is_duckdb_file_lock_error(exc: BaseException) -> bool:
    msg = str(exc).lower()
    return "already open" in msg or "could not set lock" in msg


def _connect_readonly() -> duckdb.DuckDBPyConnection:
    try:
        return duckdb.connect(str(DB_PATH), read_only=True)
    except Exception as e:
        if _is_duckdb_file_lock_error(e):
            logger.warning("DuckDB file locked by another process: %s", e)
            raise HTTPException(
                status_code=503,
                detail=(
                    "DuckDB file is in use by another application (e.g. DBeaver, IDE, second "
                    "server instance). Close that connection or stop the other process, then retry. "
                    f"Underlying error: {e}"
                ),
            ) from e
        logger.exception("DuckDB connection failed")
        raise HTTPException(status_code=500, detail=f"DuckDB connection failed: {e}") from e


def _fetch_mart(name: str) -> list[dict[str, Any]]:
    if name not in MARTS:
        logger.warning("fetch mart rejected: unknown mart=%s allowed=%s", name, sorted(MARTS))
        raise HTTPException(status_code=404, detail=f"Unknown mart: {name}")
    if not DB_PATH.exists():
        logger.error("fetch mart failed: DuckDB missing at %s", DB_PATH)
        raise HTTPException(
            status_code=500,
            detail=f"DuckDB not found at {DB_PATH}. Run dbt build first.",
        )

    t0 = time.perf_counter()
    logger.info("fetch mart: opening read_only connection mart=%s path=%s", name, DB_PATH)
    con = _connect_readonly()
    try:
        rows = con.execute(f"select * from main.{name}").fetchall()
        cols = [d[0] for d in con.description]
        out = [{c: _norm(v) for c, v in zip(cols, row)} for row in rows]
        elapsed_ms = (time.perf_counter() - t0) * 1000
        logger.info(
            "fetch mart: done mart=%s row_count=%d columns=%s elapsed_ms=%.2f",
            name,
            len(out),
            cols,
            elapsed_ms,
        )
        return out
    finally:
        con.close()


def _where_clause(
    start_date: str | None,
    end_date: str | None,
    agent: str | None,
    source: str | None,
) -> tuple[str, list[Any]]:
    clauses = ["not is_test_lead"]
    params: list[Any] = []
    if start_date:
        clauses.append("created_date >= ?::date")
        params.append(start_date)
    if end_date:
        clauses.append("created_date <= ?::date")
        params.append(end_date)
    if agent:
        clauses.append("agent_name = ?")
        params.append(agent)
    if source:
        clauses.append("lead_source = ?")
        params.append(source)
    return " and ".join(clauses), params


def _run(con: duckdb.DuckDBPyConnection, sql: str, params: list[Any]) -> list[dict[str, Any]]:
    rows = con.execute(sql, params).fetchall()
    cols = [d[0] for d in con.description]
    return [{c: _norm(v) for c, v in zip(cols, row)} for row in rows]


_READ_SQL_PREFIXES = ("SELECT", "WITH", "SHOW", "DESCRIBE")


class SqlValidationError(ValueError):
    """Invalid or non-read-only SQL (use with HTTP 400 in routes)."""


def validate_readonly_sql(sql: str) -> str:
    s = sql.strip()
    if not s:
        raise SqlValidationError("SQL query is empty.")
    statements = [p.strip() for p in s.split(";") if p.strip()]
    if len(statements) != 1:
        raise SqlValidationError(
            "Send exactly one SQL statement (no multiple commands separated by ';')."
        )
    head = statements[0].lstrip()
    upper = head.upper()
    if not any(upper.startswith(prefix) for prefix in _READ_SQL_PREFIXES):
        raise SqlValidationError(
            "Only read-only queries are allowed: "
            + ", ".join(_READ_SQL_PREFIXES)
            + "."
        )
    return statements[0]


def _assert_read_only_sql(sql: str) -> str:
    try:
        return validate_readonly_sql(sql)
    except SqlValidationError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


def execute_readonly_sql_internal(sql: str, max_rows: int = 500) -> dict[str, Any]:
    """
    Run a single read-only statement for the assistant tool.
    Returns a dict (never raises HTTPException): ok True/False, rows or error.
    """
    if not DB_PATH.exists():
        return {
            "ok": False,
            "error": f"DuckDB not found at {DB_PATH}. Run dbt build first.",
        }
    try:
        validated = validate_readonly_sql(sql)
    except SqlValidationError as e:
        return {"ok": False, "error": str(e)}

    t0 = time.perf_counter()
    try:
        con = _connect_readonly()
    except HTTPException as e:
        detail = e.detail
        return {
            "ok": False,
            "error": detail if isinstance(detail, str) else str(detail),
        }

    try:
        try:
            result = con.execute(validated)
        except Exception as e:
            logger.warning("execute_readonly_sql_internal execution error: %s", e)
            return {"ok": False, "error": f"SQL execution error: {e}"}

        rows = result.fetchmany(max_rows + 1)
        truncated = len(rows) > max_rows
        if truncated:
            rows = rows[:max_rows]
        desc = result.description or ()
        cols = [d[0] for d in desc]
        out = [{c: _norm(v) for c, v in zip(cols, row)} for row in rows]
        elapsed_ms = (time.perf_counter() - t0) * 1000
        return {
            "ok": True,
            "columns": cols,
            "rows": out,
            "row_count": len(out),
            "truncated": truncated,
            "elapsed_ms": round(elapsed_ms, 2),
        }
    finally:
        con.close()


class SqlQueryBody(BaseModel):
    sql: str = Field(..., min_length=1, max_length=50_000)


@app.get("/health")
def health() -> dict[str, Any]:
    exists = DB_PATH.exists()
    logger.info("GET /health db_path=%s db_exists=%s", DB_PATH, exists)
    return {"ok": True, "db_path": str(DB_PATH), "db_exists": exists}


@app.get("/api/marts")
def list_marts() -> dict[str, Any]:
    names = sorted(MARTS)
    logger.info("GET /api/marts count=%d marts=%s", len(names), names)
    return {"marts": names}


@app.get("/api/marts/{mart_name}")
def get_mart(mart_name: str) -> dict[str, Any]:
    logger.info("GET /api/marts/%s", mart_name)
    rows = _fetch_mart(mart_name)
    logger.info("GET /api/marts/%s response row_count=%d", mart_name, len(rows))
    return {"mart": mart_name, "rows": rows}


@app.get("/api/dashboard")
def get_dashboard(
    start_date: str | None = None,
    end_date: str | None = None,
    agent: str | None = None,
    source: str | None = None,
) -> dict[str, Any]:
    logger.info(
        "GET /api/dashboard filters start_date=%s end_date=%s agent=%s source=%s",
        start_date,
        end_date,
        agent,
        source,
    )
    if not DB_PATH.exists():
        logger.error("GET /api/dashboard aborted: DuckDB missing at %s", DB_PATH)
        raise HTTPException(
            status_code=500,
            detail=f"DuckDB not found at {DB_PATH}. Run dbt build first.",
        )
    where_sql, params = _where_clause(start_date, end_date, agent, source)
    logger.info(
        "GET /api/dashboard where_sql=%r param_count=%d db_path=%s",
        where_sql,
        len(params),
        DB_PATH,
    )
    t0 = time.perf_counter()
    con = _connect_readonly()
    try:
        kpis = _run(
            con,
            f"""
            select
              count(*) as total_leads,
              sum(case when is_qualified then 1 else 0 end) as qualified_leads,
              sum(case when is_signed_up then 1 else 0 end) as signed_up_leads,
              round(100.0 * sum(case when is_qualified then 1 else 0 end) / nullif(count(*), 0), 2) as qualification_rate_pct,
              round(100.0 * sum(case when is_signed_up then 1 else 0 end) / nullif(count(*), 0), 2) as signup_rate_pct,
              round(100.0 * sum(case when is_signed_up then 1 else 0 end) / nullif(sum(case when is_qualified then 1 else 0 end), 0), 2)
                as signup_rate_among_qualified_pct,
              sum(case when is_qualified != is_qualifying_by_status_rule then 1 else 0 end) as leads_flag_status_mismatch
            from main.int_leads_enriched
            where {where_sql}
            """,
            params,
        )

        test_leads = _run(
            con,
            """
            select count(*) as test_leads_excluded
            from main.int_leads_enriched
            where is_test_lead
            """,
            [],
        )
        if kpis and test_leads:
            kpis[0]["test_leads_excluded"] = test_leads[0]["test_leads_excluded"]

        funnel = _run(
            con,
            f"""
            select
              status_label as status,
              status_normalized,
              funnel_stage_rank,
              count(*) as lead_count,
              round(100.0 * count(*) / sum(count(*)) over (), 2) as pct_of_total_leads
            from main.int_leads_enriched
            where {where_sql}
            group by status_label, status_normalized, funnel_stage_rank
            order by funnel_stage_rank, lead_count desc
            """,
            params,
        )

        by_agent = _run(
            con,
            f"""
            select
              agent_name,
              count(*) as total_leads,
              sum(case when is_qualified then 1 else 0 end) as qualified_leads,
              sum(case when is_signed_up then 1 else 0 end) as signed_up_leads,
              round(100.0 * sum(case when is_qualified then 1 else 0 end) / nullif(count(*), 0), 2) as qualification_rate_pct,
              round(100.0 * sum(case when is_signed_up then 1 else 0 end) / nullif(count(*), 0), 2) as signup_rate_pct,
              round(100.0 * sum(case when is_signed_up then 1 else 0 end) / nullif(sum(case when is_qualified then 1 else 0 end), 0), 2)
                as signup_rate_among_qualified_pct
            from main.int_leads_enriched
            where {where_sql}
            group by agent_name
            order by signed_up_leads desc, qualification_rate_pct desc
            """,
            params,
        )

        by_source = _run(
            con,
            f"""
            select
              lead_source,
              count(*) as total_leads,
              sum(case when is_qualified then 1 else 0 end) as qualified_leads,
              sum(case when is_signed_up then 1 else 0 end) as signed_up_leads,
              round(100.0 * sum(case when is_qualified then 1 else 0 end) / nullif(count(*), 0), 2) as qualification_rate_pct,
              round(100.0 * sum(case when is_signed_up then 1 else 0 end) / nullif(count(*), 0), 2) as signup_rate_pct,
              round(100.0 * sum(case when is_signed_up then 1 else 0 end) / nullif(sum(case when is_qualified then 1 else 0 end), 0), 2)
                as signup_rate_among_qualified_pct
            from main.int_leads_enriched
            where {where_sql}
            group by lead_source
            order by signed_up_leads desc, total_leads desc
            """,
            params,
        )

        by_agent_source = _run(
            con,
            f"""
            select
              agent_name,
              lead_source,
              count(*) as total_leads,
              sum(case when is_qualified then 1 else 0 end) as qualified_leads,
              sum(case when is_signed_up then 1 else 0 end) as signed_up_leads,
              round(100.0 * sum(case when is_qualified then 1 else 0 end) / nullif(count(*), 0), 2) as qualification_rate_pct,
              round(100.0 * sum(case when is_signed_up then 1 else 0 end) / nullif(count(*), 0), 2) as signup_rate_pct
            from main.int_leads_enriched
            where {where_sql}
            group by agent_name, lead_source
            order by agent_name, total_leads desc
            """,
            params,
        )

        trend = _run(
            con,
            f"""
            select
              created_date,
              count(*) as leads_created,
              sum(case when is_qualified then 1 else 0 end) as qualified_same_day_snapshot,
              sum(case when is_signed_up then 1 else 0 end) as signed_up_leads
            from main.int_leads_enriched
            where {where_sql}
            group by created_date
            order by created_date
            """,
            params,
        )

        velocity = _run(
            con,
            f"""
            select
              agent_name,
              lead_source,
              count(*) as signed_deals,
              round(avg(days_to_signup), 2) as avg_days_to_signup,
              round(median(days_to_signup), 2) as median_days_to_signup,
              min(days_to_signup) as min_days_to_signup,
              max(days_to_signup) as max_days_to_signup
            from main.int_leads_enriched
            where {where_sql}
              and is_signed_up
              and days_to_signup is not null
            group by grouping sets ((agent_name, lead_source), (agent_name), (lead_source), ())
            order by grouping(agent_name, lead_source) desc, signed_deals desc
            """,
            params,
        )

        payload = {
            "mart_kpis_global": kpis,
            "mart_funnel_by_status": funnel,
            "mart_conversion_by_agent": by_agent,
            "mart_conversion_by_source": by_source,
            "mart_conversion_by_agent_source": by_agent_source,
            "mart_daily_intake_trend": trend,
            "mart_time_to_signup": velocity,
        }
        elapsed_ms = (time.perf_counter() - t0) * 1000
        logger.info(
            "GET /api/dashboard done elapsed_ms=%.2f row_counts kpis=%d funnel=%d "
            "by_agent=%d by_source=%d by_agent_source=%d trend=%d velocity=%d",
            elapsed_ms,
            len(kpis),
            len(funnel),
            len(by_agent),
            len(by_source),
            len(by_agent_source),
            len(trend),
            len(velocity),
        )
        return payload
    finally:
        con.close()


@app.get("/api/filter-options")
def get_filter_options() -> dict[str, Any]:
    logger.info("GET /api/filter-options")
    if not DB_PATH.exists():
        logger.error("GET /api/filter-options aborted: DuckDB missing at %s", DB_PATH)
        raise HTTPException(
            status_code=500,
            detail=f"DuckDB not found at {DB_PATH}. Run dbt build first.",
        )
    t0 = time.perf_counter()
    con = _connect_readonly()
    try:
        agents = _run(
            con,
            "select distinct agent_name from main.int_leads_enriched where not is_test_lead order by agent_name",
            [],
        )
        sources = _run(
            con,
            "select distinct lead_source from main.int_leads_enriched where not is_test_lead order by lead_source",
            [],
        )
        date_bounds = _run(
            con,
            "select min(created_date) as min_date, max(created_date) as max_date from main.int_leads_enriched where not is_test_lead",
            [],
        )
        b = date_bounds[0] if date_bounds else {"min_date": None, "max_date": None}
        agent_list = [x["agent_name"] for x in agents if x["agent_name"]]
        source_list = [x["lead_source"] for x in sources if x["lead_source"]]
        elapsed_ms = (time.perf_counter() - t0) * 1000
        logger.info(
            "GET /api/filter-options done elapsed_ms=%.2f agents=%d sources=%d "
            "min_date=%s max_date=%s",
            elapsed_ms,
            len(agent_list),
            len(source_list),
            b.get("min_date"),
            b.get("max_date"),
        )
        return {
            "agents": agent_list,
            "sources": source_list,
            "min_date": b.get("min_date"),
            "max_date": b.get("max_date"),
        }
    finally:
        con.close()


@app.post("/api/query")
def run_readonly_query(body: SqlQueryBody) -> dict[str, Any]:
    """Executa uma unica instrucao SQL somente leitura (SELECT / WITH / SHOW / DESCRIBE)."""
    if not DB_PATH.exists():
        logger.error("POST /api/query aborted: DuckDB missing at %s", DB_PATH)
        raise HTTPException(
            status_code=500,
            detail=f"DuckDB not found at {DB_PATH}. Run dbt build first.",
        )
    sql = _assert_read_only_sql(body.sql)
    logger.info(
        "POST /api/query sql_len=%d sql_preview=%r",
        len(sql),
        sql[:240].replace("\n", " ") + ("..." if len(sql) > 240 else ""),
    )
    t0 = time.perf_counter()
    con = _connect_readonly()
    try:
        try:
            result = con.execute(sql)
        except Exception as e:
            logger.warning("POST /api/query execution error: %s", e)
            raise HTTPException(status_code=400, detail=f"SQL execution error: {e}") from e
        rows = result.fetchall()
        desc = result.description or []
        cols = [d[0] for d in desc]
        out = [{c: _norm(v) for c, v in zip(cols, row)} for row in rows]
        elapsed_ms = (time.perf_counter() - t0) * 1000
        logger.info(
            "POST /api/query done row_count=%d column_count=%d elapsed_ms=%.2f",
            len(out),
            len(cols),
            elapsed_ms,
        )
        return {
            "columns": cols,
            "rows": out,
            "row_count": len(out),
            "elapsed_ms": round(elapsed_ms, 2),
        }
    finally:
        con.close()


from backend.assistant_chat import register_assistant_routes

register_assistant_routes(app, execute_readonly_sql_internal)
