from __future__ import annotations

import fcntl
import json
import sqlite3
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from .models import MemoryError, OperationRequest, canonical, digest, now


class Store:
    """The ledger is authoritative. Graphiti is a disposable search index."""

    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.lock_file = path.with_suffix(".lock").open("a+b")
        try:
            fcntl.flock(self.lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.lock_file.close()
            raise RuntimeError("Memory data directory is already in use; run one service worker") from None
        self.db = sqlite3.connect(path, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        if self.db.execute("PRAGMA user_version").fetchone()[0] not in (0, 1):
            self.close()
            raise RuntimeError("Unsupported Memory ledger schema")
        self.db.executescript("""
          PRAGMA journal_mode=WAL;
          PRAGMA synchronous=FULL;
          PRAGMA foreign_keys=ON;
          CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS scopes (
            key TEXT PRIMARY KEY, store_id TEXT NOT NULL, instance_id TEXT NOT NULL,
            source TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1,
            fingerprint TEXT NOT NULL, quarantined INTEGER NOT NULL DEFAULT 0,
            visual_quarantined INTEGER NOT NULL DEFAULT 0,
            UNIQUE(store_id,instance_id,source));
          CREATE TABLE IF NOT EXISTS operations (
            id TEXT PRIMARY KEY, body_hash TEXT NOT NULL, body TEXT NOT NULL,
            state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            result TEXT, error TEXT);
          CREATE TABLE IF NOT EXISTS records (
            scope TEXT NOT NULL REFERENCES scopes(key), id TEXT NOT NULL,
            body TEXT NOT NULL, PRIMARY KEY(scope,id));
          CREATE TABLE IF NOT EXISTS memories (
            id TEXT PRIMARY KEY, scope TEXT NOT NULL REFERENCES scopes(key),
            revision INTEGER NOT NULL, active INTEGER NOT NULL, manual INTEGER NOT NULL,
            slot TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(scope,slot));
          CREATE TABLE IF NOT EXISTS versions (
            id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL,
            PRIMARY KEY(id,revision));
          CREATE TABLE IF NOT EXISTS tombstones (
            scope TEXT NOT NULL, evidence_id TEXT NOT NULL, category TEXT NOT NULL,
            memory_id TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL,
            PRIMARY KEY(scope,evidence_id,category));
          CREATE TABLE IF NOT EXISTS aliases (
            scope TEXT NOT NULL, person TEXT NOT NULL, alias TEXT NOT NULL,
            kind TEXT NOT NULL, observed_at TEXT NOT NULL, event_id TEXT NOT NULL,
            PRIMARY KEY(scope,person,alias,kind,event_id));
          CREATE TABLE IF NOT EXISTS visual_results (
            scope TEXT NOT NULL, event_id TEXT NOT NULL, segment_index INTEGER NOT NULL,
            fingerprint TEXT NOT NULL, body TEXT NOT NULL,
            PRIMARY KEY(scope,event_id,segment_index,fingerprint));
          CREATE TABLE IF NOT EXISTS visual_jobs (
            scope TEXT NOT NULL, event_id TEXT NOT NULL, state TEXT NOT NULL,
            PRIMARY KEY(scope,event_id));
          CREATE TABLE IF NOT EXISTS effects (
            operation_id TEXT PRIMARY KEY, result TEXT NOT NULL);
        """)
        with self.transaction():
            self.db.execute("INSERT OR IGNORE INTO metadata VALUES('ledger_id',?)", (digest(uuid.uuid4().hex),))
            self.ledger_id: str = self.db.execute("SELECT value FROM metadata WHERE key='ledger_id'").fetchone()[0]
            columns = {row[1] for row in self.db.execute("PRAGMA table_info(scopes)")}
            if "visual_quarantined" not in columns:
                self.db.execute("ALTER TABLE scopes ADD COLUMN visual_quarantined INTEGER NOT NULL DEFAULT 0")
            self.db.execute("PRAGMA user_version=1")
            self.db.execute("UPDATE scopes SET visual_quarantined=1 WHERE key IN (SELECT scope FROM visual_jobs WHERE state='indexing')")
            self.db.execute("UPDATE visual_jobs SET state='unknown' WHERE state='indexing'")
            self.db.execute("UPDATE visual_jobs SET state='queued' WHERE state='running'")
            for row in self.db.execute("SELECT body FROM operations WHERE state='running'").fetchall():
                request = OperationRequest.model_validate_json(row["body"])
                if request.kind != "images":
                    self.quarantine(request)
                else:
                    self.db.execute("UPDATE operations SET state='queued' WHERE id=?", (request.request_id,))
            self.db.execute("UPDATE operations SET state='unknown',error='interrupted',updated_at=? WHERE state='running'", (now(),))

    @contextmanager
    def transaction(self) -> Iterator[None]:
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield
            self.db.execute("COMMIT")
        except BaseException:
            self.db.execute("ROLLBACK")
            raise

    def close(self) -> None:
        self.db.close()
        self.lock_file.close()

    def scope(self, store: str, instance: str, source: str, fingerprint: str) -> sqlite3.Row:
        existing = self.db.execute(
            "SELECT * FROM scopes WHERE store_id=? AND instance_id=? AND source=?", (store, instance, source)
        ).fetchone()
        if existing:
            return existing
        key = digest([self.ledger_id, store, instance, source])
        self.db.execute(
            "INSERT OR IGNORE INTO scopes(key,store_id,instance_id,source,fingerprint) VALUES(?,?,?,?,?)",
            (key, store, instance, source, fingerprint),
        )
        row = self.db.execute("SELECT * FROM scopes WHERE key=?", (key,)).fetchone()
        assert row is not None
        return row

    def scopes(self, request: Any, fingerprint: str) -> list[sqlite3.Row]:
        return [self.scope(request.store_id, request.instance_id, source, fingerprint) for source in sorted(set(request.scopes))]

    def accept(self, request: OperationRequest, limit: int) -> dict[str, Any]:
        body = canonical(request.model_dump())
        with self.transaction():
            row = self.db.execute("SELECT * FROM operations WHERE id=?", (request.request_id,)).fetchone()
            if row:
                if row["body_hash"] != digest(request.model_dump()):
                    raise MemoryError("idempotency_conflict")
                return self.operation(row)
            count = self.db.execute(
                "SELECT count(*) FROM operations WHERE state IN ('queued','running') AND (json_extract(body,'$.kind')='images')=?",
                (int(request.kind == "images"),),
            ).fetchone()[0]
            if count >= limit:
                raise MemoryError("busy", 429)
            stamp = now()
            self.db.execute(
                "INSERT INTO operations VALUES(?,?,?,?,?,?,?,?)",
                (request.request_id, digest(request.model_dump()), body, "queued", stamp, stamp, None, None),
            )
        return {"operation_id": request.request_id, "state": "queued", "accepted": True, "applied": False}

    @staticmethod
    def operation(row: sqlite3.Row) -> dict[str, Any]:
        result: dict[str, Any] = {
            "operation_id": row["id"],
            "state": row["state"],
            "accepted": True,
            "applied": row["state"] == "succeeded",
        }
        if row["result"]:
            result["result"] = json.loads(row["result"])
        if row["error"]:
            result["error"] = {"code": row["error"], "message": "Memory operation did not complete; inspect status and recover the scope."}
        return result

    def finish(self, request: OperationRequest, state: str, result: dict[str, Any] | None = None, error: str | None = None) -> None:
        self.db.execute(
            "UPDATE operations SET state=?,updated_at=?,result=?,error=? WHERE id=?",
            (state, now(), canonical(result) if result is not None else None, error, request.request_id),
        )

    def quarantine(self, request: OperationRequest) -> None:
        for source in request.scopes:
            self.db.execute(
                "UPDATE scopes SET quarantined=1 WHERE store_id=? AND instance_id=? AND source=?",
                (request.store_id, request.instance_id, source),
            )

    def current(self, scope_keys: list[str], active: bool = True) -> list[dict[str, Any]]:
        placeholders = ",".join("?" for _ in scope_keys)
        rows = self.db.execute(
            f"SELECT body FROM memories WHERE scope IN ({placeholders})" + (" AND active=1" if active else ""), scope_keys
        )
        return [json.loads(row[0]) for row in rows]

    def put_memory(self, memory: dict[str, Any], scope: str, slot: str, manual: bool) -> None:
        self.db.execute(
            "INSERT INTO memories VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,active=excluded.active,manual=excluded.manual,body=excluded.body",
            (memory["id"], scope, memory["revision"], int(memory["active"]), int(manual), slot, canonical(memory)),
        )
        self.db.execute("INSERT INTO versions VALUES(?,?,?)", (memory["id"], memory["revision"], canonical(memory)))

    def effect(self, request: OperationRequest, result: dict[str, Any]) -> dict[str, Any]:
        self.db.execute("INSERT OR REPLACE INTO effects VALUES(?,?)", (request.request_id, canonical(result)))
        return result

    @staticmethod
    def group(scope: sqlite3.Row, generation: int | None = None, channel: str = "text") -> str:
        identity = [scope["key"], generation or scope["generation"]]
        return "imbrex_" + digest(identity if channel == "text" else [*identity, channel])
