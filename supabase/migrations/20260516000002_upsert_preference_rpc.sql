-- RPC for atomic preference upsert with confidence blending

CREATE OR REPLACE FUNCTION public.upsert_atlas_preference(
  _user_id    uuid,
  _category   text,
  _key        text,
  _value      text,
  _confidence numeric,
  _evidence   text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _existing_confidence numeric;
  _new_confidence numeric;
BEGIN
  SELECT confidence INTO _existing_confidence
  FROM public.atlas_user_preferences
  WHERE user_id = _user_id AND category = _category AND key = _key;

  IF _existing_confidence IS NOT NULL THEN
    -- Blend: existing gets weight 0.7, new observation gets 0.3
    -- If same value confirmed again, boost confidence
    _new_confidence := LEAST(0.95, _existing_confidence * 0.7 + _confidence * 0.3 + 0.05);

    UPDATE public.atlas_user_preferences SET
      value             = _value,
      confidence        = _new_confidence,
      evidence          = COALESCE(_evidence, evidence),
      last_confirmed_at = now()
    WHERE user_id = _user_id AND category = _category AND key = _key;
  ELSE
    INSERT INTO public.atlas_user_preferences
      (user_id, category, key, value, confidence, evidence)
    VALUES
      (_user_id, _category, _key, _value, _confidence, _evidence)
    ON CONFLICT (user_id, category, key) DO UPDATE SET
      value             = EXCLUDED.value,
      confidence        = LEAST(0.95, atlas_user_preferences.confidence * 0.7 + EXCLUDED.confidence * 0.3 + 0.05),
      evidence          = COALESCE(EXCLUDED.evidence, atlas_user_preferences.evidence),
      last_confirmed_at = now();
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_atlas_preference(uuid, text, text, text, numeric, text) TO service_role;
