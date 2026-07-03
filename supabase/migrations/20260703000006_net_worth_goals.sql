-- Financial HQ premium pass: a net worth goal to track progress against
-- ("grow net worth from nothing"), one row per user.

CREATE TABLE IF NOT EXISTS public.net_worth_goals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  target_amount numeric NOT NULL,
  target_date   date,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.net_worth_goals TO authenticated;
GRANT ALL ON public.net_worth_goals TO service_role;

ALTER TABLE public.net_worth_goals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own_net_worth_goals" ON public.net_worth_goals;
CREATE POLICY "own_net_worth_goals" ON public.net_worth_goals
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
