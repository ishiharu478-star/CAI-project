import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { REST } from '@discordjs/rest';
import { createConnectionDiagnostics } from '../src/diagnostics.js';

function harness() {
  const client = new EventEmitter();
  client.rest = new EventEmitter();
  client.ready = false;
  client.isReady = () => client.ready;
  client.login = () => { throw new Error('diagnostics must never log in'); };
  client.destroy = () => { throw new Error('diagnostics must never stop the bot'); };
  let time = 1000;
  const ticks = new Set();
  const logs = [];
  const options = { client, now: () => time,
    logger: Object.fromEntries(['log', 'warn', 'error'].map(level => [level, (...args) => logs.push([level, ...args])])),
    setIntervalImpl(callback, interval) { assert.equal(interval, 30000); ticks.add(callback); return callback; },
    clearIntervalImpl(callback) { ticks.delete(callback); } };
  const diagnostics = createConnectionDiagnostics(options);
  return { client, diagnostics, logs, ticks, options, advance(ms) { time += ms; }, tick() { for (const callback of ticks) callback(); } };
}
function publicOutput(h) { return JSON.stringify({ logs: h.logs, snapshot: h.diagnostics.snapshot() }); }

test('watchdog observes startup without login, HTTP requests, shutdown or retry calls', () => {
  const h = harness();
  assert.deepEqual(h.diagnostics.snapshot(), { phase: 'idle', waitingSeconds: 0, retryAfterSeconds: 0 });
  h.diagnostics.start(); h.diagnostics.start();
  assert.equal(h.ticks.size, 1);
  h.advance(30000); h.tick();
  assert.deepEqual(h.diagnostics.snapshot(), { phase: 'requesting_gateway', waitingSeconds: 30, retryAfterSeconds: 0 });
  assert.match(publicOutput(h), /SDKの処理を継続中/);
  h.diagnostics.stop();
  assert.equal(h.ticks.size, 0);
  assert.equal(h.client.listenerCount('debug'), 0);
  assert.equal(h.client.rest.listenerCount('restDebug'), 0);
});

test('static gateway markers expose connection stages without raw gateway payloads', () => {
  const h = harness(); h.diagnostics.start();
  const debug = (message, phase) => { h.client.emit('debug', message); assert.equal(h.diagnostics.snapshot().phase, phase); };
  debug('[WS => Manager] Fetched Gateway Information\n\tURL: wss://secret.example/token', 'gateway_received');
  debug('[WS => Shard 0] Connecting to wss://secret.example/?token=private', 'connecting_gateway');
  debug('[WS => Shard 0] Waiting for identify throttle', 'identifying');
  debug('[WS => Shard 0] Identifying\n\ttoken: private\n\tintents: 999', 'identifying');
  debug('[WS => Shard 0] Waiting for event ready for 15000ms', 'waiting_ready');
  assert(!/secret|private|wss:|999/.test(publicOutput(h)));
  h.diagnostics.stop();
});

test('token debug, arbitrary messages, names and identifiers never reach diagnostic output', () => {
  const h = harness(); h.diagnostics.start();
  for (const message of ['Provided token: VERY_PRIVATE_TOKEN', '[WS => Shard 0] Resuming session\n\ttoken: VERY_PRIVATE_TOKEN',
    '[WS => Shard 0] SECRET_OTHER_MARKER', 'x'.repeat(17000)]) h.client.emit('debug', message);
  const error = Object.assign(new Error('VERY_PRIVATE_TOKEN https://secret.example/path'), {
    name: 'PRIVATE_ERROR_NAME', code: 'PRIVATE_CODE', status: 'PRIVATE_STATUS',
    url: 'PRIVATE_URL', headers: { authorization: 'PRIVATE_AUTH' }, cause: { message: 'PRIVATE_CAUSE', code: 'PRIVATE_CAUSE_CODE' },
  });
  h.client.emit('shardError', error, 'PRIVATE_SHARD_ID');
  h.client.emit('shardDisconnect', { code: 'PRIVATE_CLOSE_CODE', reason: 'PRIVATE_REASON' }, 'PRIVATE_SHARD_ID');
  assert(!/PRIVATE|secret\.example|17000/.test(publicOutput(h)));
  assert(h.logs.every(entry => entry.length === 2 && typeof entry[1] === 'string'));
  assert.equal(h.diagnostics.snapshot().phase, 'reconnecting');
  h.diagnostics.stop();
});

