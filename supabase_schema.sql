-- ============================================================
-- Crypto Algo Trader — Supabase Database Schema
-- Run this in the Supabase SQL Editor (supabase.com → your project → SQL Editor)
-- ============================================================

-- Enable UUID extension (usually already on)
create extension if not exists "uuid-ossp";

-- ─── 1. USERS ────────────────────────────────────────────────────────────────
-- Populated automatically by Clerk webhook on signup.
-- We store only the Clerk user_id (string) as the primary key,
-- not an internal UUID, so every table can reference it directly.
create table if not exists public.users (
  id              text primary key,          -- Clerk user_id (e.g. "user_2a3b4c...")
  email           text not null,
  display_name    text,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now(),
  plan            text not null default 'free',  -- 'free' | 'pro' | 'pro_ai'
  is_active       boolean not null default true
);

comment on table public.users is
  'One row per registered user. Populated by Clerk webhook on user.created event.';

-- ─── 2. SUBSCRIPTIONS ────────────────────────────────────────────────────────
create table if not exists public.subscriptions (
  id                  uuid primary key default uuid_generate_v4(),
  user_id             text not null references public.users(id) on delete cascade,
  stripe_customer_id  text,
  stripe_sub_id       text,
  plan                text not null default 'free',
  status              text not null default 'active',  -- 'active' | 'past_due' | 'canceled' | 'trialing'
  current_period_end  timestamptz,
  cancel_at_period_end boolean default false,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);

comment on table public.subscriptions is
  'Stripe subscription state. Updated by Stripe webhooks via Cloud Run /webhook endpoint.';

create index if not exists subscriptions_user_id_idx on public.subscriptions(user_id);
create unique index if not exists subscriptions_stripe_sub_id_idx on public.subscriptions(stripe_sub_id)
  where stripe_sub_id is not null;

-- ─── 3. USER SETTINGS ────────────────────────────────────────────────────────
-- Stores the entire creds JSON object per user.
-- One row per user — upserted on every save.
create table if not exists public.user_settings (
  user_id     text primary key references public.users(id) on delete cascade,
  creds       jsonb not null default '{}'::jsonb,
  updated_at  timestamptz default now()
);

comment on table public.user_settings is
  'Full creds JSON (exchange keys, indicator config, exit rules, etc.) per user.
   Exchange API keys are AES-256 encrypted by the proxy before storage.';

-- ─── 4. TRANSACTIONS ─────────────────────────────────────────────────────────
-- Persistent trade log — survives browser refreshes and session changes.
create table if not exists public.transactions (
  id              uuid primary key default uuid_generate_v4(),
  user_id         text not null references public.users(id) on delete cascade,
  timestamp       timestamptz not null default now(),
  mode            text not null,  -- 'live' | 'sandbox' | 'simulation'
  type            text not null,  -- 'BUY' | 'SELL'
  coin            text not null,
  price           numeric(20, 8),
  qty             numeric(20, 8),
  usd_value       numeric(20, 4),
  pnl             numeric(20, 4),
  fees            numeric(20, 6),
  net_pnl         numeric(20, 4),
  exit_reason     text,
  agent_reasoning text,
  lstm_trend      numeric(8, 4),
  lstm_change_pct numeric(8, 4),
  lstm_vol        numeric(8, 4),
  rf_dir_prob     numeric(8, 4),
  signal_source   text,           -- 'rules' | 'rf' | 'lstm' | 'deepseek'
  created_at      timestamptz default now()
);

comment on table public.transactions is
  'Permanent trade log. Rows are append-only — never updated, only inserted.';

create index if not exists transactions_user_id_idx    on public.transactions(user_id);
create index if not exists transactions_timestamp_idx  on public.transactions(user_id, timestamp desc);
create index if not exists transactions_coin_idx       on public.transactions(user_id, coin);

-- ─── 5. AUDIT LOG ────────────────────────────────────────────────────────────
-- Tracks plan changes, logins, key events for billing disputes or support.
create table if not exists public.audit_log (
  id          uuid primary key default uuid_generate_v4(),
  user_id     text references public.users(id) on delete set null,
  event       text not null,  -- 'plan_upgrade' | 'plan_cancel' | 'settings_save' | 'login' etc.
  metadata    jsonb,
  created_at  timestamptz default now()
);

create index if not exists audit_log_user_id_idx on public.audit_log(user_id);

-- ─── ROW LEVEL SECURITY ──────────────────────────────────────────────────────
-- Each user can only see and modify their own rows.
-- The proxy passes the Clerk user_id via a custom claim or as a parameter;
-- RLS enforces it at the database level — even if the proxy has a bug,
-- users cannot see each other's data.

alter table public.users         enable row level security;
alter table public.subscriptions enable row level security;
alter table public.user_settings enable row level security;
alter table public.transactions  enable row level security;
alter table public.audit_log     enable row level security;

-- Users: read own row only
create policy "users: read own" on public.users
  for select using (id = current_setting('app.current_user_id', true));

create policy "users: update own" on public.users
  for update using (id = current_setting('app.current_user_id', true));

-- Subscriptions: read own
create policy "subscriptions: read own" on public.subscriptions
  for select using (user_id = current_setting('app.current_user_id', true));

-- Settings: full CRUD on own row
create policy "settings: read own"   on public.user_settings
  for select using (user_id = current_setting('app.current_user_id', true));
create policy "settings: upsert own" on public.user_settings
  for insert with check (user_id = current_setting('app.current_user_id', true));
create policy "settings: update own" on public.user_settings
  for update using (user_id = current_setting('app.current_user_id', true));

-- Transactions: insert + read own
create policy "transactions: read own"   on public.transactions
  for select using (user_id = current_setting('app.current_user_id', true));
create policy "transactions: insert own" on public.transactions
  for insert with check (user_id = current_setting('app.current_user_id', true));

-- Audit log: read own (proxy inserts with service role key, bypassing RLS)
create policy "audit: read own" on public.audit_log
  for select using (user_id = current_setting('app.current_user_id', true));

-- ─── SERVICE ROLE HELPER FUNCTION ────────────────────────────────────────────
-- The proxy sets this before any query so RLS knows who is calling.
-- Call: SELECT set_current_user('user_2a3b4c...');
create or replace function public.set_current_user(uid text)
returns void language sql security definer as $$
  select set_config('app.current_user_id', uid, true);
$$;

-- ─── UPDATED_AT TRIGGER ──────────────────────────────────────────────────────
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger users_updated_at
  before update on public.users
  for each row execute function public.touch_updated_at();

create trigger subscriptions_updated_at
  before update on public.subscriptions
  for each row execute function public.touch_updated_at();

create trigger user_settings_updated_at
  before update on public.user_settings
  for each row execute function public.touch_updated_at();

-- ─── PLAN LIMITS VIEW ────────────────────────────────────────────────────────
-- The proxy uses this to enforce tier limits without hardcoding them.
create or replace view public.plan_limits as
select
  'free'   as plan, 1  as max_coins, false as live_trading, false as ai_agent, 0   as max_tx_history
union all
select
  'pro'    as plan, 10 as max_coins, true  as live_trading, false as ai_agent, 5000 as max_tx_history
union all
select
  'pro_ai' as plan, 50 as max_coins, true  as live_trading, true  as ai_agent, 50000 as max_tx_history;
