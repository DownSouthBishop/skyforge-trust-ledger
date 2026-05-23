
-- agent_sessions: replace ALL policy with explicit per-op policies that include WITH CHECK
DROP POLICY IF EXISTS "Users read own sessions" ON public.agent_sessions;
CREATE POLICY "Users select own sessions" ON public.agent_sessions
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users insert own sessions" ON public.agent_sessions
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own sessions" ON public.agent_sessions
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users delete own sessions" ON public.agent_sessions
  FOR DELETE USING (auth.uid() = user_id);

-- forge_commitments: add DELETE; also tighten UPDATE with check
CREATE POLICY "Users can delete own commitments" ON public.forge_commitments
  FOR DELETE USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can update own commitments" ON public.forge_commitments;
CREATE POLICY "Users can update own commitments" ON public.forge_commitments
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- receipts_ledger: remove public read of verified rows; restrict to provider/client
DROP POLICY IF EXISTS "Anyone can view verified receipts" ON public.receipts_ledger;
CREATE POLICY "Provider or client can view receipts" ON public.receipts_ledger
  FOR SELECT TO authenticated
  USING (auth.uid() = provider_id OR auth.uid() = client_id);
DROP POLICY IF EXISTS "Providers can update own receipts" ON public.receipts_ledger;
CREATE POLICY "Providers can update own receipts" ON public.receipts_ledger
  FOR UPDATE TO authenticated
  USING (auth.uid() = provider_id OR auth.uid() = client_id)
  WITH CHECK (auth.uid() = provider_id OR auth.uid() = client_id);

-- telegram_sessions: add INSERT/UPDATE/DELETE
CREATE POLICY "Users insert own telegram sessions" ON public.telegram_sessions
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own telegram sessions" ON public.telegram_sessions
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users delete own telegram sessions" ON public.telegram_sessions
  FOR DELETE USING (auth.uid() = user_id);

-- user_profiles: restrict SELECT to owner only
DROP POLICY IF EXISTS "Profiles are viewable by everyone" ON public.user_profiles;
CREATE POLICY "Users can view own profile" ON public.user_profiles
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can update their own profile" ON public.user_profiles;
CREATE POLICY "Users can update their own profile" ON public.user_profiles
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