test('only fixed token, intent, HTTP and handshake errors produce targeted hints', () => {
  const cases = [
    [{ message: 'Used disallowed intents' }, 'DISALLOWED_INTENTS', /Message Content Intent/],
    [{ message: 'An invalid token was provided.' }, 'INVALID_TOKEN', /DISCORD_TOKEN/],
    [{ message: 'Unexpected server response: 403' }, 403, /アクセス制限/],
    [{ message: 'Unexpected server response: 429' }, 429, /再デプロイ/],
    [{ message: 'Opening handshake has timed out' }, 'HANDSHAKE_TIMEOUT', /通信/],
    [{ message: 'WebSocket was closed before the connection was established' }, 'CONNECTION_CLOSED', /通信/],
    [{ cause: { cause: { code: 'EAI_AGAIN', message: 'PRIVATE_DNS' } } }, 'EAI_AGAIN', /通信/],
  ];
  for (const [error, code, expected] of cases) {
    const h = harness(); h.diagnostics.start(); h.diagnostics.fail(error);
    assert.equal(h.diagnostics.snapshot().lastCode, code);
    assert.equal(h.diagnostics.snapshot().phase, 'failed');
    assert.match(publicOutput(h), expected);
    const count = h.logs.length; h.advance(30000); h.tick(); assert.equal(h.logs.length, count);
    assert(!publicOutput(h).includes('PRIVATE_DNS'));
    h.diagnostics.stop();
  }
});

test('hostile error accessors and cyclic causes are ignored without execution or leaks', () => {
  const h = harness(); h.diagnostics.start();
  const cyclic = { message: 'PRIVATE_ERROR' }; cyclic.cause = cyclic;
  h.client.emit('shardError', cyclic);
  const hostile = Object.defineProperties({}, Object.fromEntries(['code', 'message', 'status', 'name', 'cause']
    .map(key => [key, { get() { throw new Error('PRIVATE_GETTER'); } }])));
  assert.doesNotThrow(() => h.diagnostics.fail(hostile));
  assert(!publicOutput(h).includes('PRIVATE'));
  h.diagnostics.stop();
});

test('REST 429 debug reports numeric retry only, including BurstHandler lacking rateLimited', () => {
  const h = harness(); h.diagnostics.start();
  h.client.rest.emit('restDebug', '[REST PRIVATE_BUCKET/PRIVATE_TOKEN] Encountered unexpected 429 rate limit\n  URL: https://PRIVATE_URL\n  Retry After    : 125000ms\n  Hash: PRIVATE_HASH');
  assert.deepEqual(h.diagnostics.snapshot(), { phase: 'rate_limited', waitingSeconds: 0, retryAfterSeconds: 125, lastCode: 429 });
  h.advance(26000);
  assert.equal(h.diagnostics.snapshot().retryAfterSeconds, 99);
  h.advance(100000);
  assert.equal(h.diagnostics.snapshot().retryAfterSeconds, 0);
  assert.equal(h.diagnostics.snapshot().phase, 'requesting_gateway');
  assert(!publicOutput(h).includes('PRIVATE'));
  h.client.rest.emit('restDebug', '[REST x] unrelated PRIVATE_TOKEN\nRetry After : 1234ms');
  assert.equal(h.diagnostics.snapshot().retryAfterSeconds, 0);
  h.diagnostics.stop();
});

test('rate limit events honor numeric SDK waits and bound hostile values without exposing payloads', () => {
  const h = harness(); h.diagnostics.start();
  h.client.rest.emit('rateLimited', { retryAfter: 120000, timeToReset: 130000, sublimitTimeout: 140000,
    route: 'PRIVATE_ROUTE', url: 'PRIVATE_URL', hash: 'PRIVATE_HASH', headers: 'PRIVATE_HEADERS', majorParameter: 'PRIVATE_ID' });
  assert.equal(h.diagnostics.snapshot().retryAfterSeconds, 140);
  assert.equal(h.diagnostics.snapshot().lastCode, 'RATE_LIMITED');
  assert(!publicOutput(h).includes('HTTP 429'));
  h.client.rest.emit('rateLimited', { retryAfter: Number.POSITIVE_INFINITY, timeToReset: NaN, sublimitTimeout: 'PRIVATE' });
  assert.equal(h.diagnostics.snapshot().retryAfterSeconds, 140);
  h.client.rest.emit('rateLimited', { retryAfter: 1e20 });
  assert.equal(h.diagnostics.snapshot().retryAfterSeconds, 31 * 86400);
  h.advance(1e20); h.tick();
  assert.equal(h.diagnostics.snapshot().waitingSeconds, 31 * 86400);
  assert(!publicOutput(h).includes('PRIVATE'));
  h.diagnostics.stop();
});

