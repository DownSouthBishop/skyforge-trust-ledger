-- Backfill teacher column: rows created before the teacher column existed default to janus
UPDATE public.forge_subjects
  SET teacher = 'janus'
  WHERE teacher IS NULL;
