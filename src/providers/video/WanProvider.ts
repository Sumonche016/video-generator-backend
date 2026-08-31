import { runtimeConfig } from "../../config/runtimeConfig.js";
import { getSignedAssetUrl } from "../../storage/assetStorage.js";
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

const DIMENSION_TO_ASPECT_RATIO: Record<string, string> = {
  YOUTUBE_16_9: "16:9",
};

export class WanProvider implements VideoGenProvider {
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

    const res = await fetch(API_BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${runtimeConfig.OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        prompt: params.prompt,
        duration: Math.max(2, Math.min(30, Math.round(params.durationSeconds))),
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
      const message = typeof data.error === "string" ? data.error : data.error?.message;
      return { status: "failed", error: message ?? "Wan job failed with no error message" };
    }

    const videoUrl = data.unsigned_urls?.[0];
    if (!videoUrl) {
      return { status: "failed", error: "Wan job completed but no video URL was returned" };
    }
    return {
      status: "succeeded",
      videoUrl,
      videoHeaders: { Authorization: `Bearer ${runtimeConfig.OPENROUTER_API_KEY}` },
    };
  }
}
