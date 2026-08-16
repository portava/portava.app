import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import * as Sentry from "@sentry/node";
import router from "./routes";
import { logger } from "./lib/logger";
import { specAliasRewrite } from "./lib/specAliasRewrite";
import { BOOT_HRTIME } from "./lib/bootTime";
import { callsWebhookHandler, callsWebhookRawParser } from "./routes/callsWebhook";
import { webhookHandler as verificationWebhookHandler, webhookRawParser as verificationWebhookRawParser } from "./routes/verification.js";
import wellKnownShareRouter from "./routes/wellKnownShare.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
      // (e.g. expo. prefix used by port-mapped artifact previews), including
      // an explicit :<port> suffix on the dev domain itself (used to reach a
      // non-artifact dev server bound to an extra exposed port, e.g. the
      // travel-buddy-standalone web preview on :3000 — that origin string
      // still starts with the dev domain but doesn't match the plain
      // endsWith(parent) check above because of the trailing port).
      if (
        _replitParentDomain &&
        (origin === `https://${_replitDevDomain}` ||
          origin.startsWith(`https://${_replitDevDomain}:`) ||
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

// NOTE: bare GET "/" removed — the frontend catch-all (registered after /api
// routes) now serves the landing page.  Health-check callers should use
// GET /api/healthz which goes through the API router.

// ── Deep-link association files + share landing pages ─────────────────────────
// Public, unauthenticated, cookie-free surface served from the app ROOT
// (/.well-known/*, /u/:username, /passport/:username, and the six entity share
// paths /posts /trips /event /place /memory /stamp /:id). Must be mounted
// BEFORE the /api router and before anything auth-related so Apple/Google
// verifiers and link-preview crawlers can always reach it.
app.use(wellKnownShareRouter);

// ── Static assets: category fallback images ───────────────────────────────────
// Served at /fallbacks/<slug>.webp so the categoryFallbackProvider can construct
// absolute URLs from AI_VISUAL_FALLBACK_BASE (or the default in-repo path).
// Files live in artifacts/api-server/public/fallbacks/ at build time.
app.use(
  "/fallbacks",
  express.static(path.join(__dirname, "../public/fallbacks"), {
    maxAge: "7d",
    immutable: false,
  }),
);

app.use(specAliasRewrite);

// ── Static assets (generic cover placeholders, etc.) ─────────────────────────
// Served at /api/static/* — registered before the API router so the router
// never sees these paths.  Content-Type is inferred from file extension.
//
// Path resolution: in development __dirname = src/; in production __dirname =
// dist/.  The static/ directory lives at the project root (api-server/static/)
// alongside both src/ and dist/, so we go one level up from __dirname.
app.use("/api/static", express.static(path.join(__dirname, "../static"), {
  maxAge: "7d",
  immutable: false,
}));

app.use("/api", router);

// ── Frontend catch-all ────────────────────────────────────────────────────────
// In production the travel-buddy-standalone web server (serve.js) is imported
// directly and used as a catch-all middleware so a single process handles both
// the API and the frontend.  The guard on static-build/ keeps this a no-op in
// development (where the standalone dev server on port 3000 handles these paths).
//
// Path resolution: __dirname in the compiled dist/ is artifacts/api-server/dist/.
// The workspace root is three levels up: dist/ → api-server/ → artifacts/ → root.
// Using __dirname avoids process.cwd() whose value depends on which directory
// pnpm uses as the package root when running `pnpm --filter ... run start`.
const _require = createRequire(import.meta.url);
const _workspaceRoot = path.resolve(__dirname, "../../..");
const _frontendStaticBuildDir = path.join(_workspaceRoot, "travel-buddy-standalone", "static-build");
if (fs.existsSync(_frontendStaticBuildDir)) {
  try {
    const { createRequestHandler } = _require(
      path.join(_workspaceRoot, "travel-buddy-standalone", "server", "serve.js"),
    ) as { createRequestHandler: (template: string, appName: string) => (req: Request, res: Response) => void };
    const _templatePath = path.join(
      _workspaceRoot, "travel-buddy-standalone", "server", "templates", "landing-page.html",
    );
    const _landingPageTemplate = fs.readFileSync(_templatePath, "utf-8");
    const _frontendHandler = createRequestHandler(_landingPageTemplate, "Portava");
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    app.use((req: Request, res: Response, _next: NextFunction): void => {
      _frontendHandler(req, res);
    });
    logger.info("Frontend catch-all registered (travel-buddy-standalone/static-build exists)");
  } catch (err) {
    logger.warn({ err }, "Frontend catch-all setup failed — non-API paths will 404");
  }
}

// ── Sentry error handler ──────────────────────────────────────────────────────
// Must be registered AFTER all routes but BEFORE the custom global error handler
// so that Sentry captures the error context (request, user, transaction) before
// the error is consumed and a response is sent.
// setupExpressErrorHandler is a no-op when Sentry was not initialized (no DSN).
Sentry.setupExpressErrorHandler(app);

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

  // Do not leak stack traces to the client. In production, additionally
  // suppress internal error messages (DB errors, stack-adjacent details) for
  // 5xx responses — the original error is already logged above. Dev keeps the
  // real message for debuggability. Response JSON shape is unchanged.
  const isProd = process.env.NODE_ENV === "production";
  const clientMessage: string =
    status >= 500 && isProd
      ? "An unexpected error occurred."
      : (err?.message ?? "An unexpected error occurred.");

  res.status(status).json({
    error: {
      code:    err?.code    ?? "INTERNAL_ERROR",
      message: clientMessage,
    },
  });
});

export default app;
