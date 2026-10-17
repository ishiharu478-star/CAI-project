-- cai v1: only addressed cai conversations are stored; no automatic expiry.
CREATE TABLE IF NOT EXISTS cai_settings (
  id smallint PRIMARY KEY CHECK (id = 1),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS cai_daily_user_usage (
  day_key text NOT NULL,
  user_id text NOT NULL,
  questions integer NOT NULL DEFAULT 0 CHECK (questions >= 0),
  PRIMARY KEY (day_key, user_id)
);

CREATE TABLE IF NOT EXISTS cai_generation_usage (
  day_key text PRIMARY KEY,
  attempts bigint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  total_tokens bigint NOT NULL DEFAULT 0 CHECK (total_tokens >= 0)
);

CREATE TABLE IF NOT EXISTS cai_generation_minute_usage (
  minute_key text PRIMARY KEY,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0)
);

CREATE TABLE IF NOT EXISTS cai_exchanges (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  guild_id text NOT NULL,
  channel_id text NOT NULL,
  user_id text NOT NULL,
  user_message_id text NOT NULL,
  bot_message_ids text[] NOT NULL,
  prompt text NOT NULL,
  response text NOT NULL,
  thread_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (guild_id, channel_id, user_message_id)
);

CREATE INDEX IF NOT EXISTS cai_exchanges_user_context_idx
  ON cai_exchanges (guild_id, channel_id, user_id, id DESC);
CREATE INDEX IF NOT EXISTS cai_exchanges_thread_context_idx
  ON cai_exchanges (guild_id, channel_id, thread_key, id DESC);
CREATE INDEX IF NOT EXISTS cai_exchanges_bot_message_idx
  ON cai_exchanges USING gin (bot_message_ids);

-- Names of temporary Gemini uploads that still require remote deletion.
CREATE TABLE IF NOT EXISTS cai_gemini_files (
  name text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
