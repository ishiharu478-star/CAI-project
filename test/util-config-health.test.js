import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Client, GatewayIntentBits, Options } from 'discord.js';
import { loadConfig } from '../src/config.js';
import { dayKey, explicitMention, stripBotMention, memoryQuery, splitMessage, safeError, errorText } from '../src/util.js';
import { createHealthServer } from '../src/health.js';
import { createConnectionDiagnostics } from '../src/diagnostics.js';

const env = { DISCORD_TOKEN: 'secret-token', GEMINI_API_KEY: 'secret-key', DATABASE_URL: 'postgresql://user:secret-password@example.com/test?sslmode=require', OWNER_USER_ID: '123456789012345678', ADMIN_GUILD_ID: '987654321098765432' };

test('only the five required variables produce bounded conservative defaults', () => {
  const config = loadConfig(env);
  assert.equal(config.dailyRequestLimit, 20);
  assert.equal(config.stopPercent, 90);
  assert.equal(config.model, 'gemini-3.5-flash-lite');
  assert.equal(config.port, 10000);
  assert.deepEqual(config.allowedGuildIds, []);
  assert.equal(config.maxConcurrent, 2);
  assert(Object.isFrozen(config));
});

test('invalid configuration errors contain names but never credentials', () => {
  for (const patch of [{ OWNER_USER_ID: 'secret-id' }, { DATABASE_URL: 'secret-password' }, { GUARD_WARN_PERCENT: '99' }, { GEMINI_DAILY_REQUEST_LIMIT: '0' }, { PORT: 'NaN' }]) {
    assert.throws(() => loadConfig({ ...env, ...patch }), error => {
      assert(!/secret-token|secret-key|secret-password|secret-id/.test(error.message));
      return true;
    });
  }
  assert.throws(() => loadConfig({}), /DISCORD_TOKEN/);
});

test('JST user midnight is independent of Gemini Pacific midnight including DST', () => {
  const date = new Date('2026-10-17T15:00:00Z');
  assert.equal(dayKey('Asia/Tokyo', date), '2026-10-18');
  assert.equal(dayKey('America/Los_Angeles', date), '2026-10-17');
  assert.equal(dayKey('America/Los_Angeles', new Date('2026-11-02T07:59:59Z')), '2026-11-01');
  assert.equal(dayKey('America/Los_Angeles', new Date('2026-11-02T08:00:00Z')), '2026-11-02');
});

test('explicit mentions are exact; past retrieval needs an explicit history request', () => {
  assert(explicitMention('<@!123> 質問', '123'));
  assert(!explicitMention('<@1234> 質問', '123'));
  assert.equal(stripBotMention('<@123> <@!123> こんにちは', '123'), 'こんにちは');
  assert.equal(memoryQuery('元気？'), null);
  assert.equal(memoryQuery('過去ログ: 旅行'), '旅行');
});

test('Discord messages stay bounded without splitting UTF-16 surrogate pairs', () => {
  const value = 'x'.repeat(1899) + '👍'.repeat(2000);
  const chunks = splitMessage(value);
  assert.equal(chunks.join(''), value);
  assert(chunks.every(chunk => chunk.length <= 1900 && !/[\uD800-\uDBFF]$/.test(chunk) && !/^[\uDC00-\uDFFF]/.test(chunk)));
});

test('error reporting removes upstream messages, URLs and credentials', () => {
  const error = Object.assign(new Error(env.DISCORD_TOKEN), { status: 429, code: 'key=secret-key' });
  assert.deepEqual(safeError(error), { type: 'Error', status: 429 });
  assert(!errorText(error).includes('secret'));
  assert.match(errorText({ code: 'GEMINI_EMPTY' }), /言葉/);
});

test('/health reports liveness and Discord state without upstream requests', () => {
  let stopping = false;
  const server = createHealthServer({ client: { isReady: () => false }, isStopping: () => stopping });
  function request(url, method = 'GET') {
    const response = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
    server.emit('request', { url, method }, response);
    return response;
  }
  assert.equal(request('/health').status, 200);
  assert.deepEqual(JSON.parse(request('/health').body), { ok: true, version: 'cai v1.2', discord: 'connecting' });
  assert.equal(request('/health', 'HEAD').body, undefined);
  assert.equal(request('/unknown').status, 404);
  stopping = true;
  assert.equal(request('/health').status, 503);
});

test('/health can expose safe connection diagnostics while preserving liveness during retries', () => {
  let ready = false;
  const state = { phase: 'rate_limited', waitingSeconds: 65, retryAfterSeconds: 120, lastCode: 'HTTP_429' };
  const server = createHealthServer({ client: { isReady: () => ready }, connectionState: () => ({ ...state }) });
  const read = () => {
    const response = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
    server.emit('request', { url: '/health', method: 'GET' }, response);
    return response;
  };
  assert.equal(read().status, 200);
  assert.equal(read().body.discord, 'connecting');
  assert.deepEqual(read().body.connection, state);
  ready = true;
  state.phase = 'ready'; state.waitingSeconds = 0; state.retryAfterSeconds = 0;
  delete state.lastCode;
  assert.equal(read().body.discord, 'ready');
  assert.equal(read().body.version, 'cai v1.2');
});

test('/health stays live and separates ready Gateway from actual REST429 waiting', () => {
  let clock = 0;
  const client = new EventEmitter();
  client.rest = new EventEmitter();
  client.isReady = () => true;
  const diagnostics = createConnectionDiagnostics({ client, now: () => clock,
    logger: { log() {}, warn() {}, error() {} },
    setIntervalImpl: () => ({ unref() {} }), clearIntervalImpl() {} });
  diagnostics.start();
  client.rest.emit('restDebug', '[REST PRIVATE_BUCKET/PRIVATE_ID] Encountered unexpected 429 rate limit\n'
    + '  Method : POST\n  Bucket : /channels/:id/typing\n  Retry After : 45000ms\n'
    + '  URL : https://discord.com/api/v10/channels/123456789012345678/typing?token=PRIVATE_TOKEN');
  const server = createHealthServer({ client, connectionState: () => diagnostics.snapshot() });
  const read = () => {
    const response = { writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
    server.emit('request', { url: '/health', method: 'GET' }, response);
    return response;
  };
  try {
    const response = read();
    const body = JSON.parse(response.body);
    assert.equal(response.status, 200);
    assert.equal(body.version, 'cai v1.2');
    assert.equal(body.discord, 'ready');
    assert.equal(body.connection.phase, 'ready');
    assert.equal(body.connection.rest.limited, true);
    assert.equal(body.connection.rest.retryAfterSeconds, 45);
    assert.equal(body.connection.rest.operation, 'typing');
    assert.equal(body.connection.rest.lastCode, 429);
    assert(!/PRIVATE|123456789012345678|https:|token=/.test(response.body));
    clock = 46000;
    assert.equal(JSON.parse(read().body).connection.rest.limited, false);
  } finally { diagnostics.stop(); }
});

test('installed discord.js accepts intended minimal client settings', () => {
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    makeCache: Options.cacheWithLimits({ MessageManager: 0 }), allowedMentions: { parse: [], repliedUser: false } });
  assert.equal(client.isReady(), false);
  client.destroy();
});
