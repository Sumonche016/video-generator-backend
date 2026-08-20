import type {
  VideoGenProvider,
  GenerateClipParams,
  GenerateClipResult,
  ClipStatusResult,
} from "./VideoGenProvider.js";

/**
 * Google Veo integration. STUB for Milestone 0 — the exact request/response
 * shape (reference-image count/binding, sync vs async job model, supported
 * durations, rate limits) must be verified against current Veo/Gemini API
 * docs before Milestone 5 (see plan's Open Questions #2). Do not assume this
 * shape is final.
 */
export class VeoProvider implements VideoGenProvider {
  async generateClip(_params: GenerateClipParams): Promise<GenerateClipResult> {
    throw new Error("VeoProvider.generateClip not implemented yet — pending Veo API verification");
  }

  async pollStatus(_jobId: string): Promise<ClipStatusResult> {
    throw new Error("VeoProvider.pollStatus not implemented yet — pending Veo API verification");
  }
}
