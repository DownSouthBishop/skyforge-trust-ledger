-- Linda pipeline extensions: objection-handling script library + inbound reply log.
-- Same RLS + touch_updated_at trigger pattern as every other linda_* table
-- (see 20260625000002_linda_sales_prospecting.sql).

CREATE TABLE IF NOT EXISTS public.linda_objections (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  lead_id           uuid REFERENCES public.linda_leads(id),

  objection_category text CHECK (objection_category IN (
    'price', 'timing', 'trust', 'competitor', 'not_interested', 'need_more_info', 'other'
  )),
  objection_text    text NOT NULL,
  response_used     text NOT NULL,
  outcome           text CHECK (outcome IN ('worked', 'no_response', 'lost')),

  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now()
);

ALTER TABLE public.linda_objections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own objections" ON public.linda_objections;
CREATE POLICY "Users manage own objections"
  ON public.linda_objections FOR ALL USING (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS idx_linda_objections_lead ON public.linda_objections (lead_id);
CREATE INDEX IF NOT EXISTS idx_linda_objections_recent ON public.linda_objections (user_id, created_at DESC);

DROP TRIGGER IF EXISTS linda_objections_updated ON public.linda_objections;
CREATE TRIGGER linda_objections_updated
  BEFORE UPDATE ON public.linda_objections
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ─────────────────────────────────────────────────────────────────
-- Raw inbound email log, written by linda-inbox-sync. Separate from linda_responses
-- (which represents Linda's own outbound drafts) so every inbound message is kept
-- for audit purposes even when it can't be matched to a lead.

CREATE TABLE IF NOT EXISTS public.linda_reply_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  lead_id       uuid REFERENCES public.linda_leads(id),

  from_email    text NOT NULL,
  subject       text,
  body          text,
  message_id    text,
  in_reply_to   text,
  received_at   timestamptz NOT NULL DEFAULT now(),
  matched       boolean NOT NULL DEFAULT false,

  created_at    timestamptz DEFAULT now()
);

ALTER TABLE public.linda_reply_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own reply log" ON public.linda_reply_log;
CREATE POLICY "Users manage own reply log"
  ON public.linda_reply_log FOR ALL USING (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS idx_linda_reply_log_lead ON public.linda_reply_log (lead_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_linda_reply_log_message_id ON public.linda_reply_log (user_id, message_id)
  WHERE message_id IS NOT NULL;
