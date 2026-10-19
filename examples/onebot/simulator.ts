import { createInterface } from 'node:readline';
import { randomInt } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { pathToFileURL } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { numericFixture, stringFixture } from './fixtures.js';

export interface WireAction { action: string; params: Record<string, unknown>; echo: string }

export async function startSimulator(port = 0, token?: string) {
  const server = new WebSocketServer({ host: '127.0.0.1', port, maxPayload: 65536, perMessageDeflate: false,
    verifyClient: ({ req }: { req: IncomingMessage }) => token === undefined || req.headers.authorization === 'Bearer ' + token,
  });
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const state = {
    server, port: (server.address() as { port: number }).port, actions: [] as WireAction[],
    loginId: 123456 as number | string, appName: 'standard-numeric-fixture', protocolVersion: 'v11',
    mode: 'ok' as 'ok' | 'disconnect' | 'async' | 'malformed' | 'reject' | 'silent',
    broadcast: (event: unknown) => { for (const client of server.clients) if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(event)); },
    close: async () => {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
  server.on('connection', (socket) => socket.on('message', (raw) => {
    let request: WireAction;
    try { request = JSON.parse(raw.toString()) as WireAction; } catch { socket.close(); return; }
    const respond = (data: unknown, status = 'ok', retcode = 0) => socket.send(JSON.stringify({ status, retcode, data, echo: request.echo }));
    if (request.action === 'get_login_info') { respond({ user_id: state.loginId, nickname: 'fixture-bot' }); return; }
    if (request.action === 'get_version_info') { respond({ app_name: state.appName, app_version: 'fixture-1', protocol_version: state.protocolVersion }); return; }
    if (!['send_group_msg', 'send_private_msg'].includes(request.action)) { respond(null, 'failed', 1404); return; }
    state.actions.push(request);
    if (state.mode === 'disconnect') { socket.terminate(); return; }
    if (state.mode === 'silent') return;
    if (state.mode === 'async') { respond(null, 'async', 1); return; }
    if (state.mode === 'malformed') { respond({ message_id: 9007199254740992 }); return; }
    if (state.mode === 'reject') { respond(null, 'failed', 1400); return; }
    respond({ message_id: state.actions.length + 1000 });
  }));
  return state;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const simulator = await startSimulator(6700, process.env.IMBREX_ONEBOT_TOKEN);
  const input = createInterface({ input: process.stdin });
  let liveId = randomInt(100000, 1000000000);
  process.stdout.write('OneBot fixture on ws://127.0.0.1:6700/; commands: group, private, live-group, live-private, disconnect, actions, quit\n');
  input.on('line', (line) => {
    if (line === 'group') simulator.broadcast(numericFixture);
    if (line === 'private') simulator.broadcast(stringFixture);
    if ((line === 'live-group' || line === 'live-private') && liveId <= 2147483647) {
      simulator.broadcast({ ...(line === 'live-group' ? numericFixture : stringFixture), message_id: liveId, time: Math.floor(Date.now() / 1000) });
      process.stdout.write(JSON.stringify({ live_message_id: String(liveId++) }) + '\n');
    }
    if (line === 'disconnect') for (const socket of simulator.server.clients) socket.terminate();
    if (line === 'actions') process.stdout.write(JSON.stringify(simulator.actions, null, 2) + '\n');
    if (line === 'quit') input.close();
  });
  await new Promise<void>((resolve) => {
    input.once('close', resolve);
    process.once('SIGINT', () => input.close()); process.once('SIGTERM', () => input.close());
  });
  await simulator.close();
  process.stdin.destroy();
}
