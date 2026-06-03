-- Agent escalation infrastructure
-- When any agent's confidence falls below its threshold
-- it writes here and waits for human resolution

CREATE TABLE IF NOT EXISTS public.agent_escalations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        uuid NOT NULL REFERENCES public.skyforge_agents(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id      uuid REFERENCES public.agent_sessions(id),
  prediction_id   uuid REFERENCES public.agent_predictions(id),

  action_type         text NOT NULL,
  action_context      jsonb NOT NULL,
  confidence_score    numeric(3,2) NOT NULL,
  confidence_threshold numeric(3,2) NOT NULL,

  known_facts     text,
  unknown_facts   text,
  what_it_needs   text,

  status          text DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'modified')),
  resolved_by     text,
  resolution_note text,
  modified_action jsonb,
  resolved_at     timestamptz,

  notified_via    text DEFAULT 'dashboard',
  notified_at     timestamptz DEFAULT now(),

  created_at      timestamptz DEFAULT now()
);

ALTER TABLE public.agent_escalations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own escalations"
  ON public.agent_escalations FOR ALL USING (auth.uid() = user_id);

CREATE INDEX idx_escalations_pending ON public.agent_escalations
  (user_id, status, created_at DESC) WHERE status = 'pending';
CREATE INDEX idx_escalations_agent ON public.agent_escalations
  (agent_id, created_at DESC);
