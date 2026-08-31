import { env } from "./env.js";
import { supabase } from "../storage/supabaseClient.js";

// API keys editable from the web app (Settings page) without redeploying.
// Starts from .env as the default/fallback, then gets overridden by whatever
// is saved in the app_settings table — either at boot (loadRuntimeConfig) or
// live when the user saves new keys (updateApiKey). Providers must read
// these values fresh on every call rather than caching them, so a key
// change takes effect immediately.
export const runtimeConfig = {
  OPENAI_API_KEY: env.OPENAI_API_KEY,
  GOOGLE_API_KEY: env.GOOGLE_API_KEY,
  OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
};

export type RuntimeApiKeyName = "OPENAI_API_KEY" | "GOOGLE_API_KEY" | "OPENROUTER_API_KEY";

const RUNTIME_KEY_NAMES: RuntimeApiKeyName[] = ["OPENAI_API_KEY", "GOOGLE_API_KEY", "OPENROUTER_API_KEY"];

export async function loadRuntimeConfig(): Promise<void> {
  const { data, error } = await supabase.from("app_settings").select("key, value").in("key", RUNTIME_KEY_NAMES);
  if (error) {
    // Table may not exist yet if the migration hasn't been run — fall back
    // to .env silently rather than crashing server startup over this.
    console.warn("Could not load app_settings (has migration 0002 been run?):", error.message);
    return;
  }
  for (const row of data ?? []) {
    if (RUNTIME_KEY_NAMES.includes(row.key as RuntimeApiKeyName) && row.value) {
      runtimeConfig[row.key as RuntimeApiKeyName] = row.value;
    }
  }
}

export async function updateApiKey(key: RuntimeApiKeyName, value: string): Promise<void> {
  // Persist first — only reflect the change in-memory once it's actually
  // saved, so a failed write (e.g. migration not run yet) can't leave a
  // phantom key in effect that the database doesn't agree with.
  const { error } = await supabase.from("app_settings").upsert({ key, value, updated_at: new Date().toISOString() });
  if (error) throw error;
  runtimeConfig[key] = value;
}

// Masked for display — never send the real key back to the browser once saved.
function mask(value: string | undefined): string | null {
  if (!value) return null;
  if (value.length <= 8) return "••••••••";
  return `${value.slice(0, 4)}••••••••${value.slice(-4)}`;
}

export function getMaskedApiKeys() {
  return {
    OPENAI_API_KEY: mask(runtimeConfig.OPENAI_API_KEY),
    GOOGLE_API_KEY: mask(runtimeConfig.GOOGLE_API_KEY),
    OPENROUTER_API_KEY: mask(runtimeConfig.OPENROUTER_API_KEY),
  };
}
