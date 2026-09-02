import { runtimeConfig } from "../../config/runtimeConfig.js";
import { getSignedAssetUrl } from "../../storage/assetStorage.js";
import { trimVideoBufferPrecise } from "../../services/videoEdit.service.js";
import type {
  VideoGenProvider,
  GenerateClipParams,
  GenerateClipResult,
  ClipStatusResult,
} from "./VideoGenProvider.js";

// Alibaba Wan 3.0, via OpenRouter's provider-agnostic /videos API
// (https://openrouter.ai/api/v1/videos). Chosen over the ByteDance Seedance
// family because Seedance's upstream safety filter flatly rejects ANY human
// face reference image with InputImageSensitiveContentDetected.
// PrivacyInformation — confirmed live against both real character bible
// images used in this app, across seedance-2.0-mini/fast/full alike. Wan 3.0
// accepts the same images without issue.
//
// Wan 3.0 only supports a single "first_frame" reference image (no
// multi-reference conditioning like Veo's referenceImages array), so when a
// scene has more than one, only the first is sent.
const MODEL = "alibaba/wan-3.0";
const API_BASE = "https://openrouter.ai/api/v1/videos";
const RESOLUTION = "480p";

// Wan's first_frame conditioning uses the reference image as the literal
// opening frame, so it holds on that still image for a moment before motion
// starts (confirmed in real testing — visible as a frozen/static opening in
// every clip and, since blocks are just concatenated, in the merged video
// too). Fixed by asking for this many extra seconds whenever a reference
// image is attached, then trimming exactly that much off the front once
// generated — the caller always gets back a clip of the originally
// requested duration, already past the static hold.
const REFERENCE_LEAD_IN_SECONDS = 1.5;

const DIMENSION_TO_ASPECT_RATIO: Record<string, string> = {
  YOUTUBE_16_9: "16:9",
};

export class WanProvider implements VideoGenProvider {
  // In-memory only: generateClip records what pollStatus needs to trim the
  // lead-in back off. Lost on a server restart mid-generation, which just
  // means that one job's clip keeps its lead-in untrimmed — never fatal.
  private jobContext = new Map<string, { leadInSeconds: number; targetDurationSeconds: number }>();

  async generateClip(params: GenerateClipParams): Promise<GenerateClipResult> {
    const [firstRef] = params.referenceImages;
    const frame_images = firstRef
      ? [
          {
            type: "image_url",
            image_url: { url: await getSignedAssetUrl(firstRef.path) },
            frame_type: "first_frame",
          },
        ]
      : undefined;

    const targetDurationSeconds = Math.max(2, Math.min(30, Math.round(params.durationSeconds)));
    // Wan only accepts integer durations, so the lead-in gets rounded up to
    // whole seconds — actualLeadIn (rather than the nominal constant) is
    // what pollStatus trims, so the result always lands exactly on
    // targetDurationSeconds regardless of that rounding.
    const requestDuration = firstRef
      ? Math.max(2, Math.min(30, targetDurationSeconds + Math.ceil(REFERENCE_LEAD_IN_SECONDS)))
      : targetDurationSeconds;
    const leadInSeconds = requestDuration - targetDurationSeconds;

    const res = await fetch(API_BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${runtimeConfig.OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        prompt: params.prompt,
        duration: requestDuration,
        aspect_ratio: DIMENSION_TO_ASPECT_RATIO[params.dimension] ?? "16:9",
        resolution: RESOLUTION,
        ...(frame_images ? { frame_images } : {}),
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Wan generateClip failed: ${res.status} ${errText}`);
    }

    const data = (await res.json()) as { id: string };
    this.jobContext.set(data.id, { leadInSeconds, targetDurationSeconds });
    return { jobId: data.id };
  }

  async pollStatus(jobId: string): Promise<ClipStatusResult> {
    const res = await fetch(`${API_BASE}/${jobId}`, {
      headers: { Authorization: `Bearer ${runtimeConfig.OPENROUTER_API_KEY}` },
    });
    if (!res.ok) {
      const errText = await res.text();
      return { status: "failed", error: `Wan pollStatus failed: ${res.status} ${errText}` };
    }

    const data = (await res.json()) as {
      status: "pending" | "running" | "completed" | "failed";
      error?: { message?: string } | string;
      unsigned_urls?: string[];
    };

    if (data.status === "pending" || data.status === "running") {
      return { status: "running" };
    }
    if (data.status === "failed") {
      this.jobContext.delete(jobId);
      const message = typeof data.error === "string" ? data.error : data.error?.message;
      return { status: "failed", error: message ?? "Wan job failed with no error message" };
    }

    const videoUrl = data.unsigned_urls?.[0];
    if (!videoUrl) {
      this.jobContext.delete(jobId);
      return { status: "failed", error: "Wan job completed but no video URL was returned" };
    }

    const context = this.jobContext.get(jobId);
    this.jobContext.delete(jobId);
    const authHeaders = { Authorization: `Bearer ${runtimeConfig.OPENROUTER_API_KEY}` };

    if (context && context.leadInSeconds > 0) {
      const videoRes = await fetch(videoUrl, { headers: authHeaders });
      if (!videoRes.ok) {
        return { status: "failed", error: `Failed to download Wan clip for lead-in trim: ${videoRes.status}` };
      }
      const rawBuffer = Buffer.from(await videoRes.arrayBuffer());
      const trimmed = await trimVideoBufferPrecise(rawBuffer, context.leadInSeconds, context.targetDurationSeconds);
      return { status: "succeeded", videoBuffer: trimmed };
    }

    return { status: "succeeded", videoUrl, videoHeaders: authHeaders };
  }
}
