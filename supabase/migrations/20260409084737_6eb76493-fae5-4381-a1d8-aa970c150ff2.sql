-- Create verification state enum
CREATE TYPE public.verification_state AS ENUM ('PENDING', 'VERIFIED', 'DISPUTED');

-- Timestamp updater function
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

-- User Profiles table (public identities)
CREATE TABLE public.user_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL DEFAULT '',
  user_bio TEXT DEFAULT '',
  trusted_connections INT DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Profiles are viewable by everyone"
  ON public.user_profiles FOR SELECT USING (true);

CREATE POLICY "Users can insert their own profile"
  ON public.user_profiles FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own profile"
  ON public.user_profiles FOR UPDATE USING (auth.uid() = user_id);

CREATE TRIGGER update_user_profiles_updated_at
  BEFORE UPDATE ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.user_profiles (user_id, full_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'full_name', ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Receipts Ledger (core immutable ledger)
CREATE TABLE public.receipts_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action_id TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  provider_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_id UUID REFERENCES auth.users(id),
  action_description TEXT NOT NULL,
  action_value_usd NUMERIC(12,2) DEFAULT 0,
  verification_state public.verification_state NOT NULL DEFAULT 'PENDING',
  provider_sig TEXT,
  client_sig TEXT,
  location_proof TEXT,
  client_name TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.receipts_ledger ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view verified receipts"
  ON public.receipts_ledger FOR SELECT
  USING (verification_state = 'VERIFIED' OR auth.uid() = provider_id OR auth.uid() = client_id);

CREATE POLICY "Providers can create receipts"
  ON public.receipts_ledger FOR INSERT
  WITH CHECK (auth.uid() = provider_id);

CREATE POLICY "Providers can update own receipts"
  ON public.receipts_ledger FOR UPDATE
  USING (auth.uid() = provider_id OR auth.uid() = client_id);

CREATE TRIGGER update_receipts_ledger_updated_at
  BEFORE UPDATE ON public.receipts_ledger
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Trust Score function
CREATE OR REPLACE FUNCTION public.calculate_trust_score(_user_id UUID)
RETURNS NUMERIC AS $$
DECLARE
  verified_count INT;
  disputed_count INT;
  total_volume NUMERIC;
  score NUMERIC;
BEGIN
  SELECT COUNT(*), COALESCE(SUM(action_value_usd), 0)
  INTO verified_count, total_volume
  FROM public.receipts_ledger
  WHERE provider_id = _user_id AND verification_state = 'VERIFIED';

  SELECT COUNT(*) INTO disputed_count
  FROM public.receipts_ledger
  WHERE provider_id = _user_id AND verification_state = 'DISPUTED';

  IF verified_count = 0 THEN RETURN 50; END IF;

  score := LEAST(100,
    50 + (verified_count * 2) + (total_volume / 1000) - (disputed_count * 10)
  );

  RETURN GREATEST(0, ROUND(score, 1));
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- Directives Daily (placeholder)
CREATE TABLE public.directives_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  directive_text TEXT,
  completed BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.directives_daily ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own directives"
  ON public.directives_daily FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can create own directives"
  ON public.directives_daily FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own directives"
  ON public.directives_daily FOR UPDATE USING (auth.uid() = user_id);
