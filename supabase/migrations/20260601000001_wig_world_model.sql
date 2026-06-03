-- WIG unified world model — every agent reads this on session start
-- Single source of truth for organizational state

CREATE TABLE IF NOT EXISTS public.wig_state (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_at         timestamptz DEFAULT now(),
  capital_total       numeric DEFAULT 0,
  capital_deployed    numeric DEFAULT 0,
  capital_liquid      numeric DEFAULT 0,
  monthly_revenue     numeric DEFAULT 0,
  monthly_expenses    numeric DEFAULT 0,
  net_monthly         numeric GENERATED ALWAYS AS (monthly_revenue - monthly_expenses) STORED,
  active_verticals    jsonb DEFAULT '{}',
  risk_exposure       jsonb DEFAULT '{}',
  agent_statuses      jsonb DEFAULT '{}',
  flags               jsonb DEFAULT '[]',
  updated_by          text NOT NULL DEFAULT 'system',
  created_at          timestamptz DEFAULT now()
);

CREATE INDEX idx_wig_state_snapshot ON public.wig_state (snapshot_at DESC);

ALTER TABLE public.wig_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users read wig_state"
  ON public.wig_state FOR SELECT
  USING (auth.role() = 'authenticated');
CREATE POLICY "Service role manages wig_state"
  ON public.wig_state FOR ALL
  USING (auth.role() = 'service_role');

CREATE OR REPLACE FUNCTION public.get_wig_state()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT row_to_json(w)::jsonb
  FROM public.wig_state w
  ORDER BY snapshot_at DESC
  LIMIT 1;
$$;

-- Seed an initial empty snapshot so get_wig_state() never returns null
INSERT INTO public.wig_state (
  active_verticals, risk_exposure, agent_statuses, flags, updated_by
) VALUES (
  '{"trading": {"status": "active", "revenue_mtd": 0, "active_jobs": 0, "notes": ""},
    "prymalai": {"status": "active", "revenue_mtd": 0, "active_jobs": 0, "notes": ""},
    "book":     {"status": "active", "revenue_mtd": 0, "active_jobs": 0, "notes": ""},
    "realestate": {"status": "watching", "revenue_mtd": 0, "active_jobs": 0, "notes": ""}}'::jsonb,
  '{}'::jsonb,
  '{"atlas": {"last_active": null, "last_outcome": null, "escalations_pending": 0},
    "linda": {"last_active": null, "last_outcome": null, "escalations_pending": 0},
    "janus": {"last_active": null, "last_outcome": null, "escalations_pending": 0}}'::jsonb,
  '[]'::jsonb,
  'system_init'
);
