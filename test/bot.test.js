import assert from 'node:assert/strict';
import test from 'node:test';
import { createMessageHandler, sendReply } from '../src/bot.js';
import { createMessageDiagnostics } from '../src/message-diagnostics.js';

const BOT = '999999999999999999';
const USER = '111111111111111111';
const GUILD = '222222222222222222';
const CHANNEL = '333333333333333333';
const NOW = new Date('2026-10-17T06:00:00.000Z');

function setup(overrides = {}) {
  const calls = {};
  const record = (name, value) => { (calls[name] ??= []).push(value); };
  const method = (name, value) => async (...args) => { record(name, args); return typeof value === 'function' ? value(...args) : value; };
  const store = {
    getSettings: method('getSettings', { maintenance: false, dailyRequestLimit: 20, warnPercent: 80, stopPercent: 90 }),
    reserveQuestion: method('reserveQuestion', true),
    refundQuestion: method('refundQuestion', undefined),
    saveExchange: method('saveExchange', undefined),
    findExchange: method('findExchange', null),
    recent: method('recent', []),
    search: method('search', []),
    recordTokens: method('recordTokens', undefined),
    withGenerationBudget: method('withGenerationBudget', async (_options, callback) => ({ value: await callback(), warning: false })),
    ...overrides.store,
  };
  const gemini = { generate: method('generate', { text: '返事やで。', totalTokens: 12 }), ...overrides.gemini };
  const web = overrides.web ?? method('web', { text: 'External evidence', sources: [{ title: 'Source', url: 'https://example.com/' }] });
  const config = { allowedGuildIds: [], maxConcurrent: 2, rpmLimit: 5, ...overrides.config };
  const validate = overrides.validate ?? ((items) => record('validate', items));
  const handler = createMessageHandler({ store, gemini, web, config, validate,
    now: overrides.now ?? (() => NOW), diagnostics: overrides.diagnostics,
    logger: overrides.logger ?? { error: (...args) => record('error', args) } });
  let nextMessageId = 0;
  function message(options = {}) {
    const sent = [];
    const msg = {
      id: `message-${++nextMessageId}`, guildId: GUILD, channelId: CHANNEL,
      author: { id: USER, bot: false }, content: `<@${BOT}> こんにちは`,
      attachments: new Map(), reference: null, webhookId: null, system: false,
      reply: async (payload) => { sent.push(payload); return { id: `sent-${sent.length}` }; },
      channel: {
        send: async (payload) => { sent.push(payload); return { id: `sent-${sent.length}` }; },
        sendTyping: method('typing', undefined),
      },
      fetchReference: method('fetchReference', options.referenced ?? null),
      ...options,
    };
    delete msg.referenced;
    return { msg, sent };
  }
  return { handler, calls, store, gemini, message, record };
}

const count = (calls, method) => calls[method]?.length ?? 0;

test('ignores DM, other bots, webhooks, system messages and unaddressed chat', async () => {
  const context = setup();
  for (const patch of [
    { guildId: null }, { author: { id: USER, bot: true } },
    { webhookId: 'webhook' }, { system: true }, { content: 'ただの雑談' },
  ]) {
    const { msg, sent } = context.message(patch);
    await context.handler(msg, BOT);
    assert.equal(sent.length, 0);
  }
  assert.equal(count(context.calls, 'getSettings'), 0);
  assert.equal(count(context.calls, 'generate'), 0);
});

test('honors the optional guild allowlist before reading reply targets', async () => {
  const context = setup({ config: { allowedGuildIds: ['other-guild'] } });
  const { msg } = context.message({ reference: { messageId: 'target' } });
  await context.handler(msg, BOT);
  assert.equal(count(context.calls, 'fetchReference'), 0);
  assert.equal(count(context.calls, 'getSettings'), 0);
});

test('mention only responds with a local acknowledgement, no model or question charge', async () => {
  const context = setup();
  const { msg, sent } = context.message({ content: `<@!${BOT}>` });
  await context.handler(msg, BOT);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].content.length > 0);
  assert.equal(count(context.calls, 'generate'), 0);
  assert.equal(count(context.calls, 'reserveQuestion'), 0);
  assert.equal(count(context.calls, 'withGenerationBudget'), 0);
  assert.equal(count(context.calls, 'web'), 0);
  assert.equal(context.calls.saveExchange[0][0].prompt, '[呼びかけ]');
  assert.deepEqual(sent[0].allowedMentions, { parse: [], repliedUser: false });
});

