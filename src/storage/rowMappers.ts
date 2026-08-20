import type { Project, ProjectStage, VideoDimension, BibleAsset, LockedRef } from "../models/index.js";

// snake_case DB row shape <-> camelCase Project used by the rest of the app.
export interface ProjectRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  stage: ProjectStage;
  dimension: VideoDimension;
  block_duration_seconds: number;
  batch_size: number;
  product_image_paths: string[];
  product_info_text: string;
  product_understanding_summary: string;
  product_status: "pending" | "understood";
  script_text: string;
  script_status: "pending" | "analyzed";
  product_bible: BibleAsset;
  locked_manifest: LockedRef[] | null;
  voiceover_transcript_path: string | null;
  voiceover_mp3_path: string | null;
  voiceover_duration_seconds: number | null;
  final_output_path: string | null;
}

export function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stage: row.stage,
    dimension: row.dimension,
    settings: {
      blockDurationSeconds: row.block_duration_seconds,
      batchSize: row.batch_size,
    },
    product: {
      imagePaths: row.product_image_paths,
      infoText: row.product_info_text,
      understandingSummary: row.product_understanding_summary,
      status: row.product_status,
    },
    script: {
      text: row.script_text,
      status: row.script_status,
    },
    characters: [],
    bibles: { product: row.product_bible },
    lockedManifest: row.locked_manifest,
    voiceover:
      row.voiceover_mp3_path && row.voiceover_transcript_path
        ? {
            transcriptPath: row.voiceover_transcript_path,
            mp3Path: row.voiceover_mp3_path,
            durationSeconds: row.voiceover_duration_seconds ?? 0,
          }
        : null,
    blockList: [],
    finalOutputPath: row.final_output_path,
  };
}

export function projectToRowPatch(project: Partial<Project>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (project.name !== undefined) patch.name = project.name;
  if (project.stage !== undefined) patch.stage = project.stage;
  if (project.dimension !== undefined) patch.dimension = project.dimension;
  if (project.settings !== undefined) {
    patch.block_duration_seconds = project.settings.blockDurationSeconds;
    patch.batch_size = project.settings.batchSize;
  }
  if (project.product !== undefined) {
    patch.product_image_paths = project.product.imagePaths;
    patch.product_info_text = project.product.infoText;
    patch.product_understanding_summary = project.product.understandingSummary;
    patch.product_status = project.product.status;
  }
  if (project.script !== undefined) {
    patch.script_text = project.script.text;
    patch.script_status = project.script.status;
  }
  if (project.bibles !== undefined) patch.product_bible = project.bibles.product;
  if (project.lockedManifest !== undefined) patch.locked_manifest = project.lockedManifest;
  if (project.voiceover !== undefined) {
    patch.voiceover_transcript_path = project.voiceover?.transcriptPath ?? null;
    patch.voiceover_mp3_path = project.voiceover?.mp3Path ?? null;
    patch.voiceover_duration_seconds = project.voiceover?.durationSeconds ?? null;
  }
  if (project.finalOutputPath !== undefined) patch.final_output_path = project.finalOutputPath;
  return patch;
}
