CREATE TABLE IF NOT EXISTS telegram_sessions (
  chat_id TEXT PRIMARY KEY,
  agent_slug TEXT NOT NULL DEFAULT 'atlas',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
