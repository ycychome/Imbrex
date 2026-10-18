import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';

// Risk: an oversized provider frame can bypass the intended receive boundary.
test('ws rejects an oversized frame instead of delivering it to the consumer', async (t) => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  t.after(async () => {
    for (const peer of server.clients) peer.terminate();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const connection = once(server, 'connection');
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`, { maxPayload: 16 });
  t.after(() => client.terminate());
  const clientError = once(client, 'error');
  let delivered = false;
  client.on('message', () => { delivered = true; });
  const [peer] = await connection as [WebSocket];
  peer.send('x'.repeat(17));
  const [error] = await clientError as [Error & { code: string }];
  assert.equal(error.code, 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH');
  assert.equal(delivered, false);
});
