export type VideoDimension = "YOUTUBE_16_9";

export type ProjectStage =
  | "DRAFT"
  | "PRODUCT_UNDERSTOOD"
  | "SCRIPT_ANALYZED"
  | "CHARACTERS_APPROVED"
  | "BIBLES_GENERATING"
  | "BIBLES_APPROVED"
  | "LOCKED"
  | "VOICEOVER_UPLOADED"
  | "BLOCKS_PLANNED"
  | "BLOCKS_GENERATING"
  | "BLOCKS_APPROVED"
  | "ASSEMBLED";

export const STAGE_ORDER: ProjectStage[] = [
  "DRAFT",
  "PRODUCT_UNDERSTOOD",
  "SCRIPT_ANALYZED",
  "CHARACTERS_APPROVED",
  "BIBLES_GENERATING",
  "BIBLES_APPROVED",
  "LOCKED",
  "VOICEOVER_UPLOADED",
  "BLOCKS_PLANNED",
  "BLOCKS_GENERATING",
  "BLOCKS_APPROVED",
  "ASSEMBLED",
];

export interface BibleAsset {
  candidatePaths: string[];
  refinementPrompts: string[];
  approvedImagePath: string | null;
  status: "pending" | "generating" | "approved";
}

export interface Character {
  id: string;
  name: string;
  slug: string;
  description: string;
  source: "ai" | "human-added";
  approved: boolean;
  bible: BibleAsset;
}

export interface LockedRef {
  name: string;
  kind: "character" | "product";
  imagePath: string;
}

export interface WordTiming {
  word: string;
  start: number;
  end: number;
}

export interface ClipAttempt {
  path: string;
  createdAt: string;
  status: "pending" | "running" | "succeeded" | "failed";
  jobId?: string;
  error?: string;
  durationSeconds?: number;
}

export interface AudioLeveling {
  veoClipVolumeDb: number | null;
  voiceoverVolumeDb: number | null;
  duckingApplied: boolean;
  duckingFactor: number | null;
}

export interface Block {
  index: number;
  startSec: number;
  endSec: number;
  transcriptText: string;
  wordTimings: WordTiming[];
  veoPrompt: string;
  attachedReferenceNames: string[];
  approvalStatus:
    | "pending"
    | "prompt_approved"
    | "clip_generating"
    | "clip_review"
    | "approved"
    | "rejected";
  clipAttempts: ClipAttempt[];
  approvedClipPath: string | null;
  audioLeveling: AudioLeveling;
  gapFillerPrompt?: string;
  gapFillerAttempts?: ClipAttempt[];
  approvedGapFillerPath?: string | null;
}

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  stage: ProjectStage;
  dimension: VideoDimension;
  settings: {
    blockDurationSeconds: number;
    batchSize: number;
  };
  product: {
    imagePaths: string[];
    infoText: string;
    understandingSummary: string;
    status: "pending" | "understood";
  };
  script: {
    text: string;
    status: "pending" | "analyzed";
  };
  characters: Character[];
  bibles: {
    product: BibleAsset;
  };
  lockedManifest: LockedRef[] | null;
  voiceover: {
    transcriptPath: string;
    mp3Path: string;
    durationSeconds: number;
  } | null;
  blockList: Block[];
  finalOutputPath: string | null;
}
