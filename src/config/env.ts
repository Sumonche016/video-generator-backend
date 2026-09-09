import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  LLM_PROVIDER: z.enum(["openai"]).default("openai"),
  IMAGEGEN_PROVIDER: z.enum(["openai"]).default("openai"),
  VIDEOGEN_PROVIDER: z.enum(["veo", "wan", "omni", "flow"]).default("flow"),
  OPENAI_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  GOLOGIN_API_TOKEN: z.string().optional(),
  GOLOGIN_PROFILE_ID: z.string().optional(),
  // Comma-separated list of GoLogin profile ids. One profile = one Google
  // account = one clip that can render at a time, so listing three ids lets
  // three clips generate simultaneously.
  GOLOGIN_PROFILE_IDS: z.string().optional(),
  AUTH_USERNAME: z.string().min(1),
  AUTH_PASSWORD: z.string().min(1),
  AUTH_TOKEN: z.string().min(16),
  DEFAULT_BLOCK_SECONDS: z.coerce.number().default(8),
  DEFAULT_BATCH_SIZE: z.coerce.number().default(5),
  SUPABASE_URL: z.string().url(),
  SUPABASE_PUBLISHABLE_KEY: z.string().optional(),
  SUPABASE_SECRET_KEY: z.string().min(1),
  SUPABASE_JWKS_URL: z.string().url().optional(),
  SUPABASE_STORAGE_BUCKET: z.string().default("project-assets"),
});

export const env = envSchema.parse(process.env);
