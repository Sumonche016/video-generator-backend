-- Run this in the Supabase SQL Editor after 0003_prompt_overrides.sql.
-- Lets a block have a manually-generated filler clip covering the leftover
-- time when its main Veo clip comes up short of the block's voiceover
-- slice duration (Veo always returns ~8s clips regardless of what's asked).

alter table blocks
  add column if not exists gap_filler_prompt text not null default '',
  add column if not exists gap_filler_attempts jsonb not null default '[]',
  add column if not exists approved_gap_filler_path text;