test('reply to cai needs no mention and continues only the scoped saved thread', async () => {
  const turns = [{ prompt: '前の質問', response: '前の返事' }];
  const context = setup({ store: {
    findExchange: async () => ({ threadKey: 'thread-root' }), recent: async (scope) => {
      context.record('recentScope', scope); return turns;
    },
  } });
  const referenced = { id: 'old-cai', author: { id: BOT }, guildId: GUILD, channelId: CHANNEL, content: '前の返事' };
  const { msg } = context.message({ content: 'もっと詳しく', reference: { messageId: referenced.id }, referenced });
  await context.handler(msg, BOT);
  assert.deepEqual(context.calls.recentScope[0], { guildId: GUILD, channelId: CHANNEL, userId: USER, threadKey: 'thread-root', limit: 6 });
  assert.deepEqual(context.calls.generate[0][0].history, turns);
  assert.equal(context.calls.generate[0][0].quotedText, '');
  assert.equal(context.calls.saveExchange[0][0].threadKey, 'thread-root');
  assert.equal(count(context.calls, 'search'), 0);
});

test('mention plus third-party reply supplies the quote for this generation without persisting it', async () => {
  const context = setup();
  const quote = '第三者の発言SECRET-QUOTE';
  const referenced = { id: 'third-party', author: { id: 'other-user' }, guildId: GUILD, channelId: CHANNEL, content: quote, attachments: new Map() };
  const { msg } = context.message({ content: `<@${BOT}> この意見を説明して`, reference: { messageId: referenced.id }, referenced });
  await context.handler(msg, BOT);
  assert.match(context.calls.generate[0][0].quotedText, /SECRET-QUOTE/u);
  assert.equal(context.calls.generate[0][0].prompt, 'この意見を説明して');
  assert.equal(JSON.stringify(context.calls.saveExchange).includes(quote), false);
  assert.equal(count(context.calls, 'recent'), 0);
});

test('rejects reply context from another guild or channel', async () => {
  for (const patch of [{ guildId: 'different-guild' }, { channelId: 'different-channel' }]) {
    const context = setup();
    const referenced = { id: 'foreign', author: { id: BOT }, guildId: GUILD, channelId: CHANNEL, content: 'FOREIGN-SECRET', ...patch };
    const { msg } = context.message({ content: `<@${BOT}> 質問や`, reference: { messageId: referenced.id }, referenced });
    await context.handler(msg, BOT);
    assert.equal(count(context.calls, 'findExchange'), 0);
    assert.equal(count(context.calls, 'recent'), 0);
    assert.equal(JSON.stringify(context.calls.generate).includes('FOREIGN-SECRET'), false);
    const unmentioned = context.message({ content: '続き', reference: { messageId: referenced.id }, referenced });
    await context.handler(unmentioned.msg, BOT);
    assert.equal(unmentioned.sent.length, 0);
  }
});

test('attachment-only mention invokes the model and validates current attachments', async () => {
  const context = setup();
  const attachment = { id: 'image', name: 'picture.png', contentType: 'image/png', size: 10, url: 'https://cdn.discordapp.com/attachments/test.png' };
  const { msg } = context.message({ content: `<@${BOT}>`, attachments: new Map([['image', attachment]]) });
  await context.handler(msg, BOT);
  assert.equal(count(context.calls, 'generate'), 1);
  assert.equal(context.calls.generate[0][0].prompt, 'この添付について説明して。');
  assert.deepEqual(context.calls.generate[0][0].attachments, [attachment]);
  assert.deepEqual(context.calls.validate[0], [attachment]);
  assert.equal(count(context.calls, 'reserveQuestion'), 1);
});

test('daily limit refuses generation and reports Japan midnight reset', async () => {
  const context = setup({ store: { reserveQuestion: async (...args) => { context.record('deniedReserve', args); return false; } } });
  const { msg, sent } = context.message();
  await context.handler(msg, BOT);
  assert.deepEqual(context.calls.deniedReserve[0], [USER, '2026-10-17', 30]);
  assert.equal(count(context.calls, 'generate'), 0);
  assert.equal(count(context.calls, 'withGenerationBudget'), 0);
  assert.equal(count(context.calls, 'refundQuestion'), 0);
  assert.match(sent[0].content, /30回/u);
  assert.match(sent[0].content, /午前0時/u);
});

