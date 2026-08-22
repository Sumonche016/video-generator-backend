-- Run this in the Supabase SQL Editor after 0002_app_settings.sql.
-- Stores admin-edited overrides of the app's AI/Veo prompt text so they can
-- be changed from the web app (central Prompts page + per-step panels)
-- instead of editing backend/src/prompt-templates/*.ts and redeploying.
-- Falls back to the hardcoded default in promptRegistry.ts when no override
-- row exists for a key.

create table if not exists prompt_overrides (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
