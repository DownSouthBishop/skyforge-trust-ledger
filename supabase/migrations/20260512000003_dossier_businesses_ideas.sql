-- Phase B/D: Multi-business tracking + ideas pipeline in forge_dossier

ALTER TABLE public.forge_dossier
  ADD COLUMN IF NOT EXISTS businesses JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS active_ideas JSONB DEFAULT '[]'::jsonb;

-- businesses structure (maintained by dossier extraction):
-- [{ name, trade, phase, current_focus, revenue_pattern, last_discussed }]

-- active_ideas structure (maintained by dossier extraction):
-- [{ name, stage: "raw"|"exploring"|"testing"|"executing", notes, last_discussed }]
