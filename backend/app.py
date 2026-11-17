"""AI_Agent_KL local backend relay.

Bridges the Vercel Next.js frontend to the real local Hermes runtime by
spawning the official Hermes CLI (`hermes chat -q --oneshot`) for every turn.
Every AI interaction is processed by the local Hermes Agent (main-model via
9Router, skills, tools, MCP, memory).
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any, AsyncIterator, Dict, Optional

try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass

import httpx
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
HERMES_HOME = os.environ.get("HERMES_HOME", r"C:\Users\USER\AppData\Local\hermes")
HERMES_SERVE_URL = os.environ.get("HERMES_SERVE_URL", "http://127.0.0.1:9119")
HERMES_BIN = os.environ.get("HERMES_BIN", "hermes")
STATE_DB = Path(HERMES_HOME) / "state.db"

# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
app = FastAPI(title="AI_Agent_KL Relay", version="0.1.0")

# CORS: allow the frontend origins. Default "*" if unset; support comma-separated.
_frontend_origins = os.environ.get("FRONTEND_ORIGIN", "").strip()
if _frontend_origins:
    allow_origins = [o.strip() for o in _frontend_origins.split(",") if o.strip()]
else:
    allow_origins = ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Map frontend session_id -> real Hermes session id (for --resume continuity)
SESSION_MAP: Dict[str, str] = {}
SESSION_MAP_LOCK = threading.Lock()

# Lines to drop from hermes chat --oneshot output (metadata, not answer)
_DROP_PREFIXES = (
    "Query:",
    "☤ Hermes",
    "👁️",
    "Resume this session",
    "Resumed session",
    "  hermes --resume",
    "  hermes -c",
    "Session:",
    "Title:",
    "Duration:",
    "Messages:",
    "Goodbye!",
    "────",
    "━",
    "─",
    "local-",
    "Model restored from session",
    "🧠 Memory",
    "🧠",
)
# Quoted summary lines like: "Some title" (N user message, M total messages)
_SUMMARY_RE = re.compile(r'^"?[^\"]{3,40}"?(?:\s*\(\d+ user message.*)?$')
_SUMMARY_MARKER = "user message"


def _is_drop_line(line: str) -> bool:
    s = line.strip()
    if not s:
        return True
    for p in _DROP_PREFIXES:
        if p.strip() in s:
            return True
    if _SUMMARY_RE.match(s) and _SUMMARY_MARKER in s:
        return True
    return False


# ---------------------------------------------------------------------------
# Auth helper (token-free frontend)
# ---------------------------------------------------------------------------
def require_auth(authorization: Optional[str]) -> None:
    return None


# ---------------------------------------------------------------------------
# Hermes state.db readers
# ---------------------------------------------------------------------------
def _open_state_db() -> sqlite3.Connection:
    con = sqlite3.connect(str(STATE_DB), timeout=30)
    con.row_factory = sqlite3.Row
    return con


def list_sessions(limit: int = 50) -> list[dict[str, Any]]:
    if not STATE_DB.exists():
        return []
    con = _open_state_db()
    try:
        cur = con.cursor()
        cur.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%session%'"
        )
        tables = [r[0] for r in cur.fetchall()]
        if not tables:
            return []
        table = tables[0]
        cur.execute(f"PRAGMA table_info({table})")
        cols = {r[1] for r in cur.fetchall()}
        id_col = "id" if "id" in cols else ("session_id" if "session_id" in cols else list(cols)[0])
        title_col = "title" if "title" in cols else id_col
        updated_col = (
            "last_active"
            if "last_active" in cols
            else ("updated_at" if "updated_at" in cols else ("started_at" if "started_at" in cols else None))
        )
        model_col = "model" if "model" in cols else None
        query = f"SELECT {id_col} AS id, {title_col} AS title"
        if updated_col:
            query += f", {updated_col} AS last_active"
        else:
            query += ", NULL AS last_active"
        if model_col:
            query += f", {model_col} AS model"
        else:
            query += ", NULL AS model"
        query += f" FROM {table}"
        if updated_col:
            query += f" ORDER BY {updated_col} DESC"
        query += f" LIMIT {limit}"
        cur.execute(query)
        return [dict(r) for r in cur.fetchall()]
    finally:
        con.close()


def get_session_messages(session_id: str) -> list[dict[str, Any]]:
    if not STATE_DB.exists():
        return []
    con = _open_state_db()
    try:
        cur = con.cursor()
        cur.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%message%'"
        )
        tables = [r[0] for r in cur.fetchall()]
        if not tables:
            return []
        table = tables[0]
        cur.execute(f"PRAGMA table_info({table})")
        cols = {r[1] for r in cur.fetchall()}
        sid_col = "session_id" if "session_id" in cols else ("id" if "id" in cols else None)
        role_col = "role" if "role" in cols else None
        content_col = "content" if "content" in cols else ("text" if "text" in cols else None)
        if not (sid_col and content_col):
            return []
        sel = f"{sid_col} AS session_id, {role_col} AS role, {content_col} AS content"
        if "created_at" in cols:
            sel += ", created_at AS created_at"
        else:
            sel += ", NULL AS created_at"
        cur.execute(f"SELECT {sel} FROM {table} WHERE {sid_col}=? ORDER BY rowid", (session_id,))
        return [dict(r) for r in cur.fetchall()]
    finally:
        con.close()


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.get("/api/health")
async def health() -> dict[str, Any]:
    hermes_ok = False
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            r = await client.get(f"{HERMES_SERVE_URL}/api/status")
            hermes_ok = r.status_code == 200
    except Exception:
        hermes_ok = False
    return {"status": "ok", "hermes_serve": hermes_ok}


@app.get("/api/config")
async def config() -> dict[str, Any]:
    return {
        "provider": "custom (9Router)",
        "model": "main-model",
        "base_url": "http://localhost:20128/v1",
        "context_length": 1000000,
        "streaming": True,
    }


@app.get("/api/sessions")
async def api_list_sessions(
    authorization: Optional[str] = Header(None),
    limit: int = 50,
) -> JSONResponse:
    require_auth(authorization)
    return JSONResponse({"sessions": list_sessions(limit=limit)})


@app.post("/api/sessions")
async def api_create_session(
    authorization: Optional[str] = Header(None),
) -> JSONResponse:
    require_auth(authorization)
    session_id = f"local-{uuid.uuid4().hex}"
    title = "New Chat"
    try:
        if STATE_DB.exists():
            con = _open_state_db()
            try:
                cur = con.cursor()
                cur.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%session%'"
                )
                tables = [r[0] for r in con.fetchall()]
                if tables:
                    table = tables[0]
                    cur.execute(f"PRAGMA table_info({table})")
                    cols = {r[1] for r in con.fetchall()}
                    id_col = "id" if "id" in cols else ("session_id" if "session_id" in cols else None)
                    title_col = "title" if "title" in cols else None
                    if id_col and title_col:
                        cur.execute(
                            f"INSERT OR REPLACE INTO {table} ({id_col}, {title_col}, started_at, last_active) VALUES (?,?,?,?)",
                            (session_id, title, int(time.time()), int(time.time())),
                        )
                        con.commit()
            finally:
                con.close()
    except Exception:
        pass
    return JSONResponse({"session_id": session_id, "title": title}, status_code=201)


@app.get("/api/sessions/{session_id}")
async def api_get_session(
    session_id: str,
    authorization: Optional[str] = Header(None),
) -> JSONResponse:
    require_auth(authorization)
    return JSONResponse({"session_id": session_id, "messages": get_session_messages(session_id)})


@app.delete("/api/sessions/{session_id}")
async def api_delete_session(
    session_id: str,
    authorization: Optional[str] = Header(None),
) -> JSONResponse:
    require_auth(authorization)
    try:
        if STATE_DB.exists():
            con = _open_state_db()
            try:
                cur = con.cursor()
                cur.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%session%'"
                )
                tables = [r[0] for r in con.fetchall()]
                if tables:
                    table = tables[0]
                    cur.execute(f"PRAGMA table_info({table})")
                    cols = {r[1] for r in con.fetchall()}
                    id_col = "id" if "id" in cols else ("session_id" if "session_id" in cols else None)
                    if id_col:
                        cur.execute(f"DELETE FROM {table} WHERE {id_col}=?", (session_id,))
                        con.commit()
            finally:
                con.close()
    except Exception:
        pass
    return JSONResponse({"ok": True})


@app.post("/api/chat")
async def api_chat_request(
    request: Request,
    authorization: Optional[str] = Header(None),
) -> StreamingResponse:
    """Run one Hermes turn by spawning the real CLI (`hermes chat -q --oneshot`)."""
    require_auth(authorization)
    body = await request.json()
    session_id = body.get("session_id")
    message = body.get("message", "")
    if not session_id or not message:
        raise HTTPException(status_code=400, detail="session_id and message required")

    resume_id = None
    with SESSION_MAP_LOCK:
        resume_id = SESSION_MAP.get(session_id)
    cmd = [HERMES_BIN, "chat", "-q", message]
    if resume_id:
        cmd += ["--resume", resume_id]
    cmd += ["--oneshot", "--format", "text"]

    async def event_stream() -> AsyncIterator[str]:
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            assert proc.stdout is not None
            while True:
                chunk = await proc.stdout.readline()
                if not chunk:
                    break
                raw = chunk.decode("utf-8", errors="replace").rstrip("\n")
                if not raw:
                    continue
                line = re.sub(r"\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(?:\x07|\x1b\\)", "", raw)
                if line.startswith("Session:"):
                    parts = line.split()
                    if len(parts) >= 2:
                        hid = parts[1].strip()
                        with SESSION_MAP_LOCK:
                            SESSION_MAP[session_id] = hid
                    continue
                if _is_drop_line(line):
                    continue
                yield f"event: message\ndata: {json.dumps({'text': line + chr(10)})}\n\n"
            await proc.wait()
            if proc.returncode != 0:
                err = (await proc.stderr.read() if proc.stderr else b"").decode(errors="replace")
                yield f"event: error\ndata: {json.dumps({'detail': err or f'exit {proc.returncode}'})}\n\n"
        except Exception as exc:
            yield f"event: error\ndata: {json.dumps({'detail': str(exc)})}\n\n"
        finally:
            yield f"event: done\ndata: {json.dumps({'session_id': session_id})}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("RELAY_PORT", "8787")))
