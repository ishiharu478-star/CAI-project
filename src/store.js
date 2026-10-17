import { readFile } from 'node:fs/promises';
import pg from 'pg';

const { Pool } = pg;
const DEFAULT_SETTINGS = Object.freeze({
  maintenance: false,
  maintenanceMessage: 'いまメンテ中やで。ちょっと待っててな。',
  dailyRequestLimit: 20,
  warnPercent: 80,
  stopPercent: 90,
});
const BUDGET_LOCK_ID = '484623177001';

function error(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function integer(value, label, min = 1, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw error('INVALID_ARGUMENT', `${label} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function identifier(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) {
    throw error('INVALID_ARGUMENT', `${label} must be a nonempty string of at most 256 characters.`);
  }
  return value;
}

function settingsPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw error('INVALID_ARGUMENT', 'Settings must be an object.');
  }
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, key)) {
      throw error('INVALID_ARGUMENT', `Unknown setting: ${key}`);
    }
    if (key === 'maintenance' && typeof value !== 'boolean') {
      throw error('INVALID_ARGUMENT', 'maintenance must be a boolean.');
    }
    if (key === 'maintenanceMessage' &&
        (typeof value !== 'string' || !value.trim() || value.length > 1800)) {
      throw error('INVALID_ARGUMENT', 'maintenanceMessage must contain 1 to 1800 characters.');
    }
    if (key === 'dailyRequestLimit') integer(value, key, 1, 1000000);
    if (key === 'warnPercent') integer(value, key, 0, 99);
    if (key === 'stopPercent') integer(value, key, 1, 100);
  }
  return { ...patch };
}

function completeSettings(values) {
  const settings = { ...DEFAULT_SETTINGS, ...settingsPatch(values) };
  if (settings.warnPercent >= settings.stopPercent) {
    throw error('INVALID_ARGUMENT', 'warnPercent must be lower than stopPercent.');
  }
  return settings;
}

function exchange(row) {
  if (!row) return null;
  return {
    id: row.id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    userId: row.user_id,
    userMessageId: row.user_message_id,
    botMessageIds: row.bot_message_ids,
    prompt: row.prompt,
    response: row.response,
    threadKey: row.thread_key,
    createdAt: row.created_at,
  };
}

async function transaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (cause) {
    try { await client.query('ROLLBACK'); } catch { /* Preserve the original failure. */ }
    throw cause;
  } finally {
    client.release();
  }
}

export class Store {
  constructor(databaseUrl, { pool, defaults = {} } = {}) {
    this.defaults = completeSettings(defaults);
    this.pool = pool ?? new Pool({
      connectionString: databaseUrl,
      max: 5,
      connectionTimeoutMillis: 15000,
      idleTimeoutMillis: 30000,
    });
    // A transient Neon connection error must not become an unhandled event.
    this.pool.on?.('error', (cause) => {
      console.error('[cai] Idle database connection failed:', cause.code ?? 'DATABASE_ERROR');
    });
  }

  async init() {
    const schema = await readFile(new URL('../sql/schema.sql', import.meta.url), 'utf8');
    await this.pool.query(schema);
    await this.pool.query(
      'INSERT INTO cai_settings (id, settings) VALUES (1, $1::jsonb) ON CONFLICT (id) DO NOTHING',
      [JSON.stringify(this.defaults)],
    );
  }

  async close() { await this.pool.end(); }

  async ping() { await this.pool.query('SELECT 1'); return true; }

  async getSettings() {
    const result = await this.pool.query('SELECT settings FROM cai_settings WHERE id = 1');
    return completeSettings({ ...this.defaults, ...(result.rows[0]?.settings ?? {}) });
  }

  async setSettings(patch) {
    const validated = settingsPatch(patch);
    return transaction(this.pool, async (client) => {
      const result = await client.query('SELECT settings FROM cai_settings WHERE id = 1 FOR UPDATE');
      const next = completeSettings({ ...this.defaults, ...(result.rows[0]?.settings ?? {}), ...validated });
      await client.query(
        `INSERT INTO cai_settings (id, settings) VALUES (1, $1::jsonb)
         ON CONFLICT (id) DO UPDATE SET settings = EXCLUDED.settings`,
        [JSON.stringify(next)],
      );
      return next;
    });
  }

  async getQuota(userId, dayKey) {
    identifier(userId, 'userId'); identifier(dayKey, 'dayKey');
    const result = await this.pool.query(
      'SELECT questions FROM cai_daily_user_usage WHERE day_key = $1 AND user_id = $2',
      [dayKey, userId],
    );
    return Number(result.rows[0]?.questions ?? 0);
  }

  async reserveQuestion(userId, dayKey, limit = 30) {
    identifier(userId, 'userId'); identifier(dayKey, 'dayKey'); integer(limit, 'limit', 1, 100000);
    const result = await this.pool.query(
      `INSERT INTO cai_daily_user_usage (day_key, user_id, questions) VALUES ($1, $2, 1)
       ON CONFLICT (day_key, user_id) DO UPDATE
         SET questions = cai_daily_user_usage.questions + 1
         WHERE cai_daily_user_usage.questions < $3
       RETURNING questions`,
      [dayKey, userId, limit],
    );
    return result.rows.length > 0;
  }

  async refundQuestion(userId, dayKey) {
    identifier(userId, 'userId'); identifier(dayKey, 'dayKey');
    await this.pool.query(
      `UPDATE cai_daily_user_usage SET questions = GREATEST(0, questions - 1)
       WHERE day_key = $1 AND user_id = $2`,
      [dayKey, userId],
    );
  }

  async withGenerationBudget({ dayKey, minuteKey, dailyLimit, rpmLimit, warnPercent = 80, stopPercent = 90 }, fn) {
    identifier(dayKey, 'dayKey'); identifier(minuteKey, 'minuteKey');
    integer(dailyLimit, 'dailyLimit'); integer(rpmLimit, 'rpmLimit');
    integer(warnPercent, 'warnPercent', 0, 99); integer(stopPercent, 'stopPercent', 1, 100);
    if (warnPercent >= stopPercent || typeof fn !== 'function') {
      throw error('INVALID_ARGUMENT', 'Use warnPercent < stopPercent and provide a generation function.');
    }
    const stopAt = Math.max(1, Math.floor(dailyLimit * stopPercent / 100));
    const reservation = await transaction(this.pool, async (client) => {
      // A shared database lock coordinates every Render process and restart.
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [BUDGET_LOCK_ID]);
      await client.query(
        'INSERT INTO cai_generation_usage (day_key) VALUES ($1) ON CONFLICT (day_key) DO NOTHING', [dayKey],
      );
      await client.query(
        'INSERT INTO cai_generation_minute_usage (minute_key) VALUES ($1) ON CONFLICT (minute_key) DO NOTHING', [minuteKey],
      );
      const daily = await client.query('SELECT attempts FROM cai_generation_usage WHERE day_key = $1 FOR UPDATE', [dayKey]);
      const minute = await client.query('SELECT attempts FROM cai_generation_minute_usage WHERE minute_key = $1 FOR UPDATE', [minuteKey]);
      const used = Number(daily.rows[0].attempts);
      const minuteUsed = Number(minute.rows[0].attempts);
      if (used + 1 > stopAt) {
        throw error('QUOTA_GUARD', 'The configured daily Gemini safety limit has been reached.', { used, limit: dailyLimit, stopAt });
      }
      if (minuteUsed + 1 > rpmLimit) {
        throw error('RATE_GUARD', 'The configured Gemini requests-per-minute limit has been reached.', { used: minuteUsed, limit: rpmLimit });
      }
      await client.query('UPDATE cai_generation_usage SET attempts = attempts + 1 WHERE day_key = $1', [dayKey]);
      await client.query('UPDATE cai_generation_minute_usage SET attempts = attempts + 1 WHERE minute_key = $1', [minuteKey]);
      return { used: used + 1, limit: dailyLimit, warning: (used + 1) * 100 >= dailyLimit * warnPercent };
    });
    // Commit before network I/O. Failed attempts still consume the local guard.
    const value = await fn();
    return { value, ...reservation };
  }

  async recordTokens(dayKey, count) {
    identifier(dayKey, 'dayKey'); integer(count, 'count', 0);
    if (!count) return;
    await this.pool.query(
      `INSERT INTO cai_generation_usage (day_key, total_tokens) VALUES ($1, $2)
       ON CONFLICT (day_key) DO UPDATE
         SET total_tokens = cai_generation_usage.total_tokens + EXCLUDED.total_tokens`,
      [dayKey, count],
    );
  }

  async saveExchange({ guildId, channelId, userId, userMessageId, botMessageIds, prompt, response, threadKey = userMessageId }) {
    identifier(guildId, 'guildId'); identifier(channelId, 'channelId'); identifier(userId, 'userId');
    identifier(userMessageId, 'userMessageId'); identifier(threadKey, 'threadKey');
    if (!Array.isArray(botMessageIds) || !botMessageIds.length) {
      throw error('INVALID_ARGUMENT', 'botMessageIds must include the delivered answer message.');
    }
    botMessageIds.forEach((id) => identifier(id, 'botMessageId'));
    if (typeof prompt !== 'string' || typeof response !== 'string') {
      throw error('INVALID_ARGUMENT', 'prompt and response must be strings.');
    }
    const result = await this.pool.query(
      `INSERT INTO cai_exchanges
         (guild_id, channel_id, user_id, user_message_id, bot_message_ids, prompt, response, thread_key)
       VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $8)
       ON CONFLICT (guild_id, channel_id, user_message_id) DO NOTHING
       RETURNING *`,
      [guildId, channelId, userId, userMessageId, botMessageIds, prompt, response, threadKey],
    );
    return exchange(result.rows[0]);
  }

  async recent({ guildId, channelId, userId, threadKey, limit = 8 }) {
    identifier(guildId, 'guildId'); identifier(channelId, 'channelId'); integer(limit, 'limit', 1, 50);
    const scope = threadKey === undefined ? 'user_id' : 'thread_key';
    const scopeValue = threadKey === undefined ? identifier(userId, 'userId') : identifier(threadKey, 'threadKey');
    const result = await this.pool.query(
      `SELECT * FROM cai_exchanges
       WHERE guild_id = $1 AND channel_id = $2 AND ${scope} = $3
       ORDER BY id DESC LIMIT $4`,
      [guildId, channelId, scopeValue, limit],
    );
    return result.rows.map(exchange).reverse();
  }

  async findExchange({ guildId, channelId, botMessageId }) {
    identifier(guildId, 'guildId'); identifier(channelId, 'channelId'); identifier(botMessageId, 'botMessageId');
    const result = await this.pool.query(
      `SELECT * FROM cai_exchanges
       WHERE guild_id = $1 AND channel_id = $2 AND bot_message_ids @> ARRAY[$3]::text[]
       ORDER BY id DESC LIMIT 1`,
      [guildId, channelId, botMessageId],
    );
    return exchange(result.rows[0]);
  }

  async search({ guildId, channelId, userId, query, limit = 5 }) {
    identifier(guildId, 'guildId'); identifier(channelId, 'channelId'); identifier(userId, 'userId');
    integer(limit, 'limit', 1, 20);
    if (typeof query !== 'string' || query.length > 2000) {
      throw error('INVALID_ARGUMENT', 'query must be a string of at most 2000 characters.');
    }
    const term = query.trim();
    if (!term) return [];
    const pattern = `%${term.replace(/[!%_]/g, '!$&')}%`;
    const result = await this.pool.query(
      `SELECT * FROM cai_exchanges
       WHERE guild_id = $1 AND channel_id = $2 AND user_id = $3
         AND (prompt ILIKE $4 ESCAPE '!' OR response ILIKE $4 ESCAPE '!')
       ORDER BY id DESC LIMIT $5`,
      [guildId, channelId, userId, pattern, limit],
    );
    return result.rows.map(exchange);
  }

  async queueFile(name) {
    identifier(name, 'name');
    await this.pool.query('INSERT INTO cai_gemini_files (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [name]);
  }

  async removeFile(name) {
    identifier(name, 'name');
    await this.pool.query('DELETE FROM cai_gemini_files WHERE name = $1', [name]);
  }

  async pendingFiles() {
    const result = await this.pool.query('SELECT name FROM cai_gemini_files ORDER BY created_at, name');
    return result.rows.map((row) => row.name);
  }

  async status(dayKey, userDayKey = dayKey) {
    identifier(dayKey, 'dayKey'); identifier(userDayKey, 'userDayKey');
    const results = await Promise.all([
      this.pool.query('SELECT attempts, total_tokens FROM cai_generation_usage WHERE day_key = $1', [dayKey]),
      this.pool.query(
        `SELECT COUNT(*) FILTER (WHERE questions > 0) AS users, COALESCE(SUM(questions), 0) AS questions
         FROM cai_daily_user_usage WHERE day_key = $1`, [userDayKey],
      ),
      this.pool.query('SELECT COUNT(*) AS count FROM cai_gemini_files'),
      this.getSettings(),
    ]);
    return {
      dayKey,
      userDayKey,
      generationAttempts: Number(results[0].rows[0]?.attempts ?? 0),
      totalTokens: Number(results[0].rows[0]?.total_tokens ?? 0),
      usersAskedToday: Number(results[1].rows[0]?.users ?? 0),
      questionsToday: Number(results[1].rows[0]?.questions ?? 0),
      pendingFiles: Number(results[2].rows[0]?.count ?? 0),
      settings: results[3],
    };
  }
}
