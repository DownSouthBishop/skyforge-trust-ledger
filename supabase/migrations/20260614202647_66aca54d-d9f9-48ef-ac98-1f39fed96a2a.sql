
-- business_projects
CREATE TABLE public.business_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  website text,
  mission text,
  goal_revenue_usd numeric,
  goal_deadline date,
  status text DEFAULT 'active',
  created_at timestamptz DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.business_projects TO authenticated;
GRANT ALL ON public.business_projects TO service_role;
ALTER TABLE public.business_projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own projects" ON public.business_projects FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- project_onboarding
CREATE TABLE public.project_onboarding (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES public.business_projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  customer_description text,
  problem_solved text,
  revenue_model text,
  what_was_tried text,
  win_in_90_days text,
  created_at timestamptz DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.project_onboarding TO authenticated;
GRANT ALL ON public.project_onboarding TO service_role;
ALTER TABLE public.project_onboarding ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own onboarding" ON public.project_onboarding FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- project_clients
CREATE TABLE public.project_clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES public.business_projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  name text, company text, email text,
  status text DEFAULT 'active',
  revenue_usd numeric DEFAULT 0,
  notes text,
  created_at timestamptz DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.project_clients TO authenticated;
GRANT ALL ON public.project_clients TO service_role;
ALTER TABLE public.project_clients ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own pclients" ON public.project_clients FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- project_leads
CREATE TABLE public.project_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES public.business_projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  name text, company text, email text,
  temperature text DEFAULT 'cold',
  source text, notes text,
  created_at timestamptz DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.project_leads TO authenticated;
GRANT ALL ON public.project_leads TO service_role;
ALTER TABLE public.project_leads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own pleads" ON public.project_leads FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- project_financials
CREATE TABLE public.project_financials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES public.business_projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  entry_type text NOT NULL,
  amount_usd numeric NOT NULL,
  description text,
  date date DEFAULT current_date,
  created_at timestamptz DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.project_financials TO authenticated;
GRANT ALL ON public.project_financials TO service_role;
ALTER TABLE public.project_financials ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own pfin" ON public.project_financials FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- project_bottlenecks
CREATE TABLE public.project_bottlenecks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES public.business_projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  description text NOT NULL,
  severity text DEFAULT 'medium',
  resolved boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.project_bottlenecks TO authenticated;
GRANT ALL ON public.project_bottlenecks TO service_role;
ALTER TABLE public.project_bottlenecks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own pbottle" ON public.project_bottlenecks FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- project_memory
CREATE TABLE public.project_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES public.business_projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  agent text NOT NULL,
  content text NOT NULL,
  memory_type text DEFAULT 'conversation',
  created_at timestamptz DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.project_memory TO authenticated;
GRANT ALL ON public.project_memory TO service_role;
ALTER TABLE public.project_memory ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own pmem" ON public.project_memory FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

ALTER PUBLICATION supabase_realtime ADD TABLE public.project_memory;
