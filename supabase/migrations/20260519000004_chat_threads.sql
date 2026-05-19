-- chat_threads: persistent conversation threads for Atlas and agent chats.
-- Each row is one named thread; messages are stored as a JSONB array.

create table if not exists public.chat_threads (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete cascade not null,
  agent_slug  text not null default 'atlas',
  title       text not null default 'New conversation',
  messages    jsonb not null default '[]',
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

alter table public.chat_threads enable row level security;

create policy "Users manage own threads"
  on public.chat_threads
  for all
  using (auth.uid() = user_id);

create trigger set_chat_thread_updated_at
  before update on public.chat_threads
  for each row execute function public.set_updated_at();

create index chat_threads_user_agent_idx
  on public.chat_threads (user_id, agent_slug, updated_at desc);
