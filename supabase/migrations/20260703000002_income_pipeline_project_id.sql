-- ProjectWarRoomPage.tsx filters income_pipeline by project_id client-side, but
-- that column never existed -- the filter always returned empty, silently
-- hiding pipeline data that does exist. Adding it so entries can actually be
-- tagged to a project.

ALTER TABLE public.income_pipeline
  ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES public.business_projects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_income_pipeline_project ON public.income_pipeline (project_id);
