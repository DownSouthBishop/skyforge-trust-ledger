-- Decisions logged in the Notebook are read by every agent (see agent-chat's
-- readDecisions), not just the one they were originally attributed to, so
-- requiring an agent selection at log time no longer reflects reality.
ALTER TABLE public.agent_formative_events ALTER COLUMN agent_id DROP NOT NULL;
