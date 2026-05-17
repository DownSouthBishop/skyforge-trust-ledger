-- Atlas state for market regime
CREATE TABLE IF NOT EXISTS public.atlas_state (
  id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id          uuid REFERENCES auth.users ON DELETE CASCADE,
  regime           text NOT NULL,
  confidence_score numeric,
  detected_at      timestamptz DEFAULT now(),
  indicators_json  jsonb
);
ALTER TABLE public.atlas_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "atlas_state_own" ON public.atlas_state FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Strategy weights from counterfactual analysis
CREATE TABLE IF NOT EXISTS public.atlas_strategy_weights (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id       uuid REFERENCES auth.users ON DELETE CASCADE,
  setup_type    text NOT NULL,
  confidence    numeric DEFAULT 0.5,
  sample_count  integer DEFAULT 0,
  last_updated  timestamptz DEFAULT now()
);
ALTER TABLE public.atlas_strategy_weights ENABLE ROW LEVEL SECURITY;
CREATE POLICY "strategy_weights_own" ON public.atlas_strategy_weights FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Knowledge graph nodes
CREATE TABLE IF NOT EXISTS public.atlas_knowledge_nodes (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id         uuid REFERENCES auth.users ON DELETE CASCADE,
  entity_type     text NOT NULL,
  entity_name     text NOT NULL,
  properties_json jsonb
);
ALTER TABLE public.atlas_knowledge_nodes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "knowledge_nodes_own" ON public.atlas_knowledge_nodes FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Knowledge graph edges
CREATE TABLE IF NOT EXISTS public.atlas_knowledge_edges (
  id                uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  source_node_id    uuid REFERENCES public.atlas_knowledge_nodes ON DELETE CASCADE,
  target_node_id    uuid REFERENCES public.atlas_knowledge_nodes ON DELETE CASCADE,
  relationship_type text NOT NULL,
  weight            numeric DEFAULT 1.0,
  last_updated      timestamptz DEFAULT now()
);

-- Expand atlas_tasks constraints to support new task types and statuses
-- Drop and recreate check constraints to add opportunity_candidate and news_alert types
ALTER TABLE public.atlas_tasks
  DROP CONSTRAINT IF EXISTS atlas_tasks_task_type_check;

ALTER TABLE public.atlas_tasks
  ADD CONSTRAINT atlas_tasks_task_type_check
  CHECK (task_type IN (
    'research', 'patrol', 'morning_brief', 'trade_check',
    'forex_scan', 'watchlist_patrol', 'news_alert', 'opportunity_candidate'
  ));

ALTER TABLE public.atlas_tasks
  DROP CONSTRAINT IF EXISTS atlas_tasks_status_check;

ALTER TABLE public.atlas_tasks
  ADD CONSTRAINT atlas_tasks_status_check
  CHECK (status IN (
    'queued', 'running', 'done', 'failed',
    'active', 'monitoring', 'rejected', 'completed'
  ));
