import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { specAliasRewrite } from "./lib/specAliasRewrite";
import { BOOT_HRTIME } from "./lib/bootTime";
import { callsWebhookHandler, callsWebhookRawParser } from "./routes/callsWebhook";

const app: Express = express();

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
app.use(cors());
// LiveKit webhook needs the RAW body for signature verification — must be
// registered BEFORE the global JSON parser consumes it.
app.post("/api/calls/webhook", callsWebhookRawParser, callsWebhookHandler);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/", (_req, res) => { res.sendStatus(200); });

app.use(specAliasRewrite);

app.use("/api", router);

export default app;
