-- Circuit breaker: DB-level 5% daily loss limit on trade_ledger
-- An LLM can be convinced to ignore a prompt rule. A Postgres trigger cannot.

CREATE OR REPLACE FUNCTION public.check_daily_loss_limit()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  _starting_balance NUMERIC;
  _today_realized   NUMERIC;
  _drawdown_pct     NUMERIC;
BEGIN
  -- Only fire on status → 'closed' transitions
  IF NEW.status <> 'closed' OR OLD.status = 'closed' THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(balance_usd, 10000) INTO _starting_balance
  FROM public.trading_accounts
  WHERE user_id = NEW.user_id AND is_active = true
  ORDER BY created_at DESC LIMIT 1;

  SELECT COALESCE(SUM(pnl_usd), 0) INTO _today_realized
  FROM public.trade_ledger
  WHERE user_id = NEW.user_id
    AND status = 'closed'
    AND closed_at >= CURRENT_DATE
    AND id <> NEW.id;

  _drawdown_pct := (_today_realized + COALESCE(NEW.pnl_usd, 0)) / NULLIF(_starting_balance, 0);

  IF _drawdown_pct < -0.05 THEN
    RAISE EXCEPTION 'CIRCUIT_BREAKER: Daily loss limit (5%%) breached. Realized: $%. Balance: $%.',
      ROUND((_today_realized + COALESCE(NEW.pnl_usd, 0))::NUMERIC, 2),
      ROUND(_starting_balance::NUMERIC, 2);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS atlas_daily_loss_circuit_breaker ON public.trade_ledger;

CREATE TRIGGER atlas_daily_loss_circuit_breaker
  BEFORE UPDATE ON public.trade_ledger
  FOR EACH ROW EXECUTE FUNCTION public.check_daily_loss_limit();
