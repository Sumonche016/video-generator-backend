import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { checkCredentials } from "../middleware/auth.js";

export const authRouter = Router();

const loginSchema = z.object({ username: z.string().min(1), password: z.string().min(1) });

authRouter.post("/login", (req, res, next) => {
  try {
    const body = loginSchema.parse(req.body ?? {});
    if (!checkCredentials(body.username, body.password)) {
      res.status(401).json({ error: "Invalid username or password" });
      return;
    }
    res.json({ token: env.AUTH_TOKEN });
  } catch (err) {
    next(err);
  }
});
