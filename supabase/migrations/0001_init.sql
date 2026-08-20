-- Run this in the Supabase SQL Editor (Dashboard > SQL Editor) for project
-- ukpefkmymksznllpyhbw before starting the backend. The service role key
-- (kept only in backend/.env, never in the frontend) is used for all
-- reads/writes, so Row Level Security can stay locked down / disabled.

create extension if not exists "pgcrypto";

create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  stage text not null default 'DRAFT'
    check (stage in (
      'DRAFT','PRODUCT_UNDERSTOOD','SCRIPT_ANALYZED','CHARACTERS_APPROVED',
      'BIBLES_GENERATING','BIBLES_APPROVED','LOCKED','VOICEOVER_UPLOADED',
      'BLOCKS_PLANNED','BLOCKS_GENERATING','BLOCKS_APPROVED','ASSEMBLED'
    )),
  dimension text not null default 'YOUTUBE_16_9',
  block_duration_seconds int not null default 8,
  batch_size int not null default 5,

  product_image_paths jsonb not null default '[]',
  product_info_text text not null default '',
  product_understanding_summary text not null default '',
  product_status text not null default 'pending',

  script_text text not null default '',
  script_status text not null default 'pending',

  product_bible jsonb not null default '{"candidatePaths":[],"refinementPrompts":[],"approvedImagePath":null,"status":"pending"}',

  locked_manifest jsonb,

  voiceover_transcript_path text,
  voiceover_mp3_path text,
  voiceover_duration_seconds numeric,

  final_output_path text
);

create table if not exists characters (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  slug text not null,
  description text not null default '',
  source text not null default 'ai' check (source in ('ai', 'human-added')),
  approved boolean not null default false,
  bible jsonb not null default '{"candidatePaths":[],"refinementPrompts":[],"approvedImagePath":null,"status":"pending"}',
  created_at timestamptz not null default now(),
  unique (project_id, slug)
);

create table if not exists blocks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  index int not null,
  start_sec numeric not null,
  end_sec numeric not null,
  transcript_text text not null default '',
  word_timings jsonb not null default '[]',
  veo_prompt text not null default '',
  attached_reference_names jsonb not null default '[]',
  approval_status text not null default 'pending'
    check (approval_status in (
      'pending','prompt_approved','clip_generating','clip_review','approved','rejected'
    )),
  clip_attempts jsonb not null default '[]',
  approved_clip_path text,
  audio_leveling jsonb not null default
    '{"veoClipVolumeDb":null,"voiceoverVolumeDb":null,"duckingApplied":false,"duckingFactor":null}',
  unique (project_id, index)
);

create index if not exists blocks_project_id_idx on blocks(project_id);
create index if not exists characters_project_id_idx on characters(project_id);

-- Storage bucket for all project media (product images, character/product
-- bible images, voiceover mp3, generated clips, final export). Private by
-- default; the backend issues signed URLs to the frontend as needed.
insert into storage.buckets (id, name, public)
values ('project-assets', 'project-assets', false)
on conflict (id) do nothing;
