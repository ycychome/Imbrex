import { parentPort, workerData } from 'node:worker_threads';
import { Database } from './database.js';
import { GatewayError } from '../core/errors.js';
import type { Request, Response } from './protocol.js';

const port = parentPort!;
const database = new Database((workerData as { path: string }).path);
port.on('message', (request: Request) => {
  try {
    let result: unknown;
    switch (request.method) {
      case 'info': result = database.info(); break;
      case 'append': result = database.append(...request.args); break;
      case 'read': result = database.read(...request.args); break;
      case 'lookup': result = database.lookup(...request.args); break;
      case 'getCall': result = database.getCall(...request.args); break;
      case 'listCalls': result = database.listCalls(...request.args); break;
      case 'createCall': result = database.createCall(...request.args); break;
      case 'finishCall': result = database.finishCall(...request.args); break;
      case 'close': database.close(); break;
    }
    port.postMessage({ type: 'result', id: request.id, result } satisfies Response);
    if (request.method === 'close') port.close();
  } catch (error) {
    port.postMessage({ type: 'error', id: request.id, code: error instanceof GatewayError ? error.code : 'storage_unavailable' } satisfies Response);
  }
});
port.postMessage({ type: 'ready' } satisfies Response);
