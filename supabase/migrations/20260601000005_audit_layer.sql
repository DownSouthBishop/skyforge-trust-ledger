-- Extended audit trail for ALL agent external actions
-- Same HMAC-SHA256 signing pattern as trade_audit_hash

CREATE TABLE IF NOT EXISTS public.agent_action_audit (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        uuid NOT NULL REFERENCES public.skyforge_agents(id),
  user_id         uuid NOT NULL REFERENCES auth.users(id),
  session_id      uuid REFERENCES public.agent_sessions(id),

  action_type     text NOT NULL,
  action_payload  jsonb NOT NULL,
  action_result   jsonb,
  external_ref    text,

  signed_hash     text,

  success         boolean DEFAULT true,
  error_message   text,
  created_at      timestamptz DEFAULT now()
);

ALTER TABLE public.agent_action_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own audit trail"
  ON public.agent_action_audit FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Service role inserts audit"
  ON public.agent_action_audit FOR INSERT
  WITH CHECK (auth.role() = 'service_role');

CREATE INDEX idx_audit_agent ON public.agent_action_audit (agent_id, created_at DESC);
CREATE INDEX idx_audit_action ON public.agent_action_audit (action_type, created_at DESC);

CREATE OR REPLACE FUNCTION public.sign_agent_action()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_key text;
BEGIN
  v_key := current_setting('app.audit_hmac_key', true);
  IF v_key IS NOT NULL AND v_key != '' THEN
    NEW.signed_hash := encode(
      hmac(
        NEW.agent_id::text || NEW.action_type ||
        NEW.action_payload::text || NEW.created_at::text,
        v_key,
        'sha256'
      ),
      'hex'
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_sign_action
  BEFORE INSERT ON public.agent_action_audit
  FOR EACH ROW EXECUTE FUNCTION public.sign_agent_action();
