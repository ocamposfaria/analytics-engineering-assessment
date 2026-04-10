"""
Data assistant: OpenAI tool-calling agent with read-only DuckDB SQL and SQLite session storage.
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any, Callable

from fastapi import APIRouter, FastAPI, HTTPException
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parent
DEFAULT_SQLITE = ROOT / "data" / "assistant_chat.sqlite"
SQLITE_PATH = Path(os.getenv("ASSISTANT_SQLITE_PATH", str(DEFAULT_SQLITE))).resolve()

MAX_TOOL_ROUNDS = 10
MAX_TOOL_JSON_CHARS = 72_000
MAX_SQL_STORED_CHARS = 24_000
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")

MART_NAMES = sorted(
    {
        "mart_kpis_global",
        "mart_funnel_by_status",
        "mart_conversion_by_agent",
        "mart_conversion_by_source",
        "mart_conversion_by_agent_source",
        "mart_daily_intake_trend",
        "mart_time_to_signup",
        "mart_qualified_pipeline_open",
    }
)

SYSTEM_PROMPT = """You are an analytics assistant for a commercial lead conversion dashboard.

Data rules:
- Grain: one row per lead in main.int_leads_enriched (built from stg_leads).
- For KPI-style questions aligned with the dashboard, exclude test leads: filter with "not is_test_lead" on int_leads_enriched.
- is_qualified is derived from qualified_flag (not the same as a closed sale).
- is_signed_up is true when status indicates signed up or signed_up_date is set.
- Funnel / status counts are a snapshot: each lead has one current status, not a full path through every stage.
- Prefer main.int_leads_enriched for lead-level filters, counts, and breakdowns by agent_name, lead_source, created_date, status.
- Pre-aggregated marts in schema main (use SELECT * FROM main.<name>):
  """ + ", ".join(MART_NAMES) + """

