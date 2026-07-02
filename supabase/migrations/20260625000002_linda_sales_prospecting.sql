-- Linda's B2B sales-prospecting extension — company research, contacts,
-- structured qualification, competitive intel, deal/proposal tracking, ICP.
-- Builds on the existing linda_leads pipeline from 20260601000006_linda_domain.sql.

CREATE TABLE IF NOT EXISTS public.linda_companies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  lead_id         uuid REFERENCES public.linda_leads(id),

  name            text NOT NULL,
  website         text,
  industry        text,
  employee_count  text,
  revenue_estimate text,
  hq_location     text,
  description     text,
  source_notes    text,
  researched_at   timestamptz,

  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

ALTER TABLE public.linda_companies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own companies" ON public.linda_companies;
CREATE POLICY "Users manage own companies"
  ON public.linda_companies FOR ALL USING (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS idx_linda_companies_lead ON public.linda_companies (lead_id);

-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.linda_contacts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  lead_id         uuid REFERENCES public.linda_leads(id),
  company_id      uuid REFERENCES public.linda_companies(id),

  full_name       text NOT NULL,
  title           text,
  email           text,
  phone           text,
  linkedin_url    text,
  role_type       text CHECK (role_type IN ('buyer', 'champion', 'influencer', 'blocker', 'user')),
  notes           text,

  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

ALTER TABLE public.linda_contacts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own contacts" ON public.linda_contacts;
CREATE POLICY "Users manage own contacts"
  ON public.linda_contacts FOR ALL USING (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS idx_linda_contacts_lead ON public.linda_contacts (lead_id);
CREATE INDEX IF NOT EXISTS idx_linda_contacts_company ON public.linda_contacts (company_id);

-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.linda_qualifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  lead_id         uuid NOT NULL REFERENCES public.linda_leads(id),

  framework       text DEFAULT 'bant' CHECK (framework IN ('bant', 'meddic')),
  scores          jsonb NOT NULL DEFAULT '{}',
  overall_score   numeric(3,2),
  summary         text,

  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

ALTER TABLE public.linda_qualifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own qualifications" ON public.linda_qualifications;
CREATE POLICY "Users manage own qualifications"
  ON public.linda_qualifications FOR ALL USING (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS idx_linda_qualifications_lead ON public.linda_qualifications (lead_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.linda_competitors (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  lead_id         uuid REFERENCES public.linda_leads(id),

  name            text NOT NULL,
  strengths       text,
  weaknesses      text,
  win_loss_notes  text,

  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

ALTER TABLE public.linda_competitors ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own competitors" ON public.linda_competitors;
CREATE POLICY "Users manage own competitors"
  ON public.linda_competitors FOR ALL USING (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS idx_linda_competitors_lead ON public.linda_competitors (lead_id);

-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.linda_deals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  lead_id         uuid NOT NULL REFERENCES public.linda_leads(id),

  deal_value      numeric,
  stage           text DEFAULT 'proposal' CHECK (stage IN ('proposal', 'negotiation', 'won', 'lost')),
  proposal_content text,
  proposal_sent_at timestamptz,
  expected_close_date date,
  closed_at       timestamptz,
  notes           text,

  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

ALTER TABLE public.linda_deals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own deals" ON public.linda_deals;
CREATE POLICY "Users manage own deals"
  ON public.linda_deals FOR ALL USING (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS idx_linda_deals_lead ON public.linda_deals (lead_id);
CREATE INDEX IF NOT EXISTS idx_linda_deals_stage ON public.linda_deals (user_id, stage);

-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.linda_icp (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  name            text NOT NULL,
  criteria        jsonb NOT NULL DEFAULT '{}',
  is_active       boolean DEFAULT true,

  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

ALTER TABLE public.linda_icp ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own ICPs" ON public.linda_icp;
CREATE POLICY "Users manage own ICPs"
  ON public.linda_icp FOR ALL USING (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS idx_linda_icp_active ON public.linda_icp (user_id) WHERE is_active = true;

-- ─────────────────────────────────────────────────────────────────
-- Reuses public.touch_updated_at() defined in 20260601000006_linda_domain.sql

DROP TRIGGER IF EXISTS linda_companies_updated ON public.linda_companies;
CREATE TRIGGER linda_companies_updated
  BEFORE UPDATE ON public.linda_companies
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS linda_contacts_updated ON public.linda_contacts;
CREATE TRIGGER linda_contacts_updated
  BEFORE UPDATE ON public.linda_contacts
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS linda_qualifications_updated ON public.linda_qualifications;
CREATE TRIGGER linda_qualifications_updated
  BEFORE UPDATE ON public.linda_qualifications
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS linda_competitors_updated ON public.linda_competitors;
CREATE TRIGGER linda_competitors_updated
  BEFORE UPDATE ON public.linda_competitors
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS linda_deals_updated ON public.linda_deals;
CREATE TRIGGER linda_deals_updated
  BEFORE UPDATE ON public.linda_deals
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS linda_icp_updated ON public.linda_icp;
CREATE TRIGGER linda_icp_updated
  BEFORE UPDATE ON public.linda_icp
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
