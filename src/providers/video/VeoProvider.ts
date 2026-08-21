import { env } from "../../config/env.js";
import { downloadAsset } from "../../storage/assetStorage.js";
import type {
  VideoGenProvider,
  GenerateClipParams,
  GenerateClipResult,
  ClipStatusResult,
} from "./VideoGenProvider.js";

// Verified against the real API (see conversation history / plan doc):
// - Model: veo-3.1-fast-generate-preview (async job via predictLongRunning).
// - Reference images: referenceImages: [{ image: { bytesBase64Encoded, mimeType }, referenceType: "asset" }],
//   accepts 1+ images, confirmed to actually condition both product shape and
//   character likeness in real test generations.
// - Output: ~8s, 1280x720 for aspectRatio "16:9", h264+aac, via a downloadable
//   file URI once the operation is done.
const MODEL = "veo-3.1-fast-generate-preview";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

const DIMENSION_TO_ASPECT_RATIO: Record<string, string> = {
  YOUTUBE_16_9: "16:9",
};

export class VeoProvider implements VideoGenProvider {
  async generateClip(params: GenerateClipParams): Promise<GenerateClipResult> {
    const referenceImages = await Promise.all(
      params.referenceImages.map(async (ref) => {
        const { buffer, mimeType } = await downloadAsset(ref.path);
        return {
          image: { bytesBase64Encoded: buffer.toString("base64"), mimeType },
          referenceType: "asset",
        };
      })
    );

    const body = {
      instances: [
        {
          prompt: params.prompt,
          ...(referenceImages.length > 0 ? { referenceImages } : {}),
        },
      ],
      parameters: {
        aspectRatio: DIMENSION_TO_ASPECT_RATIO[params.dimension] ?? "16:9",
      },
    };

    const res = await fetch(`${API_BASE}/models/${MODEL}:predictLongRunning?key=${env.GOOGLE_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Veo generateClip failed: ${res.status} ${errText}`);
    }

    const data = (await res.json()) as { name: string };
    return { jobId: data.name };
  }

  async pollStatus(jobId: string): Promise<ClipStatusResult> {
    const res = await fetch(`${API_BASE}/${jobId}?key=${env.GOOGLE_API_KEY}`);
    if (!res.ok) {
      const errText = await res.text();
      return { status: "failed", error: `Veo pollStatus failed: ${res.status} ${errText}` };
    }

    const data = (await res.json()) as {
      done?: boolean;
      error?: { message: string };
      response?: {
        generateVideoResponse?: {
          generatedSamples?: { video?: { uri?: string } }[];
          // Present instead of generatedSamples when Veo's safety filter
          // blocks the output (confirmed via real testing — e.g. it flags
          // photorealistic human reference images + named characters as a
          // "real person likeness" risk even for fictional ad characters).
          raiMediaFilteredReasons?: string[];
        };
      };
    };

    if (!data.done) {
      return { status: "running" };
    }
    if (data.error) {
      return { status: "failed", error: data.error.message };
    }

    const filterReasons = data.response?.generateVideoResponse?.raiMediaFilteredReasons;
    if (filterReasons?.length) {
      return { status: "failed", error: `Blocked by Veo content safety filter: ${filterReasons.join("; ")}` };
    }

    const videoUrl = data.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
    if (!videoUrl) {
      return { status: "failed", error: "Veo job finished but no video URI was returned" };
    }
    return { status: "succeeded", videoUrl: `${videoUrl}&key=${env.GOOGLE_API_KEY}` };
  }
}
