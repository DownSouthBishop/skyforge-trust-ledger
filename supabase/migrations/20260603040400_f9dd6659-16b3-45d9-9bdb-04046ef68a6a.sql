
CREATE TABLE IF NOT EXISTS public.forge_subjects (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  current_lesson INT NOT NULL DEFAULT 1,
  lesson_count INT NOT NULL DEFAULT 0,
  mastery_score NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.forge_subjects TO authenticated;
GRANT ALL ON public.forge_subjects TO service_role;
ALTER TABLE public.forge_subjects ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users manage own subjects" ON public.forge_subjects FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.forge_lessons (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  subject_id UUID NOT NULL REFERENCES public.forge_subjects(id) ON DELETE CASCADE,
  lesson_number INT NOT NULL,
  title TEXT,
  content TEXT NOT NULL DEFAULT '',
  key_concepts TEXT[] NOT NULL DEFAULT '{}',
  completed BOOLEAN NOT NULL DEFAULT false,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (subject_id, lesson_number)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.forge_lessons TO authenticated;
GRANT ALL ON public.forge_lessons TO service_role;
ALTER TABLE public.forge_lessons ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users manage own lessons" ON public.forge_lessons FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.forge_quizzes (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  subject_id UUID NOT NULL REFERENCES public.forge_subjects(id) ON DELETE CASCADE,
  lesson_id UUID REFERENCES public.forge_lessons(id) ON DELETE CASCADE,
  quiz_type TEXT NOT NULL DEFAULT 'lesson_check',
  questions JSONB NOT NULL DEFAULT '[]'::jsonb,
  score NUMERIC,
  passed BOOLEAN,
  completed BOOLEAN NOT NULL DEFAULT false,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.forge_quizzes TO authenticated;
GRANT ALL ON public.forge_quizzes TO service_role;
ALTER TABLE public.forge_quizzes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users manage own quizzes" ON public.forge_quizzes FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.forge_quiz_responses (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  quiz_id UUID NOT NULL REFERENCES public.forge_quizzes(id) ON DELETE CASCADE,
  question_index INT NOT NULL,
  question_text TEXT NOT NULL,
  user_answer TEXT,
  correct_answer TEXT,
  is_correct BOOLEAN,
  janus_explanation TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.forge_quiz_responses TO authenticated;
GRANT ALL ON public.forge_quiz_responses TO service_role;
ALTER TABLE public.forge_quiz_responses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users manage own quiz responses" ON public.forge_quiz_responses FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_forge_subjects_user ON public.forge_subjects(user_id);
CREATE INDEX IF NOT EXISTS idx_forge_lessons_subject ON public.forge_lessons(subject_id);
CREATE INDEX IF NOT EXISTS idx_forge_quizzes_subject ON public.forge_quizzes(subject_id);
CREATE INDEX IF NOT EXISTS idx_forge_quiz_responses_quiz ON public.forge_quiz_responses(quiz_id);
