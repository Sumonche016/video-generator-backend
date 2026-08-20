import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  LLM_PROVIDER: z.enum(["openai"]).default("openai"),
  IMAGEGEN_PROVIDER: z.enum(["openai"]).default("openai"),
  VIDEOGEN_PROVIDER: z.enum(["veo"]).default("veo"),
  OPENAI_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
  DEFAULT_BLOCK_SECONDS: z.coerce.number().default(8),
  DEFAULT_BATCH_SIZE: z.coerce.number().default(5),
  SUPABASE_URL: z.string().url(),
  SUPABASE_PUBLISHABLE_KEY: z.string().optional(),
  SUPABASE_SECRET_KEY: z.string().min(1),
  SUPABASE_JWKS_URL: z.string().url().optional(),
  SUPABASE_STORAGE_BUCKET: z.string().default("project-assets"),
});

export const env = envSchema.parse(process.env);
