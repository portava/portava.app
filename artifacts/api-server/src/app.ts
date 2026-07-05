import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

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
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/", (_req, res) => { res.sendStatus(200); });

// Spec-path compatibility aliases — rewrite before routing so the canonical
// /api/rent-a-buddy/* handlers serve both URL families.
app.use((req, _res, next) => {
  const u = req.url;
  if (/^\/api\/buddy-bookings(\/|$)/.test(u)) {
    req.url = u.replace(/^\/api\/buddy-bookings/, "/api/rent-a-buddy/bookings");
  } else if (/^\/api\/me\/buddy-profile(\/|$)/.test(u)) {
    req.url = u.replace(/^\/api\/me\/buddy-profile/, "/api/rent-a-buddy/me/profile");
  } else if (/^\/api\/admin\/buddy-applications(\/|$)/.test(u)) {
    req.url = u.replace(/^\/api\/admin\/buddy-applications/, "/api/rent-a-buddy/admin/applications");
  } else if (/^\/api\/admin\/buddies(\/|$)/.test(u)) {
    req.url = u.replace(/^\/api\/admin\/buddies/, "/api/rent-a-buddy/admin/buddies");
  } else if (/^\/api\/buddy-profiles(\/|$)/.test(u)) {
    req.url = u.replace(/^\/api\/buddy-profiles/, "/api/rent-a-buddy/buddies");
  } else if (/^\/api\/buddies\//.test(u)) {
    // /api/buddies/:id* → /api/rent-a-buddy/buddies/:id*
    // Note: /api/buddies (no trailing slash) is the list endpoint and is NOT rewritten.
    req.url = u.replace(/^\/api\/buddies\//, "/api/rent-a-buddy/buddies/");
  } else if (/^\/api\/admin\/rent-a-buddy(\/|$)/.test(u)) {
    // /api/admin/rent-a-buddy/* → /api/rent-a-buddy/admin/*
    req.url = u.replace(/^\/api\/admin\/rent-a-buddy/, "/api/rent-a-buddy/admin");
  } else if (/^\/api\/admin\/buddy-bookings(\/|$)/.test(u)) {
    // /api/admin/buddy-bookings/* → /api/rent-a-buddy/admin/bookings/*
    req.url = u.replace(/^\/api\/admin\/buddy-bookings/, "/api/rent-a-buddy/admin/bookings");
  } else if (/^\/api\/admin\/buddy-payouts(\/|$)/.test(u)) {
    // /api/admin/buddy-payouts/* → /api/rent-a-buddy/admin/payouts/*
    req.url = u.replace(/^\/api\/admin\/buddy-payouts/, "/api/rent-a-buddy/admin/payouts");
  } else if (/^\/api\/admin\/buddy-reports(\/|$)/.test(u)) {
    // /api/admin/buddy-reports → /api/rent-a-buddy/admin/buddy-reports
    req.url = u.replace(/^\/api\/admin\/buddy-reports/, "/api/rent-a-buddy/admin/buddy-reports");
  } else if (/^\/api\/me\/buddy-bookings(\/|$)/.test(u)) {
    req.url = u.replace(/^\/api\/me\/buddy-bookings/, "/api/rent-a-buddy/bookings");
  }
  next();
});

app.use("/api", router);

export default app;
