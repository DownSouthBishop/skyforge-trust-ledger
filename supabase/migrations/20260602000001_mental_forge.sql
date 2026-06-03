-- Mental Forge Chamber — Janus teacher portal
-- Subjects, lessons, quizzes, and quiz responses

CREATE TABLE IF NOT EXISTS public.forge_subjects (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name            text NOT NULL,
  description     text,
  category        text,
  status          text DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'completed')),
  lesson_count    int DEFAULT 0,
  current_lesson  int DEFAULT 1,
  mastery_score   numeric(3,2) DEFAULT 0,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

ALTER TABLE public.forge_subjects ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own subjects"
  ON public.forge_subjects FOR ALL USING (auth.uid() = user_id);
CREATE INDEX idx_forge_subjects_user ON public.forge_subjects (user_id, status);

-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.forge_lessons (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  subject_id      uuid NOT NULL REFERENCES public.forge_subjects(id) ON DELETE CASCADE,
  lesson_number   int NOT NULL,
  title           text,
  content         text NOT NULL,
  key_concepts    text[] DEFAULT '{}',
  difficulty      text DEFAULT 'beginner'
    CHECK (difficulty IN ('beginner', 'intermediate', 'advanced')),
  completed       boolean DEFAULT false,
  completed_at    timestamptz,
  created_at      timestamptz DEFAULT now(),
  UNIQUE (subject_id, lesson_number)
);

ALTER TABLE public.forge_lessons ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own lessons"
  ON public.forge_lessons FOR ALL USING (auth.uid() = user_id);
CREATE INDEX idx_forge_lessons_subject ON public.forge_lessons (subject_id, lesson_number);

-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.forge_quizzes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  subject_id      uuid NOT NULL REFERENCES public.forge_subjects(id) ON DELETE CASCADE,
  lesson_id       uuid REFERENCES public.forge_lessons(id) ON DELETE CASCADE,
  quiz_type       text DEFAULT 'lesson_check'
    CHECK (quiz_type IN ('lesson_check', 'chapter_test', 'mastery_exam')),
  questions       jsonb NOT NULL DEFAULT '[]',
  score           numeric(3,2),
  passed          boolean,
  completed       boolean DEFAULT false,
  completed_at    timestamptz,
  created_at      timestamptz DEFAULT now()
);

ALTER TABLE public.forge_quizzes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own quizzes"
  ON public.forge_quizzes FOR ALL USING (auth.uid() = user_id);
CREATE INDEX idx_forge_quizzes_subject ON public.forge_quizzes (subject_id, created_at DESC);
CREATE INDEX idx_forge_quizzes_lesson ON public.forge_quizzes (lesson_id);

-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.forge_quiz_responses (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  quiz_id             uuid NOT NULL REFERENCES public.forge_quizzes(id) ON DELETE CASCADE,
  question_index      int NOT NULL,
  question_text       text NOT NULL,
  user_answer         text NOT NULL,
  correct_answer      text NOT NULL,
  is_correct          boolean NOT NULL,
  janus_explanation   text,
  created_at          timestamptz DEFAULT now()
);

ALTER TABLE public.forge_quiz_responses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own quiz responses"
  ON public.forge_quiz_responses FOR ALL USING (auth.uid() = user_id);
CREATE INDEX idx_forge_quiz_responses_quiz ON public.forge_quiz_responses (quiz_id, question_index);

-- Auto updated_at
CREATE OR REPLACE FUNCTION public.touch_forge_subjects()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$
LANGUAGE plpgsql;

CREATE TRIGGER forge_subjects_updated
  BEFORE UPDATE ON public.forge_subjects
  FOR EACH ROW EXECUTE FUNCTION public.touch_forge_subjects();
