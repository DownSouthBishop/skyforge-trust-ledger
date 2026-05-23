
-- 1. Extend atlas_mcp_connections
ALTER TABLE public.atlas_mcp_connections
  ADD COLUMN IF NOT EXISTS category text DEFAULT 'general',
  ADD COLUMN IF NOT EXISTS icon_url text;

-- 2. atlas_preferences
CREATE TABLE IF NOT EXISTS public.atlas_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  claude_code_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  cowork_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.atlas_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY "prefs select own" ON public.atlas_preferences FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "prefs insert own" ON public.atlas_preferences FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "prefs update own" ON public.atlas_preferences FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "prefs delete own" ON public.atlas_preferences FOR DELETE USING (auth.uid() = user_id);
CREATE TRIGGER atlas_prefs_updated_at BEFORE UPDATE ON public.atlas_preferences
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 3. cowork_activity_log
CREATE TABLE IF NOT EXISTS public.cowork_activity_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action_type text NOT NULL,
  target_path text,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cowork_log_user_idx ON public.cowork_activity_log(user_id, created_at DESC);
ALTER TABLE public.cowork_activity_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "cowork select own" ON public.cowork_activity_log FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "cowork insert own" ON public.cowork_activity_log FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "cowork delete own" ON public.cowork_activity_log FOR DELETE USING (auth.uid() = user_id);

-- 4. mcp_directory
CREATE TABLE IF NOT EXISTS public.mcp_directory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  description text,
  category text,
  transport text,
  url text,
  command text,
  args text[],
  required_env_vars jsonb DEFAULT '[]'::jsonb,
  icon text,
  author text,
  docs_url text,
  is_featured boolean DEFAULT false,
  install_count integer DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.mcp_directory ENABLE ROW LEVEL SECURITY;
CREATE POLICY "directory public read" ON public.mcp_directory FOR SELECT USING (true);

