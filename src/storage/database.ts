import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite';
import { fail } from '../core/errors.js';
import type { CallOutcome, CallPage, CallQuery, CallRecord, NewCall, StoreInfo } from '../core/store.js';
import type { AppendResult, EventInput, EventPage, EventRecord, EventRef, ReadOptions, SourceRule } from '../core/types.js';

type Row = Record<string, SQLOutputValue>;

export class Database {
  private readonly db: DatabaseSync;
  readonly storeId: string;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { allowExtension: false });
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
      this.storeId = this.transaction(() => {
        this.db.exec('CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
        const version = this.db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get()?.value;
        if (version === undefined) {
          this.db.exec(`
            CREATE TABLE events (
              seq INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, event_id TEXT NOT NULL, event_type TEXT NOT NULL,
              event_json TEXT NOT NULL, parents_json TEXT NOT NULL, accepted_at TEXT NOT NULL, UNIQUE(source, event_id)
            );
            CREATE INDEX events_type_seq ON events(event_type, seq);
            CREATE TABLE calls (
              caller_id TEXT NOT NULL, call_id TEXT NOT NULL, capability_id TEXT NOT NULL, schema_version TEXT NOT NULL,
              params_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('in_progress','succeeded','failed','unknown')),
              result_json TEXT, reason_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(caller_id,call_id)
            );
          `);
          const set = this.db.prepare('INSERT INTO metadata (key,value) VALUES (?,?)');
          set.run('schema_version', '1'); set.run('store_id', randomUUID());
        } else if (version !== '1') fail('storage_unavailable');
        const storeId = this.db.prepare("SELECT value FROM metadata WHERE key='store_id'").get()?.value;
        if (typeof storeId !== 'string' || !storeId.length) fail('storage_unavailable');
        this.db.prepare("UPDATE calls SET status='unknown', reason_json=?, updated_at=? WHERE status='in_progress'")
          .run(JSON.stringify({ code: 'gateway_restarted', message: 'Execution outcome requires verification after restart.' }), new Date().toISOString());
        return storeId;
      });
      const { pragmas } = this.info();
      if (pragmas.journalMode !== 'wal' || pragmas.synchronous !== 2 || pragmas.foreignKeys !== 1 || pragmas.busyTimeout !== 5000) fail('storage_unavailable');
    } catch (error) { this.db.close(); throw error; }
  }

  private transaction<T>(callback: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = callback();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* Preserve the original database error. */ }
      throw error;
    }
  }
  private check(storeId: string): void { if (storeId !== this.storeId) fail('store_mismatch'); }
  private latest(): bigint {
    const statement = this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events');
    statement.setReadBigInts(true);
    return statement.get()?.seq as bigint;
  }
  private record(row: Row): EventRecord {
    return { seq: row.seq as bigint, acceptedAt: row.accepted_at as string, event: JSON.parse(row.event_json as string), parents: JSON.parse(row.parents_json as string) };
  }
  private call(row: Row): CallRecord {
    return {
      callerId: row.caller_id as string, callId: row.call_id as string, capabilityId: row.capability_id as string,
      schemaVersion: row.schema_version as string, params: JSON.parse(row.params_json as string), status: row.status as CallRecord['status'],
      ...(row.result_json === null ? {} : { result: JSON.parse(row.result_json as string) }),
      ...(row.reason_json === null ? {} : { reason: JSON.parse(row.reason_json as string) }),
      createdAt: row.created_at as string, updatedAt: row.updated_at as string,
    };
  }
  info(): StoreInfo {
    const row = this.db.prepare('SELECT sqlite_version() AS version, sqlite_source_id() AS source').get()!;
    return {
      storeId: this.storeId, latestSeq: this.latest(), schemaVersion: 1, sqliteVersion: row.version as string, sqliteSourceId: row.source as string,
      pragmas: {
        journalMode: this.db.prepare('PRAGMA journal_mode').get()?.journal_mode as string,
        synchronous: this.db.prepare('PRAGMA synchronous').get()?.synchronous as number,
        foreignKeys: this.db.prepare('PRAGMA foreign_keys').get()?.foreign_keys as number,
        busyTimeout: this.db.prepare('PRAGMA busy_timeout').get()?.timeout as number,
      },
    };
  }
  append(storeId: string, input: EventInput): AppendResult {
    this.check(storeId);
    return this.transaction(() => {
      const { event, parents } = input;
      const insert = this.db.prepare('INSERT INTO events (source,event_id,event_type,event_json,parents_json,accepted_at) VALUES (?,?,?,?,?,?) ON CONFLICT(source,event_id) DO NOTHING');
      insert.setReadBigInts(true);
      const result = insert.run(event.source, event.id, event.type, JSON.stringify(event), JSON.stringify(parents), new Date().toISOString());
      const record = this.lookup(storeId, event)!;
      return { status: result.changes === 0n ? 'duplicate_identity' : 'created', storeId, seq: record.seq, acceptedAt: record.acceptedAt, eventRef: { source: event.source, id: event.id } };
    });
  }
  lookup(storeId: string, ref: EventRef): EventRecord | undefined {
    this.check(storeId);
    const statement = this.db.prepare('SELECT * FROM events WHERE source=? AND event_id=?');
    statement.setReadBigInts(true);
    const row = statement.get(ref.source, ref.id);
    return row && this.record(row);
  }
  read(storeId: string, options: ReadOptions, sources: SourceRule[]): EventPage {
    this.check(storeId);
    return this.transaction(() => {
      const throughSeq = this.latest();
      if (options.afterSeq > throughSeq) fail('position_ahead');
      const clauses = ['seq > ?', 'seq <= ?'];
      const args: SQLInputValue[] = [options.afterSeq, throughSeq];
      if (options.sourcePrefix !== undefined) { clauses.push('substr(CAST(source AS BLOB),1,length(CAST(? AS BLOB))) = CAST(? AS BLOB)'); args.push(options.sourcePrefix, options.sourcePrefix); }
      if (options.type !== undefined) { clauses.push('event_type = ? COLLATE BINARY'); args.push(options.type); }
      const scopes = sources.map((rule) => {
        if ('exact' in rule) { args.push(rule.exact); return 'source = ? COLLATE BINARY'; }
        args.push(rule.prefix, rule.prefix); return 'substr(CAST(source AS BLOB),1,length(CAST(? AS BLOB))) = CAST(? AS BLOB)';
      });
      clauses.push(scopes.length ? '(' + scopes.join(' OR ') + ')' : '0');
      args.push(options.limit + 1);
      const statement = this.db.prepare('SELECT * FROM events WHERE ' + clauses.join(' AND ') + ' ORDER BY seq LIMIT ?');
      statement.setReadBigInts(true);
      const rows = statement.all(...args);
      const caughtUp = rows.length <= options.limit;
      const records = rows.slice(0, options.limit).map((row) => this.record(row));
      return { storeId, records, throughSeq, nextAfterSeq: caughtUp ? throughSeq : records[records.length - 1]!.seq, caughtUp };
    });
  }
  getCall(storeId: string, callerId: string, callId: string): CallRecord | undefined {
    this.check(storeId);
    const row = this.db.prepare('SELECT * FROM calls WHERE caller_id=? AND call_id=?').get(callerId, callId);
    return row && this.call(row);
  }
  listCalls(storeId: string, query: CallQuery): CallPage {
    this.check(storeId);
    const clauses: string[] = [];
    const args: SQLInputValue[] = [];
    if (query.after) { clauses.push('(caller_id,call_id) > (?,?)'); args.push(query.after.callerId, query.after.callId); }
    if (query.callerId) { clauses.push('caller_id = ?'); args.push(query.callerId); }
    if (query.status) { clauses.push('status = ?'); args.push(query.status); }
    args.push(query.limit + 1);
    const rows = this.db.prepare('SELECT * FROM calls' + (clauses.length ? ' WHERE ' + clauses.join(' AND ') : '') + ' ORDER BY caller_id,call_id LIMIT ?').all(...args);
    const calls = rows.slice(0, query.limit).map((row) => this.call(row));
    const last = calls.at(-1);
    return { calls, next: rows.length > query.limit && last ? { callerId: last.callerId, callId: last.callId } : null };
  }
  createCall(storeId: string, call: NewCall): { created: boolean; call: CallRecord } {
    this.check(storeId);
    return this.transaction(() => {
      const now = new Date().toISOString();
      const result = this.db.prepare("INSERT INTO calls (caller_id,call_id,capability_id,schema_version,params_json,status,created_at,updated_at) VALUES (?,?,?,?,?,'in_progress',?,?) ON CONFLICT(caller_id,call_id) DO NOTHING")
        .run(call.callerId, call.callId, call.capabilityId, call.schemaVersion, JSON.stringify(call.params), now, now);
      return { created: result.changes !== 0, call: this.getCall(storeId, call.callerId, call.callId)! };
    });
  }
  finishCall(storeId: string, callerId: string, callId: string, outcome: CallOutcome): CallRecord {
    this.check(storeId);
    return this.transaction(() => {
      this.db.prepare("UPDATE calls SET status=?, result_json=?, reason_json=?, updated_at=? WHERE caller_id=? AND call_id=? AND status IN ('in_progress','unknown')")
        .run(outcome.status, 'result' in outcome ? JSON.stringify(outcome.result) : null, 'reason' in outcome ? JSON.stringify(outcome.reason) : null, new Date().toISOString(), callerId, callId);
      return this.getCall(storeId, callerId, callId) ?? fail('call_not_found');
    });
  }
  close(): void { this.db.close(); }
}
