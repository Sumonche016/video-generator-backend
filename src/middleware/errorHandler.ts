import type { ErrorRequestHandler } from "express";
import { StageGateError } from "../services/project.service.js";
import { LockValidationError } from "../services/lock.service.js";
import { AssembleValidationError } from "../services/assemble.service.js";

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof StageGateError) {
    res.status(409).json({ error: err.message });
    return;
  }
  if (err instanceof LockValidationError || err instanceof AssembleValidationError) {
    res.status(422).json({ error: err.message, issues: err.issues });
    return;
  }
  const message = err instanceof Error ? err.message : "Internal server error";
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: message });
};
