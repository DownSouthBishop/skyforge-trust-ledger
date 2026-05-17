CREATE TABLE IF NOT EXISTS public.atlas_plays (
  id                uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id           uuid REFERENCES auth.users ON DELETE CASCADE NOT NULL,
  play_type         text NOT NULL,
  title             text NOT NULL,
  description       text,
  status            text NOT NULL DEFAULT 'active',
  capital_deployed  numeric,
  expected_roi_pct  numeric,
  actual_roi_pct    numeric,
  opened_at         timestamptz DEFAULT now(),
  closed_at         timestamptz,
  outcome_notes     text,
  source            text,
  legal_basis       text,
  created_at        timestamptz DEFAULT now()
);

ALTER TABLE public.atlas_plays ENABLE ROW LEVEL SECURITY;

CREATE POLICY "atlas_plays_own" ON public.atlas_plays
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