test('failed and empty generations refund the question; success retains it and records tokens', async () => {
  for (const generate of [async () => { throw Object.assign(new Error('failed'), { status: 503 }); }, async () => ({ text: '   ' })]) {
    const context = setup({ gemini: { generate } });
    const { msg, sent } = context.message();
    await context.handler(msg, BOT);
    assert.deepEqual(context.calls.refundQuestion[0], [USER, '2026-10-17']);
    assert.equal(count(context.calls, 'saveExchange'), 0);
    assert.equal(sent.length, 1);
  }
  const context = setup();
  await context.handler(context.message().msg, BOT);
  assert.equal(count(context.calls, 'refundQuestion'), 0);
  assert.equal(count(context.calls, 'saveExchange'), 1);
  assert.deepEqual(context.calls.recordTokens[0], ['2026-10-16', 12]);
});

test('standalone questions do not automatically load history; explicit past-log requests search a user/guild/channel scope', async () => {
  const context = setup();
  await context.handler(context.message().msg, BOT);
  assert.equal(count(context.calls, 'recent'), 0);
  assert.equal(count(context.calls, 'search'), 0);
  assert.equal(count(context.calls, 'web'), 0);
  const past = context.message({ content: `<@${BOT}> 過去ログ: ピザ` });
  await context.handler(past.msg, BOT);
  assert.deepEqual(context.calls.search[0][0], { guildId: GUILD, channelId: CHANNEL, userId: USER, query: 'ピザ', limit: 4 });
  assert.equal(count(context.calls, 'web'), 0);
});

test('only necessary Web work is planned, using free context and disabling provider tools', async () => {
  const context = setup();
  await context.handler(context.message({ content: `<@${BOT}> 今日の東京の天気を調べて` }).msg, BOT);
  assert.deepEqual(context.calls.web[0][0], { prompt: '今日の東京の天気を調べて', mode: 'search' });
  const generation = context.calls.generate[0][0];
  assert.equal(generation.webContext, 'External evidence');
  assert.deepEqual(generation.webSources, [{ title: 'Source', url: 'https://example.com/' }]);
  assert.equal(generation.webMode, 'none');
  assert.equal(Object.hasOwn(generation, 'tools'), false);
});

test('maintenance responds without invoking or charging a model request', async () => {
  const context = setup({ store: { getSettings: async () => ({ maintenance: true, maintenanceMessage: '工事中やで' }) } });
  const { msg, sent } = context.message();
  await context.handler(msg, BOT);
  assert.equal(sent[0].content, '工事中やで');
  assert.equal(count(context.calls, 'reserveQuestion'), 0);
  assert.equal(count(context.calls, 'generate'), 0);
});

test('duplicate deliveries are processed once', async () => {
  const context = setup();
  const { msg, sent } = context.message({ id: 'stable-message-id' });
  await context.handler(msg, BOT);
  await context.handler(msg, BOT);
  assert.equal(count(context.calls, 'reserveQuestion'), 1);
  assert.equal(count(context.calls, 'generate'), 1);
  assert.equal(sent.length, 1);
});

test('a busy user cannot start another generation and can ask again when the first completes', async () => {
  let complete;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const blocked = new Promise((resolve) => { complete = resolve; });
  let generations = 0;
  const context = setup({ gemini: { generate: async () => {
    generations += 1;
    if (generations === 1) { entered(); await blocked; }
    return { text: '完了' };
  } } });
  const first = context.handler(context.message().msg, BOT);
  await started;
  const second = context.message();
  await context.handler(second.msg, BOT);
  assert.match(second.sent[0].content, /答え終わるまで/u);
  assert.equal(generations, 1);
  complete(); await first;
  await context.handler(context.message().msg, BOT);
  assert.equal(generations, 2);
});

