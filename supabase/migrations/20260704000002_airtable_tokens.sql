-- Airtable OAuth token storage
create table if not exists public.airtable_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  access_token  text not null,
  refresh_token text not null,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id)
);

alter table public.airtable_tokens enable row level security;

drop policy if exists "owner_select" on public.airtable_tokens;
create policy "owner_select" on public.airtable_tokens
  for select using (auth.uid() = user_id);

drop policy if exists "owner_insert" on public.airtable_tokens;
create policy "owner_insert" on public.airtable_tokens
  for insert with check (auth.uid() = user_id);

drop policy if exists "owner_update" on public.airtable_tokens;
create policy "owner_update" on public.airtable_tokens
  for update using (auth.uid() = user_id);

drop policy if exists "owner_delete" on public.airtable_tokens;
create policy "owner_delete" on public.airtable_tokens
  for delete using (auth.uid() = user_id);

-- Service role bypass (edge functions use service key)
drop policy if exists "service_all" on public.airtable_tokens;
create policy "service_all" on public.airtable_tokens
  for all using (auth.role() = 'service_role');
