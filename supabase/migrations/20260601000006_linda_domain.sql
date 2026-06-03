-- Linda's operational domain — PrymalAI and WIG marketing ops

CREATE TABLE IF NOT EXISTS public.linda_leads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  full_name       text NOT NULL,
  business_name   text,
  phone           text,
  email           text,
  city_region     text,

  service_requested text CHECK (service_requested IN (
    'build', 'forge', 'network', 'syndicate', 'marine_site', 'other'
  )),
  notes           text,

  source          text DEFAULT 'prymalai_form',
  utm_source      text,
  utm_campaign    text,

  status          text DEFAULT 'new'
    CHECK (status IN (
      'new', 'responded', 'qualified', 'proposal_sent',
      'negotiating', 'won', 'lost', 'nurturing', 'cold'
    )),
  priority        text DEFAULT 'normal'
    CHECK (priority IN ('hot', 'normal', 'cold')),

  linda_notes     text,
  linda_confidence numeric(3,2),

  converted       boolean,
  converted_at    timestamptz,
  revenue_generated numeric,

  last_contacted_at timestamptz,
  follow_up_at    timestamptz,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

ALTER TABLE public.linda_leads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own leads"
  ON public.linda_leads FOR ALL USING (auth.uid() = user_id);
CREATE INDEX idx_linda_leads_status ON public.linda_leads (user_id, status, created_at DESC);
CREATE INDEX idx_linda_leads_followup ON public.linda_leads (user_id, follow_up_at)
  WHERE follow_up_at IS NOT NULL AND status NOT IN ('won', 'lost');

-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.linda_clients (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  lead_id         uuid REFERENCES public.linda_leads(id),

  business_name   text NOT NULL,
  owner_name      text,
  phone           text,
  email           text,
  city_region     text,
  website         text,

  service_type    text CHECK (service_type IN (
    'build', 'forge', 'network', 'syndicate', 'marine_site', 'bundle'
  )),
  monthly_recurring numeric DEFAULT 0,
  one_time_revenue  numeric DEFAULT 0,
  contract_start  date,
  contract_end    date,
  status          text DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'churned', 'prospect')),

  site_url        text,
  widget_ids      text[],
  network_tier    text,

  linda_notes     text,
  health_score    numeric(3,2) DEFAULT 0.8,
  last_touchpoint timestamptz,
  next_touchpoint timestamptz,

  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

ALTER TABLE public.linda_clients ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own clients"
  ON public.linda_clients FOR ALL USING (auth.uid() = user_id);
CREATE INDEX idx_linda_clients_status ON public.linda_clients (user_id, status);

-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.linda_campaigns (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  title           text NOT NULL,
  content_body    text NOT NULL,
  content_type    text CHECK (content_type IN (
    'linkedin_post', 'facebook_post', 'google_ad',
    'email_outreach', 'sms', 'nextdoor', 'blog'
  )),
  vertical        text CHECK (vertical IN (
    'prymalai', 'marine', 'book', 'wig_general'
  )),
  target_audience text,

  status          text DEFAULT 'draft'
    CHECK (status IN ('draft', 'scheduled', 'published', 'paused', 'archived')),
  scheduled_at    timestamptz,
  published_at    timestamptz,
  platform_ref    text,

  impressions     int DEFAULT 0,
  clicks          int DEFAULT 0,
  form_submissions int DEFAULT 0,
  leads_generated int DEFAULT 0,
  revenue_attributed numeric DEFAULT 0,

  linda_prediction text,
  linda_confidence numeric(3,2),
  performance_rating text CHECK (performance_rating IN (
    'excellent', 'good', 'average', 'poor'
  )),

  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

ALTER TABLE public.linda_campaigns ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own campaigns"
  ON public.linda_campaigns FOR ALL USING (auth.uid() = user_id);
CREATE INDEX idx_linda_campaigns_status ON public.linda_campaigns
  (user_id, status, scheduled_at DESC);

-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.linda_responses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  lead_id         uuid REFERENCES public.linda_leads(id),

  channel         text CHECK (channel IN ('email', 'sms', 'form_reply')),
  subject         text,
  body            text NOT NULL,

  status          text DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending_approval', 'sent', 'failed')),
  approved_by     text,
  sent_at         timestamptz,
  opened_at       timestamptz,
  replied_at      timestamptz,

  linda_confidence numeric(3,2),
  led_to_conversion boolean,

  created_at      timestamptz DEFAULT now()
);

ALTER TABLE public.linda_responses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own responses"
  ON public.linda_responses FOR ALL USING (auth.uid() = user_id);
CREATE INDEX idx_linda_responses_lead ON public.linda_responses (lead_id, created_at DESC);
CREATE INDEX idx_linda_responses_pending ON public.linda_responses (user_id, status)
  WHERE status = 'pending_approval';

-- Auto updated_at triggers
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$
LANGUAGE plpgsql;

CREATE TRIGGER linda_leads_updated
  BEFORE UPDATE ON public.linda_leads
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TRIGGER linda_clients_updated
  BEFORE UPDATE ON public.linda_clients
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TRIGGER linda_campaigns_updated
  BEFORE UPDATE ON public.linda_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
