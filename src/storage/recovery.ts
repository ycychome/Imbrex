import { DatabaseSync } from 'node:sqlite';
import type { EventRef } from '../core/types.js';

export interface RecoveryStoreInfo { storeId: string; latestSeq: bigint; eventSeq?: bigint }

// Offline inspection must not run Database startup recovery or change calls.
export function inspectRecoveryStore(path: string, ref?: EventRef): RecoveryStoreInfo {
  const db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
  try {
    db.exec('PRAGMA query_only=ON; BEGIN;');
    const metadata = db.prepare('SELECT value FROM metadata WHERE key=?');
    if (metadata.get('schema_version')?.value !== '1') throw new Error('Unsupported recovery schema');
    const storeId = metadata.get('store_id')?.value;
    if (typeof storeId !== 'string' || !storeId.length) throw new Error('Invalid recovery store');
    const latest = db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events');
    latest.setReadBigInts(true);
    const latestSeq = latest.get()?.seq;
    if (typeof latestSeq !== 'bigint') throw new Error('Invalid recovery position');
    let eventSeq: bigint | undefined;
    if (ref) {
      const event = db.prepare('SELECT seq FROM events WHERE source=? AND event_id=?');
      event.setReadBigInts(true);
      const found = event.get(ref.source, ref.id)?.seq;
      if (found !== undefined && typeof found !== 'bigint') throw new Error('Invalid recovery event');
      eventSeq = found;
    }
    db.exec('COMMIT');
    return { storeId, latestSeq, eventSeq };
  } finally { db.close(); }
}
