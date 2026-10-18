import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageDiagnostics } from '../src/message-diagnostics.js';

function harness(overrides = {}) {
  let time = 1000;
  const timers = new Set();
  const logs = [];
  let unrefs = 0;
  const options = {
    logger: Object.fromEntries(['log', 'warn'].map(level => [level, (...args) => logs.push([level, ...args])])),
    now: () => time,
    setTimeoutImpl(callback, delay) {
      assert.equal(delay, 15000);
      const timer = { callback, unref() { unrefs++; } };
      timers.add(timer);
      return timer;
    },
    clearTimeoutImpl(timer) { timers.delete(timer); },
    ...overrides,
  };
  return { diagnostics: createMessageDiagnostics(options), logs, timers,
    get unrefs() { return unrefs; },
    advance(ms) { time += ms; },
    tick() { for (const timer of [...timers]) { timers.delete(timer); timer.callback(); } },
  };
}
function output(h) { return JSON.stringify(h.logs); }
function blocked() {
  let resolve;
  const promise = new Promise(settle => { resolve = settle; });
  return { promise, resolve };
}

test('pending typing warns once at the wait marker and keeps awaiting the same operation', async () => {
  const h = harness();
  const trace = h.diagnostics.begin();
  const operation = blocked();
  let completed = false;
  let calls = 0;
  const result = trace.run('typing', () => { calls++; return operation.promise; }).then(value => {
    completed = true;
    return value;
  });
  assert.equal(h.timers.size, 1);
  assert.equal(h.unrefs, 1);
  h.advance(15000); h.tick();
  await Promise.resolve();
  assert.equal(completed, false);
  assert.equal(calls, 1);
  assert.match(output(h), /stage=typing waiting elapsedSeconds=15/);
  assert.doesNotMatch(output(h), /completed|handler_finished/);
  h.advance(15000); h.tick();
  assert.equal(h.logs.filter(entry => entry[1].includes(' waiting ')).length, 1);
  const privateResult = { content: 'PRIVATE_RESULT', id: 'PRIVATE_DISCORD_ID' };
  operation.resolve(privateResult);
  assert.equal(await result, privateResult);
  assert.equal(completed, true);
  assert.equal(h.timers.size, 0);
  trace.finish();
  assert.match(output(h), /stage=typing completed/);
  assert.match(output(h), /handler_finished/);
  assert.doesNotMatch(output(h), /PRIVATE|success|delivered/);
});

test('rejection preserves exact object without reading error properties or exposing arguments', async () => {
  const h = harness();
  const trace = h.diagnostics.begin('PRIVATE_DISCORD_ID');
  let getters = 0;
  const error = Object.defineProperties({ secret: 'PRIVATE_TOKEN', content: 'PRIVATE_CONTENT' },
    Object.fromEntries(['name', 'message', 'stack', 'code', 'toJSON', 'toString'].map(key => [key, {
      get() { getters++; throw new Error('PRIVATE_GETTER'); },
    }])));
  let caught;
  try { await trace.run('gemini', () => Promise.reject(error)); } catch (received) { caught = received; }
  assert.equal(caught, error);
  assert.equal(getters, 0);
  assert.equal(h.timers.size, 0);
  trace.finish();
  assert.match(output(h), /stage=gemini failed/);
  assert.doesNotMatch(output(h), /PRIVATE/);
  assert(h.logs.every(entry => entry.length === 2 && typeof entry[1] === 'string'));
});

test('unknown stages are fixed enum values and never coerce caller objects', async () => {
  const h = harness();
  const trace = h.diagnostics.begin();
  let coercions = 0;
  const hostile = new Proxy({}, { get() { coercions++; throw new Error('PRIVATE_GETTER'); } });
  for (const stage of ['PRIVATE_CONTENT', hostile, Symbol('PRIVATE_SYMBOL'), 123456789012345678n]) {
    assert.equal(await trace.run(stage, () => 42), 42);
  }
  trace.finish();
  assert.equal(coercions, 0);
  assert.equal(h.logs.filter(entry => entry[1].includes('stage=unknown started')).length, 4);
  assert.doesNotMatch(output(h), /PRIVATE|123456789012345678/);
});

test('synthetic process-local tags identify concurrent traces without caller IDs', async () => {
  const h = harness();
  const first = h.diagnostics.begin({ id: '123456789012345678', content: 'PRIVATE_A' });
  const second = h.diagnostics.begin('987654321098765432');
  await first.run('reply', () => undefined);
  await second.run('followup', () => undefined);
  first.finish(); second.finish();
  const received = h.logs.filter(entry => entry[1].endsWith(' received'));
  const tags = received.map(entry => /^\[cai Message\] (m\d{1,9}) received$/.exec(entry[1])?.[1]);
  assert(tags.every(Boolean));
  assert.notEqual(tags[0], tags[1]);
  assert(h.logs.some(entry => entry[1].includes(`${tags[0]} stage=reply completed`)));
  assert(h.logs.some(entry => entry[1].includes(`${tags[1]} stage=followup completed`)));
  assert.doesNotMatch(output(h), /PRIVATE|123456789012345678|987654321098765432/);
});

