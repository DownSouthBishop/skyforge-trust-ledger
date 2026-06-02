-- Prediction-outcome logging across ALL agents
-- Every consequential agent action gets a prediction before it
-- and an outcome logged after. This is the calibration dataset.

CREATE TABLE IF NOT EXISTS public.agent_predictions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        uuid NOT NULL REFERENCES public.skyforge_agents(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id      uuid REFERENCES public.agent_sessions(id),

  action_type     text NOT NULL,
  action_context  jsonb NOT NULL,

  predicted_outcome   text NOT NULL,
  confidence_score    numeric(3,2) NOT NULL CHECK (confidence_score BETWEEN 0 AND 1),
  predicted_metric    text,
  predicted_value     numeric,
  predicted_timeline_hours int,

  actual_outcome      text,
  actual_metric       numeric,
  outcome_logged_at   timestamptz,
  outcome_source      text,

  calibration_score   numeric(3,2),
  escalated           boolean DEFAULT false,

  created_at          timestamptz DEFAULT now()
);

ALTER TABLE public.agent_predictions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own predictions"
  ON public.agent_predictions FOR ALL
  USING (auth.uid() = user_id);

CREATE INDEX idx_predictions_agent ON public.agent_predictions (agent_id, created_at DESC);
CREATE INDEX idx_predictions_pending ON public.agent_predictions (agent_id, outcome_logged_at)
  WHERE outcome_logged_at IS NULL;
CREATE INDEX idx_predictions_action ON public.agent_predictions (agent_id, action_type);
