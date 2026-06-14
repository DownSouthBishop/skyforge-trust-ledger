-- ============ Atlas Capability Manager + Browser Autonomy ============

-- 1. Capability Registry
CREATE TABLE public.atlas_capabilities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('mcp','api','tool','browser')),
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','installed','disabled','deprecated','pending_approval')),
  version TEXT,
  permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
  trust_score NUMERIC NOT NULL DEFAULT 50,
  source_url TEXT,
  description TEXT,
  vault_ref TEXT,           -- name of the secret/vault entry it depends on
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_used TIMESTAMPTZ,
  installed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.atlas_capabilities TO authenticated;
GRANT ALL ON public.atlas_capabilities TO service_role;
ALTER TABLE public.atlas_capabilities ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own caps" ON public.atlas_capabilities FOR ALL USING (auth.uid()=user_id) WITH CHECK (auth.uid()=user_id);
CREATE TRIGGER trg_atlas_capabilities_updated BEFORE UPDATE ON public.atlas_capabilities
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 2. Secure Vault — metadata only. Real secrets live in Lovable Cloud env.
CREATE TABLE public.atlas_vault (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,           -- human name e.g. "Alpaca live key"
  secret_name TEXT NOT NULL,     -- env var name in Lovable Cloud, e.g. ALPACA_API_KEY
  kind TEXT NOT NULL CHECK (kind IN ('api_key','oauth_token','mcp_config','other')),
  scope TEXT,                    -- e.g. "read_only", "trading", "email"
  capability_id UUID REFERENCES public.atlas_capabilities(id) ON DELETE SET NULL,
  last_used TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, secret_name)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.atlas_vault TO authenticated;
GRANT ALL ON public.atlas_vault TO service_role;
ALTER TABLE public.atlas_vault ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own vault" ON public.atlas_vault FOR ALL USING (auth.uid()=user_id) WITH CHECK (auth.uid()=user_id);
CREATE TRIGGER trg_atlas_vault_updated BEFORE UPDATE ON public.atlas_vault
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 3. Receipts — every Atlas action
CREATE TABLE public.atlas_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agent TEXT NOT NULL DEFAULT 'atlas',
  objective TEXT,
  action TEXT NOT NULL,
  reason TEXT,
  result TEXT,
  outcome TEXT CHECK (outcome IN ('success','failure','partial','pending','denied')),
  financial_impact NUMERIC DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.atlas_receipts TO authenticated;
GRANT ALL ON public.atlas_receipts TO service_role;
ALTER TABLE public.atlas_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own receipts" ON public.atlas_receipts FOR ALL USING (auth.uid()=user_id) WITH CHECK (auth.uid()=user_id);
CREATE INDEX atlas_receipts_user_time ON public.atlas_receipts (user_id, created_at DESC);

-- 4. Approval queue
CREATE TABLE public.atlas_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agent TEXT NOT NULL DEFAULT 'atlas',
  category TEXT NOT NULL,          -- purchase|payment|email|account_create|account_delete|credential_change|file_delete|software_install|browser_caution|capability_install|other
  summary TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','expired')),
  decided_at TIMESTAMPTZ,
  decided_note TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.atlas_approvals TO authenticated;
GRANT ALL ON public.atlas_approvals TO service_role;
ALTER TABLE public.atlas_approvals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own approvals" ON public.atlas_approvals FOR ALL USING (auth.uid()=user_id) WITH CHECK (auth.uid()=user_id);
CREATE TRIGGER trg_atlas_approvals_updated BEFORE UPDATE ON public.atlas_approvals
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE INDEX atlas_approvals_user_status ON public.atlas_approvals (user_id, status, created_at DESC);

-- 5. Browser command queue — local Playwright worker polls this
CREATE TABLE public.atlas_browser_commands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  command TEXT NOT NULL,           -- navigate|search|extract|screenshot|click|type|upload|download
  args JSONB NOT NULL DEFAULT '{}'::jsonb,
  risk TEXT NOT NULL DEFAULT 'safe' CHECK (risk IN ('safe','caution','restricted')),
  approval_id UUID REFERENCES public.atlas_approvals(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','cancelled','awaiting_approval')),
  result JSONB,
  error TEXT,
  receipt_id UUID REFERENCES public.atlas_receipts(id) ON DELETE SET NULL,
  worker_id TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.atlas_browser_commands TO authenticated;
GRANT ALL ON public.atlas_browser_commands TO service_role;
ALTER TABLE public.atlas_browser_commands ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own browser cmds" ON public.atlas_browser_commands FOR ALL USING (auth.uid()=user_id) WITH CHECK (auth.uid()=user_id);
CREATE TRIGGER trg_atlas_browser_updated BEFORE UPDATE ON public.atlas_browser_commands
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE INDEX atlas_browser_cmds_user_status ON public.atlas_browser_commands (user_id, status, created_at DESC);