test('finish cleans all pending timers once without cancelling pending operations', async () => {
  const h = harness();
  const trace = h.diagnostics.begin();
  const a = blocked(); const b = blocked();
  const resultA = trace.run('history', () => a.promise);
  const resultB = trace.run('settings', () => b.promise);
  const timerCallbacks = [...h.timers].map(timer => timer.callback);
  assert.equal(h.timers.size, 2);
  trace.finish(); trace.finish();
  assert.equal(h.timers.size, 0);
  for (const callback of timerCallbacks) callback();
  h.advance(30000); h.tick();
  assert.equal(h.logs.filter(entry => entry[1].endsWith('handler_finished')).length, 1);
  assert.doesNotMatch(output(h), / waiting |completed|delivered/);
  a.resolve('A'); b.resolve('B');
  assert.deepEqual(await Promise.all([resultA, resultB]), ['A', 'B']);
  assert.equal(await trace.run('save', () => 'after finish'), 'after finish');
  assert.equal(h.timers.size, 0);
});

test('throwing logger methods and getters do not change operation values or exceptions', async () => {
  for (const logger of [
    { log() { throw new Error('PRIVATE_LOGGER'); }, warn() { throw new Error('PRIVATE_LOGGER'); } },
    { async log() { throw new Error('PRIVATE_ASYNC_LOGGER'); }, async warn() { throw new Error('PRIVATE_ASYNC_LOGGER'); } },
    Object.defineProperties({}, { log: { get() { throw new Error('PRIVATE_GETTER'); } },
      warn: { get() { throw new Error('PRIVATE_GETTER'); } } }),
  ]) {
    const h = harness({ logger });
    const trace = h.diagnostics.begin();
    const operation = blocked();
    const pending = trace.run('typing', () => operation.promise);
    h.advance(15000); assert.doesNotThrow(() => h.tick());
    operation.resolve(42);
    assert.equal(await pending, 42);
    const error = new Error('PRIVATE_OPERATION');
    await assert.rejects(trace.run('reply', () => { throw error; }), received => received === error);
    assert.doesNotThrow(() => trace.finish());
    assert.equal(h.timers.size, 0);
  }
});

test('invalid or extreme clocks expose finite bounded elapsed seconds only', async () => {
  for (const getTime of [() => NaN, () => Infinity, () => 'PRIVATE_TIME',
    () => { throw new Error('PRIVATE_CLOCK'); }]) {
    const h = harness({ now: getTime });
    const trace = h.diagnostics.begin();
    const operation = blocked();
    const pending = trace.run('web', () => operation.promise);
    assert.doesNotThrow(() => h.tick());
    assert.match(output(h), /elapsedSeconds=0/);
    assert.doesNotMatch(output(h), /PRIVATE|NaN|Infinity/);
    operation.resolve(); await pending; trace.finish();
  }
  const h = harness(); const trace = h.diagnostics.begin(); const operation = blocked();
  const pending = trace.run('budget', () => operation.promise);
  h.advance(Number.MAX_VALUE); h.tick();
  assert.match(output(h), /elapsedSeconds=2678400/);
  operation.resolve(); await pending; trace.finish();
});

test('retained monitoring metadata is bounded while every operation still executes', async () => {
  const h = harness(); const trace = h.diagnostics.begin(); const operation = blocked();
  let calls = 0;
  const operations = Array.from({ length: 80 }, () => trace.run('accounting', () => {
    calls++;
    return operation.promise;
  }));
  assert.equal(calls, 80);
  assert.equal(h.timers.size, 32);
  trace.finish();
  assert.equal(h.timers.size, 0);
  operation.resolve(42);
  assert.deepEqual(await Promise.all(operations), Array(80).fill(42));
});

test('all supported stages are retained as fixed enum names', async () => {
  const h = harness(); const trace = h.diagnostics.begin();
  for (const stage of ['reference', 'settings', 'quota', 'typing', 'history', 'memory_search',
    'budget', 'web', 'gemini', 'reply', 'followup', 'save', 'accounting', 'refund']) {
    await trace.run(stage, () => undefined);
    assert(h.logs.some(entry => entry[1].endsWith(`stage=${stage} completed`)));
  }
  trace.finish();
  assert.equal(h.timers.size, 0);
});
