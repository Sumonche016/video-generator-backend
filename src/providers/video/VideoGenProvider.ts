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
  // External, temporary URL to the generated video (provider-hosted) — the
  // caller is responsible for downloading and persisting it into our own
  // storage; it is not guaranteed to stay valid long-term.
  videoUrl?: string;
  // Some providers (e.g. OpenRouter) require an Authorization header to
  // download the finished clip rather than accepting a bare/query-signed URL.
  videoHeaders?: Record<string, string>;
  // When a provider needs to post-process the raw generated video itself
  // (e.g. trimming a fixed lead-in) before it's usable, it returns the
  // already-processed bytes here instead of videoUrl — the caller uses this
  // directly rather than fetching videoUrl.
  videoBuffer?: Buffer;
  error?: string;
}

export interface VideoGenProvider {
  generateClip(params: GenerateClipParams): Promise<GenerateClipResult>;
  pollStatus(jobId: string): Promise<ClipStatusResult>;
}
