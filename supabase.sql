-- Minimal schema for this project on Supabase
-- Run this in Supabase SQL Editor.

create extension if not exists pgcrypto;

-- This project uses TEXT ids (not UUID). If you previously created UUID tables,
-- either migrate them or recreate for development.

create table if not exists public.jobs (
  id text primary key default (gen_random_uuid()::text),
  type text not null default 'line_message',
  status text not null default 'pending',
  attempts int not null default 0,
  max_attempts int not null default 3,
  next_run_at timestamptz null,
  locked_at timestamptz null,
  lock_id text null,
  source_user_id text not null,
  source_message_text text not null,
  raw_event jsonb null,
  result jsonb null,
  error_message text null,
  error_stack text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists jobs_status_next_run_at_created_at
  on public.jobs (status, next_run_at, created_at);

create table if not exists public.drivers (
  id text primary key default (gen_random_uuid()::text),
  name text not null,
  line_user_id text not null unique,
  active boolean not null default true,
  status text not null default 'available',
  last_assigned_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists drivers_active_status_last_assigned
  on public.drivers (active, status, last_assigned_at);

create table if not exists public.orders (
  id text primary key default (gen_random_uuid()::text),
  user_id text not null,
  from_loc text not null,
  to_loc text not null,
  passengers int not null,
  note text not null default '',
  driver_id text null references public.drivers(id),
  status text not null default 'created',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists orders_status_created_at
  on public.orders (status, created_at desc);

-- Atomic job claim for worker loop (prevents double-processing).
drop function if exists public.claim_job();
create or replace function public.claim_job()
returns public.jobs
language plpgsql
as $$
declare
  j public.jobs;
begin
  with picked as (
    select id
    from public.jobs
    where status = 'pending'
      and (next_run_at is null or next_run_at <= now())
    order by created_at asc
    limit 1
    for update skip locked
  )
  update public.jobs
  set status = 'processing',
      locked_at = now(),
      lock_id = gen_random_uuid()::text,
      updated_at = now()
  where id in (select id from picked)
  returning * into j;

  return j;
end;
$$;

