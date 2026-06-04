ALTER TABLE public.forge_subjects ADD COLUMN IF NOT EXISTS teacher text DEFAULT 'janus' CHECK (teacher IN ('janus','atlas','linda'));
UPDATE public.forge_subjects SET teacher = 'janus' WHERE teacher IS NULL;

CREATE TABLE IF NOT EXISTS public.forge_quizzes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  subject_id uuid NOT NULL REFERENCES public.forge_subjects(id) ON DELETE CASCADE,
  lesson_id uuid REFERENCES public.forge_lessons(id) ON DELETE CASCADE,
  quiz_type text DEFAULT 'lesson_check',
  questions jsonb NOT NULL DEFAULT '[]',
  score numeric(3,2),
  passed boolean,
  completed boolean DEFAULT false,
  completed_at timestamptz,
  created_at timestamptz DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.forge_quizzes TO authenticated;
GRANT ALL ON public.forge_quizzes TO service_role;
ALTER TABLE public.forge_quizzes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own quizzes" ON public.forge_quizzes;
CREATE POLICY "Users manage own quizzes" ON public.forge_quizzes FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.forge_quiz_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  quiz_id uuid NOT NULL REFERENCES public.forge_quizzes(id) ON DELETE CASCADE,
  question_index int NOT NULL,
  question_text text NOT NULL,
  user_answer text NOT NULL,
  correct_answer text NOT NULL,
  is_correct boolean NOT NULL,
  janus_explanation text,
  created_at timestamptz DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.forge_quiz_responses TO authenticated;
GRANT ALL ON public.forge_quiz_responses TO service_role;
ALTER TABLE public.forge_quiz_responses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own quiz responses" ON public.forge_quiz_responses;
CREATE POLICY "Users manage own quiz responses" ON public.forge_quiz_responses FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

ALTER TABLE public.telegram_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role manages telegram sessions" ON public.telegram_sessions;
CREATE POLICY "Service role manages telegram sessions" ON public.telegram_sessions FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');