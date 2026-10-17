import { Client, Events, GatewayIntentBits, Options } from 'discord.js';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { GeminiService } from './gemini.js';
import { createMessageHandler } from './bot.js';
import { adminCommand, createAdminHandler } from './admin.js';
import { createHealthServer } from './health.js';
import { safeError, VERSION } from './util.js';

let config;
try { config = loadConfig(); } catch (error) {
  // Validation messages contain variable names only, never their contents.
  console.error(error.message); process.exit(1);
}
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  allowedMentions: { parse: [], repliedUser: false },
  makeCache: Options.cacheWithLimits({ MessageManager: 0 }),
});
const store = new Store(config.databaseUrl, { defaults: { dailyRequestLimit: config.dailyRequestLimit,
  warnPercent: config.warnPercent, stopPercent: config.stopPercent } });
const gemini = new GeminiService({ apiKey: config.apiKey, model: config.model, maxOutputTokens: config.maxOutputTokens, store });
let stopping = false;
let databaseReady = false;
const health = createHealthServer({ client, isStopping: () => stopping, dbReady: () => databaseReady });
const handler = createMessageHandler({ store, gemini, config });
const admin = createAdminHandler({ store, config, client });
const inFlight = new Set();
function track(task) { inFlight.add(task); task.finally(() => inFlight.delete(task)).catch(() => {}); }
client.on(Events.MessageCreate, message => { if (!stopping) track(handler(message, client.user.id).catch(error => console.error('Message event failed', safeError(error)))); });
client.on(Events.InteractionCreate, interaction => { if (!stopping) track(admin(interaction).catch(error => console.error('Interaction event failed', safeError(error)))); });
client.on(Events.Error, error => console.error('Discord error', safeError(error)));
client.on(Events.Warn, () => console.warn('Discord reported a connection warning'));
client.once(Events.ClientReady, async ready => {
  console.log(`${VERSION} connected`);
  ready.user.setPresence({ activities: [{ name: 'cai v1 | メンションで話してな' }], status: 'online' });
  try {
    const guild = await client.guilds.fetch(config.adminGuildId);
    const commands = await guild.commands.fetch();
    const existing = commands.find(command => command.name === 'cai');
    if (existing) await existing.edit(adminCommand().toJSON());
    else await guild.commands.create(adminCommand().toJSON());
    console.log('Owner administration command ready');
  } catch (error) { console.error('Admin command registration failed; check ADMIN_GUILD_ID and invite scope', safeError(error)); }
});

let cleanupTimer;
let cleanupRunning = false;
function runMediaCleanup() {
  if (cleanupRunning || stopping) return;
  cleanupRunning = true;
  track(gemini.cleanupPendingFiles()
    .catch(error => console.error('Media cleanup failed', safeError(error)))
    .finally(() => { cleanupRunning = false; }));
}
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(cleanupTimer);
  health.close();
  // Force termination only after Render's normal graceful window. Pending
  // remote media stays in the durable cleanup queue if interrupted.
  const timer = setTimeout(() => process.exit(0), 25000);
  timer.unref();
  let graceTimer;
  await Promise.race([Promise.allSettled([...inFlight]), new Promise(resolve => { graceTimer = setTimeout(resolve, 22000); })]);
  clearTimeout(graceTimer);
  client.destroy();
  await store.close().catch(() => {});
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
try {
  await store.init();
  databaseReady = true;
  await new Promise((resolve, reject) => { health.once('error', reject); health.listen(config.port, '0.0.0.0', resolve); });
  console.log(`${VERSION} health endpoint listening`);
  // Retrying old deletions must not delay Discord login. The cleanup queue and
  // active-file exclusion allow one background sweep without overlapping runs.
  runMediaCleanup();
  cleanupTimer = setInterval(runMediaCleanup, 3600000);
  cleanupTimer.unref();
  await client.login(config.discordToken);
} catch (error) {
  console.error('Startup failed: check Render variables, Neon connection, Discord token and Message Content Intent', safeError(error));
  await shutdown(); process.exitCode = 1;
}
