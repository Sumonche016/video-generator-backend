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

// One captured log line from a provider that drives a browser and so has
// progress worth showing the user while a clip renders.
export interface ProviderLogEntry {
  seq: number;
  ts: number;
  level: "log" | "warn" | "error";
  important: boolean;
  message: string;
}

export interface ProviderLogPage {
  entries: ProviderLogEntry[];
  nextCursor: number;
  dropped: number;
  finished: boolean;
}

export interface VideoGenProvider {
  generateClip(params: GenerateClipParams): Promise<GenerateClipResult>;
  pollStatus(jobId: string): Promise<ClipStatusResult>;

  // Optional: only providers that do long-running local work can be stopped
  // or can report progress. An API-backed provider (veo/wan/omni) hands the
  // job to someone else's queue and has neither, so these stay undefined and
  // callers guard with a typeof check.
  abortRun?(jobId: string, reason: string): boolean;
  getRunLog?(jobId: string, since: number, includeAll: boolean): ProviderLogPage;
}