Mandatory behavior:
- For any question about numbers, counts, rates, trends, comparisons, or "who/which" about the dataset, you MUST call run_sql at least once and base your answer only on the query results (plus these definitions).
- If run_sql returns an error, fix the SQL or explain what is missing.
- Use DuckDB SQL. Only one statement per run_sql call (SELECT, WITH, SHOW, or DESCRIBE).
- Keep result sets small: use aggregates, GROUP BY, and LIMIT when exploring.
- For string filters/searches (agent_name, lead_source, status, free-text names, etc.), first discover existing values with a small exploratory query (for example SELECT DISTINCT ... ORDER BY ... LIMIT ...), then filter using values that actually exist.
- Never use case-sensitive string matching. Prefer ILIKE for pattern matching, or compare normalized values with lower(column) = lower('value'). Apply the same rule to IN/joins over text whenever relevant.
- If the user asks for a table (or tabular format), return the answer as a valid Markdown table with a header row and separator row.
- When returning a Markdown table, do not wrap it in triple backticks/code fences.
- Answer concisely in plain language; mention row counts or truncation when relevant.
"""


TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "run_sql",
            "description": (
                "Execute one read-only DuckDB SQL statement against database schema main. "
                "Use for factual questions about leads, funnel, agents, sources, and dates."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "sql": {
                        "type": "string",
                        "description": "A single SELECT, WITH, SHOW, or DESCRIBE statement.",
                    }
                },
                "required": ["sql"],
            },
        },
    }
]


def _ensure_db() -> None:
    SQLITE_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(SQLITE_PATH), check_same_thread=False)
    try:
        con.executescript(
            """
            CREATE TABLE IF NOT EXISTS conversations (
              id TEXT PRIMARY KEY,
              created_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS chat_messages (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              conversation_id TEXT NOT NULL,
              seq INTEGER NOT NULL,
              payload TEXT NOT NULL,
              FOREIGN KEY (conversation_id) REFERENCES conversations(id)
            );
            CREATE INDEX IF NOT EXISTS idx_chat_messages_conv_seq
              ON chat_messages (conversation_id, seq);
            """
        )
        con.commit()
    finally:
        con.close()


def _open_sqlite() -> sqlite3.Connection:
    _ensure_db()
    con = sqlite3.connect(str(SQLITE_PATH), check_same_thread=False)
    con.execute("PRAGMA foreign_keys = ON")
    return con


def _next_seq(con: sqlite3.Connection, conversation_id: str) -> int:
    row = con.execute(
        "SELECT COALESCE(MAX(seq), -1) + 1 FROM chat_messages WHERE conversation_id = ?",
        (conversation_id,),
    ).fetchone()
    return int(row[0]) if row else 0


def _append_message(con: sqlite3.Connection, conversation_id: str, payload: dict[str, Any]) -> None:
    seq = _next_seq(con, conversation_id)
    con.execute(
        "INSERT INTO chat_messages (conversation_id, seq, payload) VALUES (?, ?, ?)",
        (conversation_id, seq, json.dumps(payload, ensure_ascii=False)),
    )


def _load_messages(con: sqlite3.Connection, conversation_id: str) -> list[dict[str, Any]]:
    rows = con.execute(
        "SELECT payload FROM chat_messages WHERE conversation_id = ? ORDER BY seq",
        (conversation_id,),
    ).fetchall()
    out: list[dict[str, Any]] = []
    for (raw,) in rows:
        try:
            out.append(json.loads(raw))
        except json.JSONDecodeError:
            logger.warning("skip bad message json for conversation_id=%s", conversation_id)
    return out


def _filter_sql_hint(sql: str) -> str:
    s = sql.strip().replace("\n", " ")
    return s[:200] + ("…" if len(s) > 200 else "")


def _truncate_tool_result(payload: dict[str, Any]) -> dict[str, Any]:
    raw = json.dumps(payload, ensure_ascii=False, default=str)
    if len(raw) <= MAX_TOOL_JSON_CHARS:
        return payload
    slim = {k: v for k, v in payload.items() if k != "rows"}
    if payload.get("ok") and "rows" in payload:
        rows = payload["rows"]
        if isinstance(rows, list):
            slim["rows"] = rows[:25]
            slim["rows_omitted"] = max(0, len(rows) - 25)
    raw2 = json.dumps(slim, ensure_ascii=False, default=str)
    if len(raw2) > MAX_TOOL_JSON_CHARS:
        slim.pop("rows", None)
        slim["note"] = "Result too large; re-run with aggregates or stricter LIMIT."
    return slim


def _dashboard_filter_lines(
    start_date: str | None,
    end_date: str | None,
    agent: str | None,
    source: str | None,
) -> str:
    parts = [
        "The user's dashboard may apply filters (only for context; SQL you write must still be explicit):"
    ]
    parts.append(f"- start_date: {start_date or '(none)'}")
    parts.append(f"- end_date: {end_date or '(none)'}")
    parts.append(f"- agent_name: {agent or '(none)'}")
    parts.append(f"- lead_source: {source or '(none)'}")
    parts.append(
        "When these are set, prefer adding matching predicates on int_leads_enriched "
        "(created_date, agent_name, lead_source) and always keep not is_test_lead unless the user asks otherwise."
    )
    return "\n".join(parts)


def run_agent_turn(
    conversation_id: str,
    user_text: str,
    sql_executor: Callable[[str, int], dict[str, Any]],
    *,
    start_date: str | None = None,
    end_date: str | None = None,
    agent: str | None = None,
    source: str | None = None,
) -> tuple[str, list[dict[str, Any]]]:
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="OPENAI_API_KEY is not set; the assistant is unavailable.",
        )

    try:
        from openai import OpenAI
    except ImportError as e:
        raise HTTPException(
            status_code=503,
            detail="openai package is not installed. pip install openai",
        ) from e

    client = OpenAI(api_key=api_key)
    tool_runs: list[dict[str, Any]] = []

    con = _open_sqlite()
    try:
        row = con.execute(
            "SELECT 1 FROM conversations WHERE id = ?", (conversation_id,)
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Conversation not found.")

        _append_message(con, conversation_id, {"role": "user", "content": user_text})
        con.commit()

        history = _load_messages(con, conversation_id)
        filter_note = _dashboard_filter_lines(start_date, end_date, agent, source)
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": SYSTEM_PROMPT + "\n\n" + filter_note},
            *history,
        ]

        for _round in range(MAX_TOOL_ROUNDS):
            t0 = time.perf_counter()
            response = client.chat.completions.create(
                model=OPENAI_MODEL,
                messages=messages,
                tools=TOOLS,
                tool_choice="auto",
            )
            elapsed = time.perf_counter() - t0
            logger.info(
                "openai chat completion round=%d model=%s elapsed_s=%.2f",
                _round,
                OPENAI_MODEL,
                elapsed,
            )

            choice = response.choices[0]
            msg = choice.message

            if msg.tool_calls:
                assistant_payload: dict[str, Any] = {
                    "role": "assistant",
                    "tool_calls": [
                        {
                            "id": tc.id,
                            "type": "function",
                            "function": {
                                "name": tc.function.name,
                                "arguments": tc.function.arguments or "{}",
                            },
                        }
                        for tc in msg.tool_calls
                    ],
                }
                if msg.content:
                    assistant_payload["content"] = msg.content
                _append_message(con, conversation_id, assistant_payload)
                con.commit()
                api_assistant = {**assistant_payload}
                if "content" not in api_assistant:
                    api_assistant["content"] = None
                messages.append(api_assistant)

                for tc in msg.tool_calls:
                    if tc.function.name != "run_sql":
                        err = json.dumps({"ok": False, "error": f"Unknown tool {tc.function.name}"})
                        tool_msg = {
                            "role": "tool",
                            "tool_call_id": tc.id,
                            "content": err,
                        }
                        _append_message(con, conversation_id, tool_msg)
                        con.commit()
                        messages.append(tool_msg)
                        continue

                    try:
                        args = json.loads(tc.function.arguments or "{}")
                        raw_sql = args.get("sql", "")
                        sql = raw_sql if isinstance(raw_sql, str) else str(raw_sql)
                    except json.JSONDecodeError:
                        sql = ""

                    result = sql_executor(sql, 500)
                    sql_stored = sql.strip() if sql else ""
                    if len(sql_stored) > MAX_SQL_STORED_CHARS:
                        sql_stored = (
                            sql_stored[: MAX_SQL_STORED_CHARS - 20]
                            + "\n-- … (truncated for storage)"
                        )
                    tool_runs.append(
                        {
                            "sql": sql_stored,
                            "sql_preview": _filter_sql_hint(sql) if sql else "(empty)",
                            "ok": result.get("ok"),
                            "row_count": result.get("row_count"),
                            "error": result.get("error"),
                        }
                    )
                    result = _truncate_tool_result(result)
                    tool_msg = {
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "content": json.dumps(result, ensure_ascii=False, default=str),
                    }
                    _append_message(con, conversation_id, tool_msg)
                    con.commit()
                    messages.append(tool_msg)

                continue

            text = (msg.content or "").strip()
            if not text:
                text = "I could not produce an answer. Please try rephrasing your question."
            final_payload: dict[str, Any] = {"role": "assistant", "content": text}
            if tool_runs:
                final_payload["tool_runs"] = tool_runs
            _append_message(con, conversation_id, final_payload)
            con.commit()
            return text, tool_runs

        stop_msg = "Stopped after too many tool rounds. Please ask a narrower question."
        stop_payload: dict[str, Any] = {"role": "assistant", "content": stop_msg}
        if tool_runs:
            stop_payload["tool_runs"] = tool_runs
        _append_message(con, conversation_id, stop_payload)
        con.commit()
        return (stop_msg, tool_runs)
    finally:
        con.close()


router = APIRouter(prefix="/api/assistant", tags=["assistant"])


class CreateSessionResponse(BaseModel):
    conversation_id: str


class ChatMessageBody(BaseModel):
    message: str = Field(..., min_length=1, max_length=16_000)
    start_date: str | None = None
    end_date: str | None = None
    agent: str | None = None
    source: str | None = None


class ChatMessageResponse(BaseModel):
    reply: str
    conversation_id: str
    tool_runs: list[dict[str, Any]] = Field(default_factory=list)


class UiMessage(BaseModel):
    role: str
    content: str
    tool_runs: list[dict[str, Any]] | None = None


class ListMessagesResponse(BaseModel):
    messages: list[UiMessage]


def register_assistant_routes(
    app: FastAPI,
    sql_executor: Callable[[str, int], dict[str, Any]],
) -> None:
    @router.post("/sessions", response_model=CreateSessionResponse)
    def create_session() -> CreateSessionResponse:
        _ensure_db()
        cid = str(uuid.uuid4())
        con = _open_sqlite()
        try:
            con.execute(
                "INSERT INTO conversations (id, created_at) VALUES (?, ?)",
                (cid, time.time()),
            )
            con.commit()
        finally:
            con.close()
        return CreateSessionResponse(conversation_id=cid)

    @router.get("/sessions/{conversation_id}/messages", response_model=ListMessagesResponse)
    def list_ui_messages(conversation_id: str) -> ListMessagesResponse:
        _ensure_db()
        con = _open_sqlite()
        try:
            row = con.execute(
                "SELECT 1 FROM conversations WHERE id = ?", (conversation_id,)
            ).fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Conversation not found.")
            raw_list = _load_messages(con, conversation_id)
        finally:
            con.close()

        ui: list[UiMessage] = []
        for m in raw_list:
            role = m.get("role")
            if role == "user":
                c = m.get("content") or ""
                if c:
                    ui.append(UiMessage(role="user", content=c))
            elif role == "assistant":
                if m.get("tool_calls"):
                    continue
                c = m.get("content") or ""
                if c:
                    tr = m.get("tool_runs")
                    ui.append(
                        UiMessage(
                            role="assistant",
                            content=c,
                            tool_runs=tr if isinstance(tr, list) and len(tr) > 0 else None,
                        )
                    )
        return ListMessagesResponse(messages=ui)

    @router.post(
        "/sessions/{conversation_id}/messages",
        response_model=ChatMessageResponse,
    )
    def post_message(conversation_id: str, body: ChatMessageBody) -> ChatMessageResponse:
        reply, tool_runs = run_agent_turn(
            conversation_id,
            body.message.strip(),
            sql_executor,
            start_date=body.start_date,
            end_date=body.end_date,
            agent=body.agent,
            source=body.source,
        )
        return ChatMessageResponse(
            reply=reply,
            conversation_id=conversation_id,
            tool_runs=tool_runs,
        )

    app.include_router(router)

