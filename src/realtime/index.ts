// Adapted from Abloatai/lobby workspace/bridge.ts at 1c2dc8e.
// Authenticated RPC, bounded ordered admission, backpressure and reconnect are
// the real Lobby transport. Document dispatch replaces the Unix file adapter.
import {randomUUID, timingSafeEqual} from 'node:crypto';
import {WebSocket, WebSocketServer} from 'ws';
import type {Request} from '../document/index.js';
export class BridgeError extends Error { constructor(public code: string) {super(code);} }
export async function startBridge(options: {host: string; port: number; token: string; request(input: Request, actor:string): unknown; release?(actor:string):Promise<void>}) {
  if (options.token.length < 32) throw new Error('Bridge credential must have at least 32 characters');
  const authorized = (authorization: unknown) => {
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false;
    const token = Buffer.from(authorization.slice(7)), expected = Buffer.from(options.token);
    return token.length === expected.length && timingSafeEqual(token, expected);
  };
  let pending=0;const active=new Set<Promise<unknown>>();
  const server = new WebSocketServer({host: options.host, port: options.port, maxPayload: 1024 * 1024,
    verifyClient: (info: {req: import('node:http').IncomingMessage}) => !info.req.headers.origin && authorized(info.req.headers.authorization)});
  server.on('connection', socket => {
    const actor=randomUUID();let tail=Promise.resolve();
    socket.on('close',()=>void tail.then(()=>options.release?.(actor)).catch(()=>{}));
    if (server.clients.size > 32) {socket.close(1013, 'Connection limit'); return;}
    const send = (value: unknown) => {
      if (socket.bufferedAmount > 4 * 1024 * 1024) {socket.terminate(); return;}
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
    };
    socket.on('message', raw => {
      let message: {id?: string; request?: Request} = {};
      try {
        message = JSON.parse(String(raw));
        if (typeof message.id !== 'string' || message.id.length > 128 || !message.request || typeof message.request !== 'object') throw new BridgeError('invalid_request');
        if (pending >= 16) throw new BridgeError('adapter_busy');
        pending++;
        const input = message.request;
        const result = tail.then(() => options.request(input,actor));
        active.add(result);
        tail = result.then(() => {}, () => {}).finally(() => {pending--;active.delete(result);});
        void result.then(result => send({id: message.id, result}), error => send({id: message.id, error: {code: error.message || 'outcome_unknown'}}));
      } catch (error) {send({id: message?.id, error: {code: (error as Error).message || 'invalid_request'}});}
    });
    socket.on('error', () => socket.terminate());
  });
  await new Promise<void>((resolve, reject) => {server.once('listening', resolve); server.once('error', reject);});
  return {address: server.address(), async close() {for (const client of server.clients) client.terminate();await Promise.allSettled([...active]); await new Promise<void>(resolve => server.close(() => resolve()));}};
}
/** Reconnect on demand. A lost mutation is reconciled via version history. */
export function connectBridge(url: string, token: string) {
  const parsed = new URL(url);
  if (parsed.username || parsed.password || parsed.search || parsed.hash || !['ws:','wss:'].includes(parsed.protocol)) throw new Error('invalid_bridge_url');
  if (parsed.protocol === 'ws:' && !['127.0.0.1','localhost','[::1]'].includes(parsed.hostname)) throw new Error('Remote bridge requires wss');
  let socket: WebSocket | undefined, ready: Promise<void> | undefined, closed = false;
  const pending = new Map<string, {resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout}>();
  const disconnect = (connection: WebSocket) => {
    if (socket !== connection) return;
    socket = undefined; ready = undefined;
    for (const entry of pending.values()) {clearTimeout(entry.timer); entry.reject(new BridgeError('outcome_unknown'));}
    pending.clear(); connection.terminate();
  };
  return {
    async request(input: Request): Promise<unknown> {
      if (closed) throw new BridgeError('connection_closed');
      if (!socket) {
        const connection = new WebSocket(url, {headers: {authorization: `Bearer ${token}`}, maxPayload: 16 * 1024 * 1024, handshakeTimeout: 5000});
        socket = connection;
        ready = new Promise<void>((resolve, reject) => {connection.once('open', resolve); connection.once('error', () => reject(new BridgeError('adapter_unavailable'))); connection.once('close', () => reject(new BridgeError('adapter_unavailable')));});
        connection.on('close', () => disconnect(connection));
        connection.on('error', () => disconnect(connection));
        connection.on('message', raw => {
          try {
            const message = JSON.parse(String(raw)), entry = pending.get(message.id);
            if (!entry) throw new Error('Unexpected response');
            pending.delete(message.id); clearTimeout(entry.timer);
            if (message.error) entry.reject(new BridgeError(message.error.code));
            else entry.resolve(message.result);
          } catch {disconnect(connection);}
        });
      }
      await ready;
      if (!socket || socket.readyState !== WebSocket.OPEN) throw new BridgeError('adapter_unavailable');
      if (pending.size >= 16) throw new BridgeError('adapter_busy');
      const connection = socket, id = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => disconnect(connection), 10_000);
        pending.set(id, {resolve, reject, timer});
        connection.send(JSON.stringify({id, request: input}));
      });
    },
    disconnect() {if (socket) disconnect(socket);},
    close() {closed = true; if (socket) disconnect(socket);},
  };
}
