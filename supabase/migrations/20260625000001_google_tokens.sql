-- Google OAuth token storage
create table if not exists public.google_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  access_token  text not null,
  refresh_token text,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id)
);

alter table public.google_tokens enable row level security;

-- Users can only read/write their own tokens
create policy "owner_select" on public.google_tokens
  for select using (auth.uid() = user_id);

create policy "owner_insert" on public.google_tokens
  for insert with check (auth.uid() = user_id);

create policy "owner_update" on public.google_tokens
  for update using (auth.uid() = user_id);

create policy "owner_delete" on public.google_tokens
  for delete using (auth.uid() = user_id);

-- Service role bypass (edge functions use service key)
create policy "service_all" on public.google_tokens
  for all using (auth.role() = 'service_role');