test('all answer chunks disable user and global pings', async () => {
  const context = setup();
  const { msg, sent } = context.message();
  const ids = await sendReply(msg, `@everyone <@${USER}> ${'あ'.repeat(4200)}`);
  assert.equal(ids.length, 3);
  assert.equal(sent.length, 3);
  for (const payload of sent) {
    assert.ok(payload.content.length <= 1900);
    assert.deepEqual(payload.allowedMentions, { parse: [], repliedUser: false });
  }
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function messageTracking() {
  let stamp = 1000;
  let nextTimer = 0;
  let finished = 0;
  const timers = new Map();
  const logs = [];
  const beginArguments = [];
  const stages = [];
  const logger = Object.fromEntries(['log', 'info', 'warn', 'error'].map(level => [level, (...args) => logs.push([level, ...args])]));
  const real = createMessageDiagnostics({ logger, now: () => stamp,
    setTimeoutImpl(callback, ms) {
      assert.equal(ms, 15000);
      const timer = { id: ++nextTimer, unref() {} }; timers.set(timer, callback); return timer;
    },
    clearTimeoutImpl(timer) { timers.delete(timer); },
  });
  const diagnostics = { begin(...args) {
    beginArguments.push(args);
    const trace = real.begin(...args);
    return { run(stage, task) { stages.push(stage); return trace.run(stage, task); },
      finish() { finished++; trace.finish(); } };
  } };
  return { diagnostics, logs, stages, timers, beginArguments, get finished() { return finished; },
    wait() { stamp += 15000; for (const [timer, callback] of [...timers]) { timers.delete(timer); callback(); } } };
}

test('message diagnostics leave blocked initial typing pending until the SDK operation resolves', async () => {
  const tracking = messageTracking();
  const context = setup({ diagnostics: tracking.diagnostics });
  const { msg, sent } = context.message({ content: `<@${BOT}> PRIVATE_PROMPT` });
  const entered = deferred(); const blocked = deferred();
  msg.channel.sendTyping = async () => { context.record('typing', []); entered.resolve(); await blocked.promise; };
  let completed = false;
  const pending = context.handler(msg, BOT).then(() => { completed = true; });
  await entered.promise;
  try {
    tracking.wait();
    assert.equal(completed, false);
    assert.equal(count(context.calls, 'reserveQuestion'), 1);
    assert.equal(count(context.calls, 'generate'), 0);
    assert.equal(count(context.calls, 'withGenerationBudget'), 0);
    assert.equal(sent.length, 0);
    assert.equal(tracking.finished, 0);
    assert(tracking.logs.some(([level, ...args]) => level === 'warn' && args.join(' ').includes('typing')));
    assert.equal(count(context.calls, 'typing'), 1);
  } finally { blocked.resolve(); await pending; }
  assert.equal(count(context.calls, 'generate'), 1);
  assert.equal(count(context.calls, 'reserveQuestion'), 1);
  assert.equal(count(context.calls, 'refundQuestion'), 0);
  assert.equal(sent.length, 1);
  assert.equal(tracking.finished, 1);
  assert.equal(tracking.timers.size, 0);
  assert(!new RegExp(`PRIVATE_PROMPT|${BOT}|${USER}|${GUILD}|${CHANNEL}|message-1`).test(JSON.stringify(tracking.logs)));
  assert.deepEqual(tracking.beginArguments, [[]]);
});

test('mention-only acknowledgement waits for its real reply without Gemini calls or early trace completion', async () => {
  const tracking = messageTracking();
  const context = setup({ diagnostics: tracking.diagnostics });
  const { msg, sent } = context.message({ content: `<@!${BOT}>` });
  const entered = deferred(); const blocked = deferred();
  const originalReply = msg.reply;
  msg.reply = async payload => { entered.resolve(); await blocked.promise; return originalReply(payload); };
  const pending = context.handler(msg, BOT);
  await entered.promise;
  try {
    tracking.wait();
    assert.equal(count(context.calls, 'generate'), 0);
    assert.equal(count(context.calls, 'reserveQuestion'), 0);
    assert.equal(count(context.calls, 'withGenerationBudget'), 0);
    assert.equal(count(context.calls, 'saveExchange'), 0);
    assert.equal(sent.length, 0);
    assert.equal(tracking.finished, 0);
    assert(tracking.logs.some(([level, ...args]) => level === 'warn' && args.join(' ').includes('reply')));
  } finally { blocked.resolve(); await pending; }
  assert.equal(sent.length, 1);
  assert.equal(count(context.calls, 'saveExchange'), 1);
  assert.equal(count(context.calls, 'generate'), 0);
  assert.equal(tracking.finished, 1);
  assert.equal(tracking.timers.size, 0);
  assert.deepEqual(tracking.stages, ['settings', 'reply', 'save']);
});

test('unrelated messages and other-user replies produce no message diagnostics', async () => {
  const tracking = messageTracking();
  const context = setup({ diagnostics: tracking.diagnostics });
  const target = { id: 'PRIVATE_OTHER_MESSAGE', author: { id: 'PRIVATE_OTHER_USER' }, guildId: GUILD, channelId: CHANNEL };
  for (const patch of [
    { guildId: null }, { author: { id: USER, bot: true } }, { webhookId: 'PRIVATE_WEBHOOK' },
    { system: true }, { content: 'PRIVATE_CHAT' },
    { content: 'PRIVATE_REPLY', reference: { messageId: target.id }, referenced: target },
  ]) await context.handler(context.message(patch).msg, BOT);
  const restricted = setup({ diagnostics: tracking.diagnostics, config: { allowedGuildIds: ['PRIVATE_OTHER_GUILD'] } });
  await restricted.handler(restricted.message().msg, BOT);
  assert.deepEqual(tracking.beginArguments, []);
  assert.deepEqual(tracking.logs, []);
  assert.equal(tracking.finished, 0);
  assert.equal(count(context.calls, 'getSettings'), 0);
  assert.equal(count(context.calls, 'fetchReference'), 1);
});

test('own mentions trace pending reference fetch but unmentioned cai replies begin after target recognition', async () => {
  const tracking = messageTracking();
  const context = setup({ diagnostics: tracking.diagnostics });
  const target = { id: 'PRIVATE_TARGET', author: { id: BOT }, guildId: GUILD, channelId: CHANNEL, content: 'PRIVATE_QUOTE' };
  const mentioned = context.message({ reference: { messageId: target.id }, referenced: target });
  const entered = deferred(); const blocked = deferred();
  mentioned.msg.fetchReference = async () => { entered.resolve(); await blocked.promise; return target; };
  const pending = context.handler(mentioned.msg, BOT);
  await entered.promise;
  try {
    tracking.wait();
    assert.deepEqual(tracking.stages, ['reference']);
    assert(tracking.logs.some(([level, ...args]) => level === 'warn' && args.join(' ').includes('reference')));
    assert.equal(count(context.calls, 'getSettings'), 0);
  } finally { blocked.resolve(); await pending; }
  const firstTraceStages = tracking.stages.length;
  const unmentioned = context.message({ content: 'PRIVATE_FOLLOWUP', reference: { messageId: target.id }, referenced: target });
  await context.handler(unmentioned.msg, BOT);
  assert.equal(tracking.stages[firstTraceStages], 'settings');
  assert.equal(tracking.finished, 2);
  assert.equal(tracking.timers.size, 0);
  assert(!/PRIVATE_/.test(JSON.stringify(tracking.logs)));
});

test('failed generation preserves reply and refund while recording terminal cleanup without error contents', async () => {
  const tracking = messageTracking();
  const context = setup({ diagnostics: tracking.diagnostics,
    gemini: { generate: async () => { throw Object.assign(new Error('PRIVATE_API_KEY https://private.example/'), { status: 503 }); } } });
  const { msg, sent } = context.message();
  await context.handler(msg, BOT);
  assert.equal(sent.length, 1);
  assert.equal(count(context.calls, 'reserveQuestion'), 1);
  assert.equal(count(context.calls, 'refundQuestion'), 1);
  assert.equal(count(context.calls, 'saveExchange'), 0);
  assert(tracking.stages.includes('gemini'));
  assert.deepEqual(tracking.stages.slice(-2), ['reply', 'refund']);
  assert.equal(tracking.finished, 1);
  assert.equal(tracking.timers.size, 0);
  assert(!/PRIVATE_|private\.example/.test(JSON.stringify(tracking.logs)));
});

test('duplicate, acknowledgement cooldown and maintenance early returns always finish their trace', async () => {
  const tracking = messageTracking();
  const context = setup({ diagnostics: tracking.diagnostics });
  const first = context.message({ content: `<@${BOT}>` });
  await context.handler(first.msg, BOT);
  await context.handler(first.msg, BOT);
  await context.handler(context.message({ content: `<@${BOT}>` }).msg, BOT);
  assert.equal(tracking.finished, 3);
  const maintenance = setup({ diagnostics: tracking.diagnostics,
    store: { getSettings: async () => ({ maintenance: true, maintenanceMessage: '休憩中' }) } });
  await maintenance.handler(maintenance.message().msg, BOT);
  assert.equal(tracking.finished, 4);
  assert.equal(tracking.timers.size, 0);
  assert.equal(count(context.calls, 'generate'), 0);
});

test('sendReply traces real first and later chunks without changing payloads', async () => {
  const tracking = messageTracking();
  const context = setup(); const { msg, sent } = context.message();
  const trace = tracking.diagnostics.begin();
  try {
    const ids = await sendReply(msg, 'あ'.repeat(4200), trace);
    assert.equal(ids.length, 3);
    assert.equal(sent.length, 3);
    assert.deepEqual(tracking.stages, ['reply', 'followup', 'followup']);
    for (const payload of sent) assert.deepEqual(payload.allowedMentions, { parse: [], repliedUser: false });
  } finally { trace.finish(); }
  assert.equal(tracking.timers.size, 0);
});
