import { env } from "./env.js";
import type { LLMProvider } from "../providers/llm/LLMProvider.js";
import type { ImageGenProvider } from "../providers/image/ImageGenProvider.js";
import type { VideoGenProvider } from "../providers/video/VideoGenProvider.js";
import { OpenAIProvider } from "../providers/openai/OpenAIProvider.js";
import { VeoProvider } from "../providers/video/VeoProvider.js";
import { WanProvider } from "../providers/video/WanProvider.js";

let llmProvider: LLMProvider | null = null;
let imageGenProvider: ImageGenProvider | null = null;
let videoGenProvider: VideoGenProvider | null = null;

export function getLLMProvider(): LLMProvider {
  if (!llmProvider) {
    if (env.LLM_PROVIDER === "openai") {
      llmProvider = new OpenAIProvider();
    } else {
      throw new Error(`Unknown LLM_PROVIDER: ${env.LLM_PROVIDER}`);
    }
  }
  return llmProvider;
}

export function getImageGenProvider(): ImageGenProvider {
  if (!imageGenProvider) {
    if (env.IMAGEGEN_PROVIDER === "openai") {
      imageGenProvider = new OpenAIProvider();
    } else {
      throw new Error(`Unknown IMAGEGEN_PROVIDER: ${env.IMAGEGEN_PROVIDER}`);
    }
  }
  return imageGenProvider;
}

export function getVideoGenProvider(): VideoGenProvider {
  if (!videoGenProvider) {
    if (env.VIDEOGEN_PROVIDER === "veo") {
      videoGenProvider = new VeoProvider();
    } else if (env.VIDEOGEN_PROVIDER === "wan") {
      videoGenProvider = new WanProvider();
    } else {
      throw new Error(`Unknown VIDEOGEN_PROVIDER: ${env.VIDEOGEN_PROVIDER}`);
    }
  }
  return videoGenProvider;
}

// Providers that construct a vendor SDK client (e.g. OpenAI's) bake the API
// key in at construction time, so saving a new key from the Settings page
// must drop the cached instance — the next getLLMProvider()/
// getImageGenProvider() call then rebuilds it with the fresh key. VeoProvider
// reads its key fresh per-call already, so it doesn't need resetting, but
// clearing it too is harmless and keeps this simple/uniform.
export function resetProviders(): void {
  llmProvider = null;
  imageGenProvider = null;
  videoGenProvider = null;
}
