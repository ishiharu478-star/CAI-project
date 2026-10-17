function integer(env, name, fallback, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

export function loadConfig(env = process.env) {
  const required = ['DISCORD_TOKEN', 'GEMINI_API_KEY', 'DATABASE_URL', 'OWNER_USER_ID', 'ADMIN_GUILD_ID'];
  const missing = required.filter(name => !env[name]?.trim());
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  for (const name of ['OWNER_USER_ID', 'ADMIN_GUILD_ID']) {
    if (!/^\d{17,20}$/.test(env[name])) throw new Error(`${name} must be a Discord ID`);
  }
  let database;
  try { database = new URL(env.DATABASE_URL); } catch { throw new Error('DATABASE_URL must be a PostgreSQL URL'); }
  if (!['postgres:', 'postgresql:'].includes(database.protocol)) throw new Error('DATABASE_URL must be a PostgreSQL URL');
  const warnPercent = integer(env, 'GUARD_WARN_PERCENT', 80, 1, 99);
  const stopPercent = integer(env, 'GUARD_STOP_PERCENT', 90, 2, 100);
  if (warnPercent >= stopPercent) throw new Error('GUARD_WARN_PERCENT must be lower than GUARD_STOP_PERCENT');
  const allowedGuildIds = (env.ALLOWED_GUILD_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
  if (allowedGuildIds.some(id => !/^\d{17,20}$/.test(id))) throw new Error('ALLOWED_GUILD_IDS must contain Discord IDs');
  return Object.freeze({
    discordToken: env.DISCORD_TOKEN, apiKey: env.GEMINI_API_KEY, databaseUrl: env.DATABASE_URL,
    ownerId: env.OWNER_USER_ID, adminGuildId: env.ADMIN_GUILD_ID,
    model: env.GEMINI_MODEL?.trim() || 'gemini-3.5-flash-lite',
    dailyRequestLimit: integer(env, 'GEMINI_DAILY_REQUEST_LIMIT', 20, 1, 1000000),
    rpmLimit: integer(env, 'GEMINI_RPM_LIMIT', 5, 1, 10000), warnPercent, stopPercent,
    maxOutputTokens: integer(env, 'MAX_OUTPUT_TOKENS', 4096, 256, 16384),
    maxConcurrent: integer(env, 'MAX_CONCURRENT_REQUESTS', 2, 1, 5),
    port: integer(env, 'PORT', 10000, 1, 65535), allowedGuildIds,
  });
}
