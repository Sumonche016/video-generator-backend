-- Run this in the Supabase SQL Editor after 0001_init.sql.
-- Stores API keys (and any other runtime-editable settings) so they can be
-- changed from the web app itself instead of editing backend/.env and
-- redeploying. Values here override the corresponding .env var at runtime;
-- .env stays as the fallback/default when no override has been saved yet.

create table if not exists app_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
