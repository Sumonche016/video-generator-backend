import { env } from "./env.js";
import { runtimeConfig } from "./runtimeConfig.js";
import type { LLMProvider } from "../providers/llm/LLMProvider.js";
import type { ImageGenProvider } from "../providers/image/ImageGenProvider.js";
import type { VideoGenProvider } from "../providers/video/VideoGenProvider.js";
import { OpenAIProvider } from "../providers/openai/OpenAIProvider.js";
import { VeoProvider } from "../providers/video/VeoProvider.js";
import { WanProvider } from "../providers/video/WanProvider.js";
import { OmniProvider } from "../providers/video/OmniProvider.js";
import { FlowProvider } from "../providers/video/FlowProvider.js";

let llmProvider: LLMProvider | null = null;
let imageGenProvider: ImageGenProvider | null = null;
// Kept as one singleton per provider type (not one "current" instance) —
// Wan/Omni each track in-flight jobs in memory between generateClip() and
// pollStatus(), so switching runtimeConfig.VIDEOGEN_PROVIDER mid-batch must
// not drop a provider's job map, only change which one new work goes to.
let veoProvider: VeoProvider | null = null;
let wanProvider: WanProvider | null = null;
let omniProvider: OmniProvider | null = null;
let flowProvider: FlowProvider | null = null;

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
  // API-based video providers are disabled for now in favor of the Flow
  // browser-automation provider below. Left in place (commented) so they
  // can be re-enabled later. Any provider value other than "flow" —
  // including a "veo"/"wan"/"omni" left over from before this switch,
  // e.g. saved in the app_settings table from the Settings page — falls
  // back to "flow" rather than throwing.
  // if (provider === "veo") return (veoProvider ??= new VeoProvider());
  // if (provider === "wan") return (wanProvider ??= new WanProvider());
  // if (provider === "omni") return (omniProvider ??= new OmniProvider());
  return (flowProvider ??= new FlowProvider());
}

// Providers that construct a vendor SDK client (e.g. OpenAI's) bake the API
// key in at construction time, so saving a new key from the Settings page
// must drop the cached instance — the next getLLMProvider()/
// getImageGenProvider() call then rebuilds it with the fresh key. Video
// providers read their key fresh per-call already, so they don't strictly
// need resetting on a key change, but they're left out of this reset
// entirely regardless — dropping them would also drop their in-flight job
// maps, breaking any generation already in progress.
export function resetProviders(): void {
  llmProvider = null;
  imageGenProvider = null;
}
