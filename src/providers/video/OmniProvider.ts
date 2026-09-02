import { runtimeConfig } from "../../config/runtimeConfig.js";
import { downloadAsset } from "../../storage/assetStorage.js";
import type {
  VideoGenProvider,
  GenerateClipParams,
  GenerateClipResult,
  ClipStatusResult,
} from "./VideoGenProvider.js";

// Google's Gemini Omni Flash, via the synchronous /v1beta/interactions API
// (https://ai.google.dev/gemini-api/docs/omni#rest). Unlike Wan/Veo this call
// is NOT async — the video comes back in the same response, already
// base64-encoded — so generateClip does the real work and pollStatus just
// hands back what's already sitting in memory for that job id.
//
// No duration control exists in this API (no "duration"/length parameter
// documented at all), so whatever length Omni Flash decides to return is
// what gets used — the same situation Veo was in ("always returns ~8s
// regardless of what's asked"), already handled downstream by
// clip.service.ts's trim/pad-to-slice-length logic.
const MODEL = "gemini-omni-1.1-flash";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/interactions";

const DIMENSION_TO_ASPECT_RATIO: Record<string, string> = {
  YOUTUBE_16_9: "16:9",
};

interface InteractionResponse {
  status: "completed" | "failed" | string;
  error?: { message?: string };
  steps?: {
    type: string;
    content?: { type: string; mime_type?: string; data?: string }[];
  }[];
}

export class OmniProvider implements VideoGenProvider {
  // Synchronous API: generateClip already has the finished result by the
  // time it returns, so it's stashed here keyed by a locally-generated job
  // id for pollStatus to hand back. In-memory only — lost on a server
  // restart mid-poll, which just means that one job never resolves (the
  // caller's existing timeout/retry handling already covers a stuck job).
  private results = new Map<string, ClipStatusResult>();

  async generateClip(params: GenerateClipParams): Promise<GenerateClipResult> {
    const jobId = `omni_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const content: Record<string, unknown>[] = await Promise.all(
      params.referenceImages.map(async (ref) => {
        const { buffer, mimeType } = await downloadAsset(ref.path);
        return { type: "image", data: buffer.toString("base64"), mime_type: mimeType };
      })
    );
    content.push({ type: "text", text: params.prompt });

    const body = {
      model: MODEL,
      input: content,
      response_format: {
        type: "video",
        aspect_ratio: DIMENSION_TO_ASPECT_RATIO[params.dimension] ?? "16:9",
      },
    };

    const res = await fetch(`${API_BASE}?key=${runtimeConfig.GOOGLE_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      this.results.set(jobId, { status: "failed", error: `Omni generateClip failed: ${res.status} ${errText}` });
      return { jobId };
    }

    const data = (await res.json()) as InteractionResponse;
    if (data.status !== "completed") {
      this.results.set(jobId, {
        status: "failed",
        error: data.error?.message ?? `Omni job did not complete (status: ${data.status})`,
      });
      return { jobId };
    }

    const videoStep = data.steps
      ?.flatMap((step) => step.content ?? [])
      .find((c) => c.type === "video" && c.data);
    if (!videoStep?.data) {
      this.results.set(jobId, { status: "failed", error: "Omni job completed but no video data was returned" });
      return { jobId };
    }

    this.results.set(jobId, { status: "succeeded", videoBuffer: Buffer.from(videoStep.data, "base64") });
    return { jobId };
  }

  async pollStatus(jobId: string): Promise<ClipStatusResult> {
    const result = this.results.get(jobId);
    if (!result) {
      return { status: "failed", error: "Unknown Omni job id (server may have restarted mid-generation)" };
    }
    this.results.delete(jobId);
    return result;
  }
}
