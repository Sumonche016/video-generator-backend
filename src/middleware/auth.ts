import type { RequestHandler } from "express";
import { env } from "../config/env.js";

// Single shared hardcoded credential, not per-user accounts — this app has
// one operator team, not multiple end-user logins. The frontend logs in
// once, stores the returned static token in localStorage, and sends it as
// Authorization: Bearer <token> on every request after that.
export function checkCredentials(username: string, password: string): boolean {
  return username === env.AUTH_USERNAME && password === env.AUTH_PASSWORD;
}

export const requireAuth: RequestHandler = (req, res, next) => {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  if (!token || token !== env.AUTH_TOKEN) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
};