-- 5. Seed
INSERT INTO public.mcp_directory (name, slug, description, category, transport, url, command, args, required_env_vars, icon, docs_url, is_featured) VALUES
-- Development
('GitHub','github','Access repos, issues, PRs, commits.','Development','stdio',NULL,'npx',ARRAY['-y','@modelcontextprotocol/server-github'],'[{"key":"GITHUB_PERSONAL_ACCESS_TOKEN","required":true}]'::jsonb,'🐙','https://github.com/modelcontextprotocol/servers/tree/main/src/github',true),
('GitLab','gitlab','Repos, merge requests, pipelines.','Development','stdio',NULL,'npx',ARRAY['-y','@modelcontextprotocol/server-gitlab'],'[{"key":"GITLAB_TOKEN","required":true}]'::jsonb,'🦊','https://docs.gitlab.com',false),
('Filesystem','filesystem','Read and write local files.','Development','stdio',NULL,'npx',ARRAY['-y','@modelcontextprotocol/server-filesystem','/path/to/dir'],'[]'::jsonb,'📁','https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',true),
('Postgres','postgres','Query and manage PostgreSQL databases.','Development','stdio',NULL,'npx',ARRAY['-y','@modelcontextprotocol/server-postgres'],'[{"key":"POSTGRES_CONNECTION_STRING","required":true}]'::jsonb,'🐘','https://www.postgresql.org/docs/',false),
('Supabase','supabase','Direct Supabase project access.','Development','stdio',NULL,'npx',ARRAY['-y','@modelcontextprotocol/server-supabase'],'[{"key":"SUPABASE_URL","required":true},{"key":"SUPABASE_SERVICE_ROLE_KEY","required":true}]'::jsonb,'⚡','https://supabase.com/docs',true),
('Docker','docker','Manage containers and images.','Development','stdio',NULL,'npx',ARRAY['-y','@modelcontextprotocol/server-docker'],'[]'::jsonb,'🐳','https://docs.docker.com',false),
('Sentry','sentry','Access error tracking and alerts.','Development','stdio',NULL,'npx',ARRAY['-y','@modelcontextprotocol/server-sentry'],'[{"key":"SENTRY_AUTH_TOKEN","required":true}]'::jsonb,'🛡️','https://docs.sentry.io',false),
-- Productivity
('Google Drive','google-drive','Read, write, search Drive files.','Productivity','sse','https://drivemcp.googleapis.com/mcp/v1',NULL,NULL,'[{"key":"GOOGLE_OAUTH_TOKEN","required":true}]'::jsonb,'📂','https://developers.google.com/drive',false),
('Google Calendar','google-calendar','Events, scheduling, availability.','Productivity','sse','https://calendarmcp.googleapis.com/mcp/v1',NULL,NULL,'[{"key":"GOOGLE_OAUTH_TOKEN","required":true}]'::jsonb,'📅','https://developers.google.com/calendar',false),
('Gmail','gmail','Read, search, send emails.','Communication','sse','https://gmailmcp.googleapis.com/mcp/v1',NULL,NULL,'[{"key":"GOOGLE_OAUTH_TOKEN","required":true}]'::jsonb,'📧','https://developers.google.com/gmail',false),
('Notion','notion','Pages, databases, blocks.','Productivity','sse','https://mcp.notion.com/mcp',NULL,NULL,'[{"key":"NOTION_API_KEY","required":true}]'::jsonb,'📝','https://developers.notion.com',true),
('Airtable','airtable','Bases, tables, records.','Productivity','sse','https://mcp.airtable.com/mcp',NULL,NULL,'[{"key":"AIRTABLE_API_KEY","required":true}]'::jsonb,'🗂️','https://airtable.com/developers',false),
('Linear','linear','Issues, projects, roadmaps.','Productivity','sse','https://mcp.linear.app/mcp',NULL,NULL,'[{"key":"LINEAR_API_KEY","required":true}]'::jsonb,'📐','https://developers.linear.app',true),
('Asana','asana','Tasks, projects, workspaces.','Productivity','sse','https://mcp.asana.com/sse',NULL,NULL,'[{"key":"ASANA_TOKEN","required":true}]'::jsonb,'✅','https://developers.asana.com',false),
('Todoist','todoist','Tasks and projects.','Productivity','stdio',NULL,'npx',ARRAY['-y','@modelcontextprotocol/server-todoist'],'[{"key":"TODOIST_API_KEY","required":true}]'::jsonb,'☑️','https://developer.todoist.com',false),
-- Communication
('Slack','slack','Messages, channels, users.','Communication','stdio',NULL,'npx',ARRAY['-y','@modelcontextprotocol/server-slack'],'[{"key":"SLACK_BOT_TOKEN","required":true}]'::jsonb,'💬','https://api.slack.com',true),
('Telegram','telegram','Send and receive messages via bot.','Communication','stdio',NULL,'npx',ARRAY['-y','mcp-telegram'],'[{"key":"TELEGRAM_BOT_TOKEN","required":true}]'::jsonb,'✈️','https://core.telegram.org/bots',false),
('Discord','discord','Messages, channels, guilds.','Communication','stdio',NULL,'npx',ARRAY['-y','@modelcontextprotocol/server-discord'],'[{"key":"DISCORD_BOT_TOKEN","required":true}]'::jsonb,'🎮','https://discord.com/developers',false),
('Twilio','twilio','Send SMS and voice programmatically.','Communication','stdio',NULL,'npx',ARRAY['-y','@modelcontextprotocol/server-twilio'],'[{"key":"TWILIO_ACCOUNT_SID","required":true},{"key":"TWILIO_AUTH_TOKEN","required":true}]'::jsonb,'📞','https://www.twilio.com/docs',false),
('SendGrid','sendgrid','Email delivery and analytics.','Communication','stdio',NULL,'npx',ARRAY['-y','@modelcontextprotocol/server-sendgrid'],'[{"key":"SENDGRID_API_KEY","required":true}]'::jsonb,'📨','https://docs.sendgrid.com',false),
-- Finance
('Alpaca','alpaca','Trade equities via Alpaca API.','Finance','stdio',NULL,'node',ARRAY['mcp-servers/alpaca/index.js'],'[{"key":"ALPACA_API_KEY","required":true},{"key":"ALPACA_SECRET_KEY","required":true}]'::jsonb,'🦙','https://alpaca.markets/docs',true),
('OANDA','oanda','Trade forex via OANDA v20 API.','Finance','stdio',NULL,'node',ARRAY['mcp-servers/oanda/index.js'],'[{"key":"OANDA_API_KEY","required":true},{"key":"OANDA_ACCOUNT_ID","required":true}]'::jsonb,'💱','https://developer.oanda.com',true),
('IBKR','ibkr','Interactive Brokers trading via TWS.','Finance','stdio',NULL,'node',ARRAY['mcp-servers/ibkr/index.js'],'[{"key":"IBKR_HOST","required":true},{"key":"IBKR_PORT","required":true}]'::jsonb,'🏦','https://interactivebrokers.github.io',true),
('Stripe','stripe','Payments, subscriptions, customers.','Finance','stdio',NULL,'npx',ARRAY['-y','@modelcontextprotocol/server-stripe'],'[{"key":"STRIPE_SECRET_KEY","required":true}]'::jsonb,'💳','https://stripe.com/docs',false),
('QuickBooks','quickbooks','Accounting and invoicing.','Finance','sse','https://mcp.quickbooks.com/sse',NULL,NULL,'[{"key":"QB_CLIENT_ID","required":true},{"key":"QB_CLIENT_SECRET","required":true}]'::jsonb,'📊','https://developer.intuit.com',false),
('CoinGecko','coingecko','Crypto prices and market data.','Finance','stdio',NULL,'npx',ARRAY['-y','@modelcontextprotocol/server-coingecko'],'[]'::jsonb,'🦎','https://www.coingecko.com/api',false),
-- Browser
('Puppeteer','puppeteer','Control Chrome for web automation.','Browser','stdio',NULL,'npx',ARRAY['-y','@modelcontextprotocol/server-puppeteer'],'[]'::jsonb,'🎭','https://pptr.dev',false),
('Fetch','fetch','Fetch any URL and read its content.','Browser','stdio',NULL,'npx',ARRAY['-y','@modelcontextprotocol/server-fetch'],'[]'::jsonb,'🌐','https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',true),
('Browserbase','browserbase','Cloud browser automation.','Browser','stdio',NULL,'npx',ARRAY['-y','@modelcontextprotocol/server-browserbase'],'[{"key":"BROWSERBASE_API_KEY","required":true}]'::jsonb,'🌍','https://browserbase.com/docs',false),
('OpenClaw','openclaw','Agentic browser control.','Browser','sse','https://efpdhwqhitfccfccnlhm.supabase.co/functions/v1/openclaw-proxy',NULL,NULL,'[]'::jsonb,'🦅','https://openclaw.dev',false),
-- AI Tools
('Anthropic','anthropic','Direct Claude API access.','AI Tools','stdio',NULL,'npx',ARRAY['-y','@modelcontextprotocol/server-anthropic'],'[{"key":"ANTHROPIC_API_KEY","required":true}]'::jsonb,'🧠','https://docs.anthropic.com',false),
('OpenAI','openai','GPT model access.','AI Tools','stdio',NULL,'npx',ARRAY['-y','@modelcontextprotocol/server-openai'],'[{"key":"OPENAI_API_KEY","required":true}]'::jsonb,'🤖','https://platform.openai.com/docs',false),
('Perplexity','perplexity','Real-time web search and research.','AI Tools','stdio',NULL,'npx',ARRAY['-y','@modelcontextprotocol/server-perplexity'],'[{"key":"PERPLEXITY_API_KEY","required":true}]'::jsonb,'🔎','https://docs.perplexity.ai',false),
('ElevenLabs','elevenlabs','Text to speech generation.','AI Tools','stdio',NULL,'npx',ARRAY['-y','@modelcontextprotocol/server-elevenlabs'],'[{"key":"ELEVENLABS_API_KEY","required":true}]'::jsonb,'🎙️','https://elevenlabs.io/docs',false),
('Replicate','replicate','Run AI models via Replicate API.','AI Tools','stdio',NULL,'npx',ARRAY['-y','@modelcontextprotocol/server-replicate'],'[{"key":"REPLICATE_API_TOKEN","required":true}]'::jsonb,'🔬','https://replicate.com/docs',false),
-- Storage
('AWS S3','aws-s3','Object storage read and write.','Storage','stdio',NULL,'npx',ARRAY['-y','@modelcontextprotocol/server-aws-s3'],'[{"key":"AWS_ACCESS_KEY_ID","required":true},{"key":"AWS_SECRET_ACCESS_KEY","required":true}]'::jsonb,'☁️','https://docs.aws.amazon.com/s3',false),
('Cloudflare','cloudflare','Workers, KV, R2, DNS management.','Storage','stdio',NULL,'npx',ARRAY['-y','@modelcontextprotocol/server-cloudflare'],'[{"key":"CLOUDFLARE_API_TOKEN","required":true}]'::jsonb,'🟧','https://developers.cloudflare.com',false),
('Redis','redis','Key-value store operations.','Data','stdio',NULL,'npx',ARRAY['-y','@modelcontextprotocol/server-redis'],'[{"key":"REDIS_URL","required":true}]'::jsonb,'🔴','https://redis.io/docs',false),
('MongoDB','mongodb','Document database operations.','Data','stdio',NULL,'npx',ARRAY['-y','@modelcontextprotocol/server-mongodb'],'[{"key":"MONGODB_URI","required":true}]'::jsonb,'🍃','https://www.mongodb.com/docs',false),
('Obsidian','obsidian','Read and write Obsidian vault notes.','Productivity','stdio',NULL,'npx',ARRAY['-y','mcp-obsidian','/path/to/vault'],'[]'::jsonb,'🟣','https://obsidian.md',false)
ON CONFLICT (slug) DO NOTHING;
