-- Extensions for scheduled jobs
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Add new columns to user_profiles
alter table public.user_profiles
  add column if not exists trajectory_sentence text,
  add column if not exists atlas_relationship_stage integer not null default 1,
  add column if not exists atlas_reengagement_message text,
  add column if not exists last_seen_at timestamptz;

-- Sticky memory table — three preserved facts per operator
create table if not exists public.forge_sticky_memory (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  goal text,
  obstacle text,
  commitment text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (user_id)
);

alter table public.forge_sticky_memory enable row level security;

drop policy if exists "Users can view own sticky memory" on public.forge_sticky_memory;
create policy "Users can view own sticky memory" on public.forge_sticky_memory
  for select using (auth.uid() = user_id);

drop policy if exists "Users can insert own sticky memory" on public.forge_sticky_memory;
create policy "Users can insert own sticky memory" on public.forge_sticky_memory
  for insert with check (auth.uid() = user_id);

drop policy if exists "Users can update own sticky memory" on public.forge_sticky_memory;
create policy "Users can update own sticky memory" on public.forge_sticky_memory
  for update using (auth.uid() = user_id);

drop policy if exists "Users can delete own sticky memory" on public.forge_sticky_memory;
create policy "Users can delete own sticky memory" on public.forge_sticky_memory
  for delete using (auth.uid() = user_id);

create trigger update_forge_sticky_memory_updated_at
  before update on public.forge_sticky_memory
  for each row execute function public.update_updated_at_column();

-- Update get_forge_context to include trajectory, stage, sticky memory, and turn count
create or replace function public.get_forge_context(_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
  v_full_name text;
  v_trust_score numeric;
  v_verified_count int;
  v_pending_count int;
  v_disputed_count int;
  v_total_count int;
  v_total_volume numeric;
  v_completion_rate numeric;
  v_dispute_rate numeric;
  v_current_streak int := 0;
  v_bottleneck text;
  v_recent jsonb;
  v_crm jsonb;
  v_check_date date := current_date;
  v_has_day boolean;
  v_trajectory text;
  v_stage int;
  v_turn_count int;
  v_sticky jsonb;
  v_reengagement text;
begin
  select full_name, trajectory_sentence, atlas_relationship_stage, atlas_reengagement_message
    into v_full_name, v_trajectory, v_stage, v_reengagement
  from public.user_profiles where user_id = _user_id;

  v_trust_score := public.calculate_trust_score(_user_id);

  select
    count(*) filter (where verification_state = 'VERIFIED'),
    count(*) filter (where verification_state = 'PENDING'),
    count(*) filter (where verification_state = 'DISPUTED'),
    count(*),
    coalesce(sum(action_value_usd) filter (where verification_state = 'VERIFIED'), 0)
  into v_verified_count, v_pending_count, v_disputed_count, v_total_count, v_total_volume
  from public.receipts_ledger
  where provider_id = _user_id;

  v_completion_rate := case when v_total_count > 0
    then round((v_verified_count::numeric / v_total_count) * 100, 1) else 0 end;
  v_dispute_rate := case when v_total_count > 0
    then round((v_disputed_count::numeric / v_total_count) * 100, 1) else 0 end;

  loop
    select exists(
      select 1 from public.receipts_ledger
      where provider_id = _user_id
        and verification_state = 'VERIFIED'
        and created_at::date = v_check_date
    ) into v_has_day;
    if v_has_day then
      v_current_streak := v_current_streak + 1;
      v_check_date := v_check_date - 1;
    else
      if v_check_date = current_date then
        v_check_date := v_check_date - 1;
      else
        exit;
      end if;
    end if;
    exit when v_current_streak > 365;
  end loop;

  v_bottleneck := case
    when v_total_count = 0 then 'no_activity'
    when v_pending_count > v_verified_count then 'verification'
    when v_dispute_rate > 10 then 'disputes'
    when v_completion_rate < 50 then 'closing'
    when v_total_volume < 1000 then 'pricing'
    when v_verified_count < 10 then 'volume'
    else 'scale'
  end;

  select coalesce(jsonb_agg(r), '[]'::jsonb) into v_recent
  from (
    select action_description as job, action_value_usd as amount,
           verification_state as state, created_at
    from public.receipts_ledger
    where provider_id = _user_id
    order by created_at desc limit 5
  ) r;

  select coalesce(jsonb_agg(o), '[]'::jsonb) into v_crm
  from (
    select
      client_name,
      last_job_type as last_job,
      case when last_job_date is not null
        then (current_date - last_job_date)
        else null end as days_since_contact,
      case when job_count > 0
        then round(total_spend / job_count, 2)
        else 0 end as estimated_value
    from public.get_crm_opportunities(_user_id)
    limit 3
  ) o;

  select count(*) into v_turn_count from public.forge_messages where user_id = _user_id;

  select jsonb_build_object(
    'goal', goal, 'obstacle', obstacle, 'commitment', commitment
  ) into v_sticky from public.forge_sticky_memory where user_id = _user_id;

  -- Auto-advance stage based on receipts + turns
  v_stage := coalesce(v_stage, 1);
  if v_verified_count > 75 and v_turn_count > 100 then
    v_stage := 3;
  elsif v_verified_count >= 15 and v_turn_count >= 20 then
    v_stage := greatest(v_stage, 2);
  end if;

  return jsonb_build_object(
    'full_name', coalesce(v_full_name, 'Operator'),
    'trust_score', v_trust_score,
    'verified_count', v_verified_count,
    'total_volume', v_total_volume,
    'completion_rate', v_completion_rate,
    'dispute_rate', v_dispute_rate,
    'current_streak', v_current_streak,
    'bottleneck', v_bottleneck,
    'recent_receipts', v_recent,
    'crm_opportunities', v_crm,
    'trajectory_sentence', v_trajectory,
    'relationship_stage', v_stage,
    'turn_count', v_turn_count,
    'sticky_memory', coalesce(v_sticky, '{}'::jsonb),
    'reengagement_message', v_reengagement
  );
end;
$function$;