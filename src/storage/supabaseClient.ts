import { createClient } from "@supabase/supabase-js";
import { env } from "../config/env.js";

// Server-side only client using the secret key — bypasses RLS, must never be
// exposed to the frontend (which would instead use the publishable key with
// RLS policies, not needed since there is no frontend direct-to-Supabase
// access in this app; all access goes through this API).
export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});
