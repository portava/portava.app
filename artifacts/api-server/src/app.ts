import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { specAliasRewrite } from "./lib/specAliasRewrite";
import { BOOT_HRTIME } from "./lib/bootTime";
import { callsWebhookHandler, callsWebhookRawParser } from "./routes/callsWebhook";
import { webhookHandler as verificationWebhookHandler, webhookRawParser as verificationWebhookRawParser } from "./routes/verification.js";

const app: Express = express();

// ── Security headers ──────────────────────────────────────────────────────────
// Helmet must be the very first middleware so headers are set on every response.
app.use(helmet());

// ── CORS allowlist ────────────────────────────────────────────────────────────
// Reads from ALLOWED_ORIGINS (comma-separated).  Requests with no Origin header
// (mobile apps, curl, server-to-server) are always allowed through.
// Document new origins in .env.example.
const _rawOrigins = process.env.ALLOWED_ORIGINS;
const CORS_FALLBACK_ORIGINS = [
  "https://app.travel-buddy.io",
  "https://www.travel-buddy.io",
  "https://portava.replit.app",
];
const ALLOWED_ORIGINS: string[] = _rawOrigins
  ? _rawOrigins.split(",").map((s) => s.trim()).filter(Boolean)
  : (() => {
      logger.warn(
        { fallbackOrigins: CORS_FALLBACK_ORIGINS },
        "ALLOWED_ORIGINS env var is not set — CORS allowlist is using hardcoded fallback domains. " +
          "Set ALLOWED_ORIGINS in production to avoid silently blocking or allowing wrong origins.",
      );
      return CORS_FALLBACK_ORIGINS;
    })();

// Auto-allow the Replit workspace dev domain and any port-mapped subdomains
// (e.g. https://<id>.expo.kirk.replit.dev for the Expo web preview).
// REPLIT_DEV_DOMAIN is only present in the Replit workspace, never in the
// deployed production environment, so this is a dev-only convenience.
//
// REPLIT_DEV_DOMAIN has the form "<repl-id>.kirk.replit.dev". Port-mapped
// artifact previews use sibling subdomains like "<repl-id>.expo.kirk.replit.dev",
// so we derive the shared parent ("kirk.replit.dev") and allow any subdomain of it.
const _replitDevDomain = process.env.REPLIT_DEV_DOMAIN;
const _replitParentDomain = _replitDevDomain
  ? _replitDevDomain.split(".").slice(1).join(".")
  : null;

app.use(
  cors({
    origin: (origin, callback) => {
      // Requests with no Origin (mobile, curl, server) are always permitted.
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      // Allow the Replit workspace domain and any sibling/child subdomains
      // (e.g. expo. prefix used by port-mapped artifact previews).
      if (
        _replitParentDomain &&
        (origin === `https://${_replitDevDomain}` ||
          origin.endsWith(`.${_replitParentDomain}`))
      ) {
        return callback(null, true);
      }
      callback(new Error(`Origin '${origin}' is not allowed by CORS policy`));
    },
    credentials: true,
  }),
);

// ── Cold-start marker: log once on the first request after each process boot ──
let coldStartLogged = false;
function coldStartMiddleware(req: Request, _res: Response, next: NextFunction): void {
  if (!coldStartLogged) {
    coldStartLogged = true;
    const uptimeMs = Number((process.hrtime.bigint() - BOOT_HRTIME) / 1_000_000n);
    logger.info({ event: "cold_start_request", uptimeMs });
  }
  next();
}

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(coldStartMiddleware);

// LiveKit webhook needs the RAW body for signature verification — must be
// registered BEFORE the global JSON parser consumes it.
app.post("/api/calls/webhook", callsWebhookRawParser, callsWebhookHandler);

// Identity-verification webhook: raw body for future real-provider signature verification.
// Registered before the global JSON parser so the raw body is preserved.
app.post("/api/verification/webhook", verificationWebhookRawParser, verificationWebhookHandler);

// ── Body parsers ──────────────────────────────────────────────────────────────
// Explicit 256 kb limit; the Express default is 100 kb but we make it
// intentional and slightly larger to accommodate rich trip/plan payloads.
app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: true, limit: "256kb" }));

app.get("/", (_req, res) => { res.sendStatus(200); });

app.use(specAliasRewrite);

app.use("/api", router);

// ── Global error handler ─────────────────────────────────────────────────────
// Must be the LAST middleware registered (4-argument signature is required by
// Express to recognise it as an error handler).  All unhandled async rejections
// and explicit next(err) calls land here.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, _req: Request, res: Response, _next: NextFunction): void => {
  const status: number =
    typeof err?.status    === "number" ? err.status :
    typeof err?.statusCode === "number" ? err.statusCode :
    500;

  // Log at error level; skip 4xx noise in production if desired
  if (status >= 500) {
    logger.error({ err }, "unhandled error");
  } else {
    logger.warn({ err }, "request error");
  }

  // Do not leak stack traces to the client
  res.status(status).json({
    error: {
      code:    err?.code    ?? "INTERNAL_ERROR",
      message: err?.message ?? "An unexpected error occurred.",
    },
  });
});

export default app;
