-- Placement Atlas: database setup. Run once in Supabase → SQL Editor.

-- One row per signed-in student: their answers, statuses, notes and alert settings.
create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  prof jsonb not null default '{}'::jsonb,
  state jsonb not null default '{"status":{},"notes":{}}'::jsonb,
  custom jsonb not null default '{"items":[]}'::jsonb,
  lang text not null default 'en',
  notify_deadlines boolean not null default true,
  notify_new boolean not null default true,
  notify_email boolean not null default true,
  updated_at timestamptz not null default now()
);

-- Devices that have turned on notifications.
create table if not exists public.push_subs (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now()
);

-- What the daily job has already sent, so nobody gets the same alert twice.
create table if not exists public.sent_log (
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,
  item text not null,
  sent_at timestamptz not null default now(),
  primary key (user_id, kind, item)
);

-- Listing ids the daily job has seen, to spot new jobs.
create table if not exists public.known_jobs (
  id text primary key,
  first_seen date not null default current_date
);

alter table public.profiles enable row level security;
alter table public.push_subs enable row level security;
alter table public.sent_log enable row level security;
alter table public.known_jobs enable row level security;

-- Students can only see and change their own rows. sent_log and known_jobs have
-- no policies, so only the daily job (service role) can use them.
drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own devices" on public.push_subs;
create policy "own devices" on public.push_subs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Lets a signed-in student delete their own account and everything linked to it.
create or replace function public.delete_me()
returns void
language sql
security definer
set search_path = public, auth
as $$
  delete from auth.users where id = auth.uid();
$$;
revoke all on function public.delete_me() from public, anon;
grant execute on function public.delete_me() to authenticated;
