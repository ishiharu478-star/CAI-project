import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { Store } from '../src/store.js';

class RecordingPool {
  constructor(responder = () => ({ rows: [] })) {
    this.calls = [];
    this.responder = responder;
    this.released = false;
  }
  async query(sql, values = []) {
    this.calls.push({ sql, values });
    return this.responder(sql, values);
  }
  async connect() {
    this.released = false;
    return { query: this.query.bind(this), release: () => { this.released = true; } };
  }
  async end() {}
}

// A deliberately small transaction test double; live SQL/races are covered by
// the optional dedicated-PostgreSQL integration test below.
class BudgetPool extends RecordingPool {
  constructor({ daily = 0, minute = 0 } = {}) {
    super();
    this.daily = daily;
    this.minute = minute;
    this.responder = (sql) => {
      if (sql === 'BEGIN') this.snapshot = { daily: this.daily, minute: this.minute };
      if (sql === 'ROLLBACK') Object.assign(this, this.snapshot);
      if (sql.startsWith('SELECT attempts FROM cai_generation_usage')) return { rows: [{ attempts: String(this.daily) }] };
      if (sql.startsWith('SELECT attempts FROM cai_generation_minute_usage')) return { rows: [{ attempts: this.minute }] };
      if (sql.startsWith('UPDATE cai_generation_usage')) this.daily++;
      if (sql.startsWith('UPDATE cai_generation_minute_usage')) this.minute++;
      return { rows: [] };
    };
  }
}

const budget = {
  dayKey: '2026-10-17', minuteKey: '2026-10-17T00:00',
  dailyLimit: 100, rpmLimit: 10, warnPercent: 80, stopPercent: 90,
};

test('settings reject unknown keys and invalid values without database writes', async () => {
  const pool = new RecordingPool();
  const store = new Store(undefined, { pool });
  for (const patch of [
    { DISCORD_TOKEN: 'never store secrets here' },
    { dailyRequestLimit: 0 }, { dailyRequestLimit: 1.5 },
    { maintenance: 'false' }, { maintenanceMessage: '' },
    { warnPercent: 100 }, { stopPercent: 101 },
  ]) {
    await assert.rejects(store.setSettings(patch), { code: 'INVALID_ARGUMENT' });
  }
  assert.equal(pool.calls.length, 0);
});

test('settings validate warning/stop relationship against persisted settings', async () => {
  const pool = new RecordingPool((sql) => ({ rows: sql.startsWith('SELECT settings') ? [{ settings: { warnPercent: 80, stopPercent: 90 } }] : [] }));
  const store = new Store(undefined, { pool });
  await assert.rejects(store.setSettings({ stopPercent: 70 }), { code: 'INVALID_ARGUMENT' });
  assert.equal(pool.calls.at(-1).sql, 'ROLLBACK');
  assert.equal(pool.released, true);
  assert.equal(pool.calls.some(({ sql }) => sql.startsWith('INSERT')), false);
});

test('Gemini callback runs after reservation commit and connection release', async () => {
  const pool = new BudgetPool({ daily: 79 });
  const store = new Store(undefined, { pool });
  const result = await store.withGenerationBudget(budget, async () => {
    assert.equal(pool.calls.at(-1).sql, 'COMMIT');
    assert.equal(pool.released, true);
    assert.equal(pool.daily, 80);
    return 'answer';
  });
  assert.deepEqual(result, { value: 'answer', warning: true, used: 80, limit: 100 });
});

test('failed Gemini attempts stay charged to the aggregate guard', async () => {
  const pool = new BudgetPool();
  const store = new Store(undefined, { pool });
  const failure = new Error('upstream unavailable');
  await assert.rejects(store.withGenerationBudget(budget, async () => { throw failure; }), (cause) => cause === failure);
  assert.equal(pool.daily, 1);
  assert.equal(pool.minute, 1);
  assert.equal(pool.calls.some(({ sql }) => sql === 'ROLLBACK'), false);
});

test('daily safety stop prevents the request before Gemini is called', async () => {
  const pool = new BudgetPool({ daily: 90 });
  const store = new Store(undefined, { pool });
  let called = false;
  await assert.rejects(store.withGenerationBudget(budget, async () => { called = true; }), { code: 'QUOTA_GUARD', used: 90, limit: 100 });
  assert.equal(called, false);
  assert.equal(pool.daily, 90);
  assert.equal(pool.minute, 0);
});

test('minute limit uses the full configured RPM and blocks the next attempt', async () => {
  const pool = new BudgetPool({ minute: 9 });
  const store = new Store(undefined, { pool });
  await store.withGenerationBudget(budget, async () => 'allowed');
  await assert.rejects(store.withGenerationBudget(budget, async () => assert.fail('must not generate')), { code: 'RATE_GUARD' });
  assert.equal(pool.daily, 1);
  assert.equal(pool.minute, 10);
});

test('small daily budgets still permit one attempt and invalid budgets never call Gemini', async () => {
  const pool = new BudgetPool();
  const store = new Store(undefined, { pool });
  await store.withGenerationBudget({ ...budget, dailyLimit: 1 }, async () => 'one');
  await assert.rejects(store.withGenerationBudget({ ...budget, dailyLimit: 1 }, async () => assert.fail()), { code: 'QUOTA_GUARD' });
  await assert.rejects(store.withGenerationBudget({ ...budget, rpmLimit: 0 }, async () => assert.fail()), { code: 'INVALID_ARGUMENT' });
});

