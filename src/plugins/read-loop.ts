import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fail } from '../core/errors.js';
import { fields, object, position } from '../core/validation.js';
import type { EventRecord } from '../core/types.js';
import type { PluginApi } from '../host/plugin-api.js';

export async function consume(api: PluginApi, sourcePrefix: string, type: string | undefined, accept: (record: EventRecord) => Promise<void>): Promise<() => Promise<void>> {
  await mkdir(api.dataDir, { recursive: true });
  const file = join(api.dataDir, 'position.json');
  let afterSeq = 0n;
  try {
    const stored = object(JSON.parse(await readFile(file, 'utf8')));
    fields(stored, ['store_id', 'last_seq'], ['store_id', 'last_seq']);
    if (stored.store_id !== api.storeId) fail('store_mismatch');
    afterSeq = position(stored.last_seq);
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
  const save = async (seq: bigint) => {
    if (seq === afterSeq) return;
    const temporary = file + '.tmp';
    await writeFile(temporary, JSON.stringify({ store_id: api.storeId, last_seq: seq.toString() }) + '\n', { mode: 0o600 });
    await rename(temporary, file);
    afterSeq = seq;
  };
  let pending = false;
  let running: Promise<void> | undefined;
  const drain = async () => {
    do {
      pending = false;
      if (api.signal.aborted) return;
      const page = await api.events.read({ afterSeq, sourcePrefix, ...(type === undefined ? {} : { type }) });
      for (const record of page.records) {
        if (api.signal.aborted) return;
        await accept(record);
        await save(record.seq);
      }
      await save(page.nextAfterSeq);
      pending ||= !page.caughtUp;
    } while (pending && !api.signal.aborted);
    if (!api.signal.aborted) api.setAvailable(true);
  };
  await drain();
  const wake = () => {
    if (api.signal.aborted) return;
    pending = true;
    if (running) return;
    running = drain().catch((error: unknown) => { if (!api.signal.aborted) api.setAvailable(false, error); });
    running.then(() => { running = undefined; }, () => { running = undefined; });
  };
  const unsubscribe = api.events.onAvailable(wake);
  const timer = setInterval(wake, 1000);
  return async () => { clearInterval(timer); unsubscribe(); await running; };
}
