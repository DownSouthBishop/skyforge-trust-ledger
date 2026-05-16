-- Real Estate Vertical — Phase 3A

CREATE TABLE IF NOT EXISTS public.property_pipeline (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  zip TEXT,
  property_type TEXT NOT NULL CHECK (property_type IN ('sfr','multi','commercial','land','mixed')),
  list_price NUMERIC(12,2),
  arv NUMERIC(12,2),
  repair_estimate NUMERIC(12,2),
  purchase_price NUMERIC(12,2),
  down_payment_pct NUMERIC(5,2),
  loan_rate NUMERIC(5,3),
  loan_term_years INTEGER,
  gross_rent_monthly NUMERIC(10,2),
  vacancy_pct NUMERIC(5,2) DEFAULT 8.0,
  operating_expense_pct NUMERIC(5,2) DEFAULT 40.0,
  noi NUMERIC(10,2) GENERATED ALWAYS AS (
    gross_rent_monthly * 12 * (1 - vacancy_pct/100) * (1 - operating_expense_pct/100)
  ) STORED,
  cap_rate NUMERIC(5,2),
  cash_on_cash_return NUMERIC(5,2),
  irr_5yr NUMERIC(5,2),
  stage TEXT NOT NULL DEFAULT 'scanning' CHECK (stage IN ('scanning','analyzing','offer_pending','under_contract','due_diligence','closed','passed')),
  source TEXT,
  listing_url TEXT,
  mls_id TEXT,
  notes TEXT,
  thesis TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.property_pipeline ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users own their property pipeline" ON public.property_pipeline FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS idx_property_pipeline_user_stage ON public.property_pipeline(user_id, stage);

CREATE TABLE IF NOT EXISTS public.property_portfolio (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  property_type TEXT NOT NULL,
  purchase_price NUMERIC(12,2) NOT NULL,
  purchase_date DATE NOT NULL,
  current_value NUMERIC(12,2),
  mortgage_balance NUMERIC(12,2),
  mortgage_rate NUMERIC(5,3),
  mortgage_payment_monthly NUMERIC(10,2),
  gross_rent_monthly NUMERIC(10,2),
  vacancy_pct NUMERIC(5,2) DEFAULT 8.0,
  operating_expense_pct NUMERIC(5,2) DEFAULT 40.0,
  property_manager TEXT,
  property_manager_fee_pct NUMERIC(5,2),
  management_platform TEXT,
  management_platform_unit_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','vacant','for_sale','sold')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.property_portfolio ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users own their portfolio" ON public.property_portfolio FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.property_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  property_id UUID NOT NULL REFERENCES public.property_portfolio(id) ON DELETE CASCADE,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('rent','expense','maintenance','mortgage','insurance','tax','capex')),
  description TEXT NOT NULL,
  amount_usd NUMERIC(10,2) NOT NULL,
  due_date DATE,
  paid_date DATE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','overdue','waived')),
  vendor TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.property_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users own their property ledger" ON public.property_ledger FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS idx_property_ledger_property ON public.property_ledger(property_id, entry_type, created_at DESC);

CREATE TABLE IF NOT EXISTS public.lease_tracker (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  property_id UUID NOT NULL REFERENCES public.property_portfolio(id) ON DELETE CASCADE,
  tenant_name TEXT NOT NULL,
  tenant_email TEXT,
  tenant_phone TEXT,
  lease_start DATE NOT NULL,
  lease_end DATE NOT NULL,
  monthly_rent NUMERIC(10,2) NOT NULL,
  security_deposit NUMERIC(10,2),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','terminated','month_to_month')),
  renewal_offered BOOLEAN NOT NULL DEFAULT false,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.lease_tracker ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users own lease tracker" ON public.lease_tracker FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS idx_lease_tracker_expiry ON public.lease_tracker(user_id, lease_end, status);