test('default history and search always require the requesting user and channel', async () => {
  const pool = new RecordingPool();
  const store = new Store(undefined, { pool });
  await assert.rejects(store.recent({ guildId: 'g', channelId: 'c' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(store.search({ guildId: 'g', channelId: 'c', query: 'hello' }), { code: 'INVALID_ARGUMENT' });
  assert.equal(pool.calls.length, 0);
  await store.recent({ guildId: 'g', channelId: 'c', userId: 'u' });
  assert.match(pool.calls[0].sql, /guild_id = \$1 AND channel_id = \$2 AND user_id = \$3/);
  assert.deepEqual(pool.calls[0].values, ['g', 'c', 'u', 8]);
});

test('search treats wildcard characters and SQL-looking text as literal text', async () => {
  const pool = new RecordingPool();
  const store = new Store(undefined, { pool });
  await store.search({ guildId: 'g', channelId: 'c', userId: 'u', query: "100%_! ' OR true --" });
  const call = pool.calls[0];
  assert.equal(call.values[3], "%100!%!_!! ' OR true --%");
  assert.match(call.sql, /guild_id = \$1 AND channel_id = \$2 AND user_id = \$3/);
  assert.equal(call.sql.includes('OR true'), false);
  assert.match(call.sql, /ILIKE \$4 ESCAPE '!'/);
});

test('reply-thread history is scoped to the same guild and channel', async () => {
  const pool = new RecordingPool();
  const store = new Store(undefined, { pool });
  await store.recent({ guildId: 'g', channelId: 'c', threadKey: 'visible-reply' });
  assert.match(pool.calls[0].sql, /guild_id = \$1 AND channel_id = \$2 AND thread_key = \$3/);
  assert.deepEqual(pool.calls[0].values, ['g', 'c', 'visible-reply', 8]);
  await store.findExchange({ guildId: 'g', channelId: 'c', botMessageId: 'bot-message' });
  assert.match(pool.calls[1].sql, /guild_id = \$1 AND channel_id = \$2 AND bot_message_ids/);
});

test('SQL integration: concurrent quotas, budget guards, and conversation isolation', {
  skip: !process.env.TEST_DATABASE_URL,
  timeout: 60000,
}, async () => {
  // Use a dedicated test database. A random schema prevents touching cai data.
  const schema = `cai_test_${process.pid}_${Date.now()}`;
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
  let store;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
      max: 10,
    });
    store = new Store(undefined, { pool });
    await store.init();
    const reservations = await Promise.all(Array.from({ length: 50 }, () => store.reserveQuestion('u', 'jst-day', 30)));
    assert.equal(reservations.filter(Boolean).length, 30);
    assert.equal(await store.getQuota('u', 'jst-day'), 30);
    await store.refundQuestion('u', 'jst-day');
    assert.equal(await store.reserveQuestion('u', 'jst-day', 30), true);
    assert.equal(await store.reserveQuestion('u', 'next-jst-day', 30), true);

    let generations = 0;
    const attempts = await Promise.allSettled(Array.from({ length: 15 }, () => store.withGenerationBudget(
      { ...budget, dailyLimit: 10, rpmLimit: 100 }, async () => { generations++; },
    )));
    assert.equal(generations, 9);
    assert.equal(attempts.filter((r) => r.status === 'rejected' && r.reason.code === 'QUOTA_GUARD').length, 6);
    assert.equal((await store.status(budget.dayKey)).generationAttempts, 9);

    const save = (overrides = {}) => store.saveExchange({
      guildId: 'g', channelId: 'c', userId: 'u', userMessageId: 'm1',
      botMessageIds: ['b1'], prompt: '100% literal', response: 'answer', threadKey: 't',
      ...overrides,
    });
    await save();
    await save({ userId: 'other', userMessageId: 'm2', botMessageIds: ['b2'] });
    await save({ guildId: 'other-guild', userMessageId: 'm3', botMessageIds: ['b3'] });
    await save({ channelId: 'other-channel', userMessageId: 'm4', botMessageIds: ['b4'] });
    await save({ userMessageId: 'm5', botMessageIds: ['b5'], prompt: '1000 wildcard must not match' });
    const results = await store.search({ guildId: 'g', channelId: 'c', userId: 'u', query: '100%' });
    assert.deepEqual(results.map((r) => r.userMessageId), ['m1']);
    assert.equal((await store.recent({ guildId: 'g', channelId: 'c', userId: 'u' })).length, 2);
    assert.equal((await store.recent({ guildId: 'g', channelId: 'c', threadKey: 't' })).length, 3);
    assert.equal(await store.findExchange({ guildId: 'g', channelId: 'other-channel', botMessageId: 'b1' }), null);

    await store.queueFile('files/temporary');
    assert.deepEqual(await store.pendingFiles(), ['files/temporary']);
    await store.removeFile('files/temporary');
    assert.deepEqual(await store.pendingFiles(), []);
  } finally {
    await store?.close();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});
