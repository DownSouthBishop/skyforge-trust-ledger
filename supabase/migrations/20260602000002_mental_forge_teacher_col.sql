-- Add teacher column to forge_subjects so each subject is owned by one teacher
ALTER TABLE public.forge_subjects
  ADD COLUMN IF NOT EXISTS teacher text DEFAULT 'janus'
    CHECK (teacher IN ('janus', 'atlas', 'linda'));

CREATE INDEX IF NOT EXISTS idx_forge_subjects_teacher
  ON public.forge_subjects (user_id, teacher);
