import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageFlags } from 'discord.js';
import { createAdminHandler, isOwnerAdmin } from '../src/admin.js';

const config = { adminGuildId: 'admin-guild', ownerId: 'owner', model: 'test-model' };

function setup(overrides = {}) {
  const calls = {};
  const record = (name, value) => { (calls[name] ??= []).push(value); };
  const settings = { dailyRequestLimit: 20, warnPercent: 80, stopPercent: 90, maintenance: false };
  const store = {
    status: async (key) => { record('status', key); return { requests: 7, settings }; },
    getSettings: async () => { record('getSettings', true); return settings; },
    setSettings: async (patch) => { record('setSettings', patch); return { ...settings, ...patch }; },
    ...overrides.store,
  };
  const handler = createAdminHandler({ store, config, client: { isReady: () => true }, logger: { error: (...args) => record('error', args) } });
  function interaction(patch = {}) {
    return {
      guildId: config.adminGuildId, user: { id: config.ownerId }, commandName: 'cai',
      isChatInputCommand: () => true,
      options: {
        getSubcommand: () => 'status', getBoolean: () => true, getString: () => null, getInteger: () => null,
      },
      reply: async (payload) => record('reply', payload),
      deferReply: async (payload) => record('deferReply', payload),
      editReply: async (payload) => record('editReply', payload),
      followUp: async (payload) => record('followUp', payload),
      ...patch,
    };
  }
  return { handler, calls, interaction };
}

test('admin authorization requires both owner identity and management guild', () => {
  assert.equal(isOwnerAdmin({ guildId: 'admin-guild', user: { id: 'owner' } }, config), true);
  for (const interaction of [
    { guildId: 'other-guild', user: { id: 'owner' } },
    { guildId: 'admin-guild', user: { id: 'other-user' } },
    { guildId: null, user: { id: 'owner' } },
    { guildId: 'other-guild', user: { id: 'other-user' } },
  ]) assert.equal(isOwnerAdmin(interaction, config), false);
});

test('unauthorized admin commands return a private refusal and never touch state', async () => {
  for (const patch of [{ guildId: 'other-guild' }, { user: { id: 'other-user' } }, { guildId: null }]) {
    const context = setup();
    await context.handler(context.interaction(patch));
    assert.equal(context.calls.reply.length, 1);
    assert.equal(context.calls.reply[0].flags, MessageFlags.Ephemeral);
    assert.equal(context.calls.deferReply, undefined);
    assert.equal(context.calls.status, undefined);
    assert.equal(context.calls.getSettings, undefined);
    assert.equal(context.calls.setSettings, undefined);
  }
});

test('unrelated interaction types and command names are ignored', async () => {
  const context = setup();
  await context.handler(context.interaction({ isChatInputCommand: () => false }));
  await context.handler(context.interaction({ commandName: 'other-command' }));
  assert.deepEqual(context.calls, {});
});

test('authorized status stays ephemeral and identifies the limits correctly', async () => {
  const context = setup();
  await context.handler(context.interaction());
  assert.equal(context.calls.deferReply[0].flags, MessageFlags.Ephemeral);
  assert.match(context.calls.status[0], /^\d{4}-\d{2}-\d{2}$/u);
  const reply = context.calls.editReply[0];
  assert.match(reply.content, /cai v1/u);
  assert.match(reply.content, /test-model/u);
  assert.match(reply.content, /日本時間0時/u);
  assert.match(reply.content, /各社全体の残量ではない/u);
  assert.deepEqual(reply.allowedMentions, { parse: [] });
});

test('maintenance changes only the requested maintenance state and optional message', async () => {
  const context = setup();
  await context.handler(context.interaction({ options: {
    getSubcommand: () => 'maintenance', getBoolean: () => true, getString: () => '@everyone 工事中',
  } }));
  assert.deepEqual(context.calls.setSettings[0], { maintenance: true, maintenanceMessage: '@everyone 工事中' });
  assert.match(context.calls.editReply[0].content, /メンテモード/u);
  assert.equal(context.calls.deferReply[0].flags, MessageFlags.Ephemeral);
  assert.deepEqual(context.calls.editReply[0].allowedMentions, { parse: [] });
});

test('guard maps the supplied limits without resetting usage counters', async () => {
  const context = setup();
  const values = { daily: 100, warn: 70, stop: 85 };
  await context.handler(context.interaction({ options: {
    getSubcommand: () => 'guard', getInteger: (key) => values[key] ?? null,
  } }));
  assert.deepEqual(context.calls.setSettings[0], { dailyRequestLimit: 100, warnPercent: 70, stopPercent: 85 });
  assert.match(context.calls.editReply[0].content, /カウンターはリセットしてへん/u);
  assert.equal(context.calls.status, undefined);
});

test('guard with no fields reads settings and does not mutate them', async () => {
  const context = setup();
  await context.handler(context.interaction({ options: {
    getSubcommand: () => 'guard', getInteger: () => null,
  } }));
  assert.equal(context.calls.getSettings.length, 1);
  assert.equal(context.calls.setSettings, undefined);
});

test('invalid guard settings produce a private error without exposing internals', async () => {
  const context = setup({ store: { setSettings: async () => { throw new Error('postgres://private-password@example.com/db'); } } });
  await context.handler(context.interaction({ options: {
    getSubcommand: () => 'guard', getInteger: (key) => key === 'warn' ? 99 : null,
  } }));
  assert.equal(context.calls.deferReply[0].flags, MessageFlags.Ephemeral);
  assert.match(context.calls.editReply[0], /停止の割合より小さく/u);
  assert.equal(JSON.stringify(context.calls).includes('private-password'), false);
});
