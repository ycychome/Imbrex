import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

// Risk: default SQLite number reads cannot represent the gateway's 64-bit seq.
test('SQLite preserves a sequence above Number.MAX_SAFE_INTEGER across reopen', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'imbrex-sqlite-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'probe.db');
  const expected = 9007199254740993n;
  const writer = new DatabaseSync(path);
  try {
    writer.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    assert.equal(writer.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
    assert.equal(writer.prepare('PRAGMA synchronous').get()?.synchronous, 2);
    writer.exec('CREATE TABLE probe (seq INTEGER PRIMARY KEY)');
    writer.prepare('INSERT INTO probe (seq) VALUES (?)').run(expected);
  } finally {
    writer.close();
  }

  const reader = new DatabaseSync(path);
  try {
    const statement = reader.prepare('SELECT seq FROM probe');
    assert.throws(() => statement.get(), { code: 'ERR_OUT_OF_RANGE' });
    statement.setReadBigInts(true);
    assert.equal(statement.get()?.seq, expected);
    const version = reader.prepare('SELECT sqlite_version() AS version, sqlite_source_id() AS source_id').get();
    t.diagnostic(JSON.stringify(version));
  } finally {
    reader.close();
  }
});