test('ready, failed and reconnect lifecycle restores diagnostics without false single-shard readiness', () => {
  const h = harness(); h.diagnostics.start();
  h.client.emit('shardReady', 0);
  assert.equal(h.diagnostics.snapshot().phase, 'waiting_ready');
  h.client.emit('shardResume', 0, 10);
  assert.equal(h.diagnostics.snapshot().phase, 'waiting_ready');
  h.diagnostics.fail({ code: 'ECONNRESET' });
  h.client.ready = true; h.client.emit('clientReady', { token: 'PRIVATE_READY' });
  assert.deepEqual(h.diagnostics.snapshot(), { phase: 'ready', waitingSeconds: 0, retryAfterSeconds: 0 });
  const count = h.logs.length; h.advance(30000); h.tick(); assert.equal(h.logs.length, count);
  h.client.rest.emit('rateLimited', { retryAfter: 1000, route: 'PRIVATE_ROUTE' });
  assert.equal(h.diagnostics.snapshot().phase, 'ready');
  h.client.ready = false; h.client.emit('shardReconnecting', 'PRIVATE_SHARD');
  h.advance(30000); h.tick();
  assert.equal(h.diagnostics.snapshot().phase, 'reconnecting');
  assert.equal(h.diagnostics.snapshot().waitingSeconds, 30);
  h.client.ready = true; h.client.emit('shardResume', 0, 2);
  assert.deepEqual(h.diagnostics.snapshot(), { phase: 'ready', waitingSeconds: 0, retryAfterSeconds: 0 });
  assert(!publicOutput(h).includes('PRIVATE'));
  h.diagnostics.stop();
});

test('known close codes and debug-only network failures have safe fixed explanations', () => {
  const h = harness(); h.diagnostics.start();
  h.client.emit('debug', '[WS => Shard 0] Failed to connect to the gateway URL specified due to a network error');
  assert.equal(h.diagnostics.snapshot().lastCode, 'NETWORK_ERROR');
  h.client.emit('debug', '[WS => Shard 0] A network error occurred\nError: Unexpected server response: 403\nPRIVATE_URL');
  assert.equal(h.diagnostics.snapshot().lastCode, 403);
  h.client.emit('shardDisconnect', { code: 4014, reason: 'PRIVATE_TOKEN' });
  assert.equal(h.diagnostics.snapshot().phase, 'failed');
  assert.match(publicOutput(h), /Message Content Intent/);
  assert(!publicOutput(h).includes('PRIVATE'));
  h.diagnostics.stop();
});

test('stop detaches immediately and restart does not duplicate listeners or intervals', () => {
  const h = harness();
  assert.equal(h.client.listenerCount('debug'), 1);
  h.diagnostics.start(); h.diagnostics.stop();
  const count = h.logs.length;
  h.client.emit('debug', '[WS => Manager] Fetched Gateway Information');
  h.client.rest.emit('rateLimited', { retryAfter: 999 }); h.diagnostics.fail(new Error('PRIVATE')); h.tick();
  assert.equal(h.logs.length, count);
  assert.deepEqual(h.diagnostics.snapshot(), { phase: 'idle', waitingSeconds: 0, retryAfterSeconds: 0 });
  h.diagnostics.start(); h.diagnostics.start();
  assert.equal(h.client.listenerCount('debug'), 1); assert.equal(h.ticks.size, 1);
  h.client.emit('invalidated'); assert.equal(h.diagnostics.snapshot().phase, 'failed');
  h.diagnostics.stop();
});

test('installed REST BurstHandler 429 debug is diagnosed using mocked requests only', async () => {
  const h = harness(); h.diagnostics.stop();
  let requests = 0;
  const rest = new REST({ offset: 0, retries: 0, async makeRequest() {
    requests++;
    return requests === 1 ? new Response('{}', { status: 429, headers: { 'retry-after': '0.001', 'content-type': 'application/json' } })
      : new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  h.client.rest = rest;
  const diagnostics = createConnectionDiagnostics({ ...h.options, client: h.client });
  let rateEvents = 0; rest.on('rateLimited', () => { rateEvents++; });
  diagnostics.start();
  try {
    const result = await rest.post('/interactions/123456789012345678/PRIVATE_INTERACTION_TOKEN/callback', { auth: false, body: { type: 4, data: { content: 'test' } } });
    assert.deepEqual(result, { ok: true });
    assert.equal(requests, 2);
    assert.equal(rateEvents, 0);
    assert(h.logs.some(entry => entry[1].includes('HTTP 429')));
    assert(!JSON.stringify(h.logs).includes('PRIVATE_INTERACTION_TOKEN'));
  } finally { diagnostics.stop(); rest.clearHashSweeper(); rest.clearHandlerSweeper(); }
});
