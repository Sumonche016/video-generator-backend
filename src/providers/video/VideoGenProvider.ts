import type { VideoDimension } from "../../models/index.js";

export interface VideoReferenceImage {
  name: string;
  path: string;
  role: "character" | "product";
}

export interface GenerateClipParams {
  prompt: string;
  referenceImages: VideoReferenceImage[];
  durationSeconds: number;
  dimension: VideoDimension;
}

export interface GenerateClipResult {
  jobId: string;
}

export interface ClipStatusResult {
  status: "pending" | "running" | "succeeded" | "failed";
  videoPath?: string;
  error?: string;
}

export interface VideoGenProvider {
  generateClip(params: GenerateClipParams): Promise<GenerateClipResult>;
  pollStatus(jobId: string): Promise<ClipStatusResult>;
}
