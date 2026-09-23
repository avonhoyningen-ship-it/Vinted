import type { NextFunction, Request, RequestHandler, Response } from "express";
import multer from "multer";
import { ZodError } from "zod";

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} not found`);

/** Wraps async handlers so rejected promises reach the error middleware. */
export function h(fn: (req: Request, res: Response) => unknown): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

export function idParam(req: Request, name = "id"): number {
  const id = Number.parseInt(String(req.params[name]), 10);
  if (!Number.isFinite(id) || id <= 0) throw new HttpError(400, `Invalid ${name}`);
  return id;
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: "Validation failed", details: err.issues });
  }
  if (err instanceof multer.MulterError) {
    const messages: Record<string, string> = {
      LIMIT_FILE_SIZE: "Foto zu groß (max. 25 MB pro Datei)",
      LIMIT_FILE_COUNT: "Zu viele Fotos (max. 20 pro Upload)",
    };
    return res.status(413).json({ error: messages[err.code] ?? err.message });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }
  console.error(err);
  const message = err instanceof Error ? err.message : "Internal error";
  return res.status(500).json({ error: message });
}
