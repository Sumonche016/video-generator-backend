import multer from "multer";

// In-memory storage — files go straight to Supabase Storage, never touch local disk.
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});
