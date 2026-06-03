
-- ============================================================
-- SHARED OPERATOR MEMORY
-- ============================================================
CREATE TABLE IF NOT EXISTS public.shared_operator_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_agent text NOT NULL,
  memory_type text NOT NULL,
  key text NOT NULL,
  value text NOT NULL,
  context text,
  confidence numeric NOT NULL DEFAULT 1.0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  UNIQUE (user_id, source_agent, key)
);

CREATE INDEX IF NOT EXISTS idx_shared_memory_user_updated
  ON public.shared_operator_memory (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_shared_memory_user_agent
  ON public.shared_operator_memory (user_id, source_agent, updated_at DESC);

ALTER TABLE public.shared_operator_memory ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own memory"
  ON public.shared_operator_memory FOR SELECT
  USING (auth.uid() = user_id);
CREATE POLICY "Users insert own memory"
  ON public.shared_operator_memory FOR INSERT
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own memory"
  ON public.shared_operator_memory FOR UPDATE
  USING (auth.uid() = user_id);
CREATE POLICY "Users delete own memory"
  ON public.shared_operator_memory FOR DELETE
  USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.touch_shared_memory()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS shared_memory_touch ON public.shared_operator_memory;
CREATE TRIGGER shared_memory_touch
  BEFORE UPDATE ON public.shared_operator_memory
  FOR EACH ROW EXECUTE FUNCTION public.touch_shared_memory();

-- ============================================================
-- TELEGRAM SESSIONS (active agent per chat)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.telegram_sessions (
  chat_id text PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  active_agent text NOT NULL DEFAULT 'atlas',
  last_message_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.telegram_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own telegram sessions"
  ON public.telegram_sessions FOR SELECT
  USING (auth.uid() = user_id);

-- ============================================================
-- HELPER: upsert shared memory (used by triggers + edge fns)
-- ============================================================
CREATE OR REPLACE FUNCTION public.upsert_shared_memory(
  _user_id uuid, _source_agent text, _memory_type text,
  _key text, _value text, _context text DEFAULT NULL,
  _confidence numeric DEFAULT 1.0, _expires_at timestamptz DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.shared_operator_memory
    (user_id, source_agent, memory_type, key, value, context, confidence, expires_at)
  VALUES (_user_id, _source_agent, _memory_type, _key, _value, _context, _confidence, _expires_at)
  ON CONFLICT (user_id, source_agent, key) DO UPDATE
    SET value = EXCLUDED.value,
        memory_type = EXCLUDED.memory_type,
        context = COALESCE(EXCLUDED.context, public.shared_operator_memory.context),
        confidence = EXCLUDED.confidence,
        expires_at = EXCLUDED.expires_at,
        updated_at = now();
END $$;

-- ============================================================
-- TRIGGER: dossier updates → memory
-- ============================================================
CREATE OR REPLACE FUNCTION public.dossier_to_memory()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE k text; v text;
BEGIN
  FOREACH k IN ARRAY ARRAY['trade','market','money_beliefs','risk_posture','decision_pattern',
    'current_phase','current_focus','emotional_baseline','risk_tolerance','trading_goals',
    'preferred_asset_classes','max_drawdown_pct','preferred_pairs']
  LOOP
    EXECUTE format('SELECT ($1).%I::text', k) INTO v USING NEW;
    IF v IS NOT NULL AND length(trim(v)) > 0 THEN
      PERFORM public.upsert_shared_memory(
        NEW.user_id, 'system', 'profile',
        'dossier:' || k, v, 'dossier', 1.0, NULL);
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS dossier_memory_sync ON public.forge_dossier;
CREATE TRIGGER dossier_memory_sync
  AFTER INSERT OR UPDATE ON public.forge_dossier
  FOR EACH ROW EXECUTE FUNCTION public.dossier_to_memory();

-- ============================================================
-- TRIGGER: trade ledger → memory
-- ============================================================
CREATE OR REPLACE FUNCTION public.trade_to_memory()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE summary text;
BEGIN
  IF NEW.status = 'closed' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'closed') THEN
    summary := format('Closed %s %s x%s on %s — P&L %s USD%s',
      NEW.direction, NEW.symbol, NEW.quantity, NEW.broker,
      COALESCE(NEW.pnl_usd::text, 'n/a'),
      CASE WHEN NEW.thesis IS NOT NULL THEN ' — thesis: ' || left(NEW.thesis, 200) ELSE '' END);
  ELSE
    summary := format('Opened %s %s x%s @ %s on %s%s',
      NEW.direction, NEW.symbol, NEW.quantity, NEW.entry_price, NEW.broker,
      CASE WHEN NEW.thesis IS NOT NULL THEN ' — thesis: ' || left(NEW.thesis, 200) ELSE '' END);
  END IF;
  PERFORM public.upsert_shared_memory(
    NEW.user_id, 'system', 'event',
    'trade:' || NEW.id::text, summary, 'positions', 1.0, NULL);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trade_memory_sync ON public.trade_ledger;
CREATE TRIGGER trade_memory_sync
  AFTER INSERT OR UPDATE ON public.trade_ledger
  FOR EACH ROW EXECUTE FUNCTION public.trade_to_memory();

-- ============================================================
-- TRIGGER: commitments → memory
-- ============================================================
CREATE OR REPLACE FUNCTION public.commitment_to_memory()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE summary text;
BEGIN
  summary := format('[%s] %s%s', NEW.resolution_status, NEW.description,
    CASE WHEN NEW.target_date IS NOT NULL THEN ' (target ' || NEW.target_date || ')' ELSE '' END);
  PERFORM public.upsert_shared_memory(
    NEW.user_id, 'system', 'commitment',
    'commitment:' || NEW.id::text, summary, 'commitments', 1.0, NULL);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS commitment_memory_sync ON public.forge_commitments;
CREATE TRIGGER commitment_memory_sync
  AFTER INSERT OR UPDATE ON public.forge_commitments
  FOR EACH ROW EXECUTE FUNCTION public.commitment_to_memory();

-- ============================================================
-- TRIGGER: watchlist → memory
-- ============================================================
CREATE OR REPLACE FUNCTION public.watchlist_to_memory()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.upsert_shared_memory(
    NEW.user_id, 'system', 'preference',
    'watchlist:' || NEW.symbol,
    format('Watching %s (%s)%s', NEW.symbol, NEW.asset_class,
      CASE WHEN NEW.notes IS NOT NULL THEN ' — ' || NEW.notes ELSE '' END),
    'markets', 1.0, NULL);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS watchlist_memory_sync ON public.market_watchlist;
CREATE TRIGGER watchlist_memory_sync
  AFTER INSERT ON public.market_watchlist
  FOR EACH ROW EXECUTE FUNCTION public.watchlist_to_memory();

-- ============================================================
-- TRIGGER: alerts marked read → memory
-- ============================================================
CREATE OR REPLACE FUNCTION public.alert_dismiss_to_memory()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.read_at IS NOT NULL AND (OLD.read_at IS NULL) THEN
    PERFORM public.upsert_shared_memory(
      NEW.user_id, 'system', 'event',
      'alert_seen:' || NEW.id::text,
      format('Saw and dismissed alert [%s]: %s', NEW.signal_type, left(NEW.message, 240)),
      'alerts', 0.7,
      now() + interval '30 days');
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS alert_dismiss_memory_sync ON public.forge_alerts;
CREATE TRIGGER alert_dismiss_memory_sync
  AFTER UPDATE ON public.forge_alerts
  FOR EACH ROW EXECUTE FUNCTION public.alert_dismiss_to_memory();
