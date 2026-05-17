-- Public read-only view of Atlas closed trades — no PII, no user_id
-- Enables the proof-first strategy: verifiable public track record

DROP VIEW IF EXISTS public.atlas_public_ledger;

CREATE VIEW public.atlas_public_ledger AS
SELECT
  id,
  symbol,
  asset_class,
  direction,
  entry_price,
  exit_price,
  quantity,
  broker,
  status,
  pnl_usd,
  pnl_pct,
  thesis,
  opened_at,
  closed_at
FROM public.trade_ledger
WHERE status = 'closed'
  AND pnl_usd IS NOT NULL
ORDER BY closed_at DESC;

GRANT SELECT ON public.atlas_public_ledger TO anon;
GRANT SELECT ON public.atlas_public_ledger TO authenticated;
