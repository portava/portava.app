/**
 * Rent a Buddy — API skeleton
 *
 * All routes are stubs returning typed mock/empty payloads.
 * Business logic will be added in subsequent tasks.
 *
 * POST   /api/rent-a-buddy/search
 * GET    /api/rent-a-buddy/buddies/:buddyId
 * POST   /api/rent-a-buddy/bookings
 * GET    /api/rent-a-buddy/bookings/:bookingId
 * POST   /api/rent-a-buddy/bookings/:bookingId/cancel
 * GET    /api/rent-a-buddy/bookings
 * GET    /api/rent-a-buddy/buddies/:buddyId/availability
 * GET    /api/rent-a-buddy/buddies/:buddyId/reviews
 * POST   /api/rent-a-buddy/bookings/:bookingId/review
 * GET    /api/rent-a-buddy/apply
 * POST   /api/rent-a-buddy/apply
 * GET    /api/rent-a-buddy/saved
 * POST   /api/rent-a-buddy/saved/:buddyId
 * DELETE /api/rent-a-buddy/saved/:buddyId
 * GET    /api/rent-a-buddy/waitlist
 * POST   /api/rent-a-buddy/waitlist
 * DELETE /api/rent-a-buddy/waitlist/:city
 * GET    /api/rent-a-buddy/dashboard
 * GET    /api/rent-a-buddy/dashboard/requests
 * PATCH  /api/rent-a-buddy/dashboard/offer
 * GET    /api/rent-a-buddy/dashboard/availability
 * POST   /api/rent-a-buddy/dashboard/availability
 * GET    /api/rent-a-buddy/dashboard/packages
 * POST   /api/rent-a-buddy/dashboard/packages
 * PATCH  /api/rent-a-buddy/dashboard/packages/:packageId
 * DELETE /api/rent-a-buddy/dashboard/packages/:packageId
 * GET    /api/rent-a-buddy/dashboard/addons
 * POST   /api/rent-a-buddy/dashboard/addons
 * PATCH  /api/rent-a-buddy/dashboard/addons/:addonId
 * DELETE /api/rent-a-buddy/dashboard/addons/:addonId
 * GET    /api/rent-a-buddy/dashboard/earnings
 * GET    /api/rent-a-buddy/admin/applications
 * PATCH  /api/rent-a-buddy/admin/applications/:appId
 * GET    /api/rent-a-buddy/admin/buddies
 * GET    /api/rent-a-buddy/admin/bookings
 * GET    /api/rent-a-buddy/admin/analytics
 */

import { Router } from "express";
import { requireUser, sendError } from "../lib/http.js";

const router = Router();

// ── Search ────────────────────────────────────────────────────────────────────

router.post("/api/rent-a-buddy/search", async (req, res) => {
  return res.json({
    buddies: [],
    total: 0,
    page: 1,
    perPage: 20,
  });
});

// ── Buddy profile ─────────────────────────────────────────────────────────────

router.get("/api/rent-a-buddy/buddies/:buddyId", async (req, res) => {
  return res.json({
    buddy: null,
    packages: [],
    addons: [],
    reviews: [],
    availability: [],
    savedByMe: false,
  });
});

router.get("/api/rent-a-buddy/buddies/:buddyId/availability", async (req, res) => {
  return res.json({ availability: [] });
});

router.get("/api/rent-a-buddy/buddies/:buddyId/reviews", async (req, res) => {
  return res.json({ reviews: [], total: 0 });
});

// ── Bookings ──────────────────────────────────────────────────────────────────

router.post("/api/rent-a-buddy/bookings", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  return res.status(201).json({ booking: null, message: "Booking creation coming soon." });
});

router.get("/api/rent-a-buddy/bookings", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  return res.json({ bookings: [] });
});

router.get("/api/rent-a-buddy/bookings/:bookingId", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  return res.json({ booking: null });
});

router.post("/api/rent-a-buddy/bookings/:bookingId/cancel", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  return res.json({ ok: true });
});

// ── Reviews ───────────────────────────────────────────────────────────────────

router.post("/api/rent-a-buddy/bookings/:bookingId/review", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  return res.status(201).json({ review: null });
});

// ── Application ───────────────────────────────────────────────────────────────

router.get("/api/rent-a-buddy/apply", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  return res.json({ application: null });
});

router.post("/api/rent-a-buddy/apply", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  return res.status(201).json({ application: null, message: "Application submitted." });
});

// ── Saved ─────────────────────────────────────────────────────────────────────

router.get("/api/rent-a-buddy/saved", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  return res.json({ saved: [] });
});

router.post("/api/rent-a-buddy/saved/:buddyId", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  return res.json({ ok: true });
});

router.delete("/api/rent-a-buddy/saved/:buddyId", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  return res.json({ ok: true });
});

// ── Waitlist ──────────────────────────────────────────────────────────────────

router.get("/api/rent-a-buddy/waitlist", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  return res.json({ waitlist: [] });
});

router.post("/api/rent-a-buddy/waitlist", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  return res.status(201).json({ ok: true });
});

router.delete("/api/rent-a-buddy/waitlist/:city", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  return res.json({ ok: true });
});

// ── Buddy dashboard ───────────────────────────────────────────────────────────

router.get("/api/rent-a-buddy/dashboard", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  return res.json({
    profile: null,
    upcomingBookings: 0,
    pendingRequests: 0,
    totalEarningsUsd: 0,
    averageRating: null,
    reviewCount: 0,
  });
});

router.get("/api/rent-a-buddy/dashboard/requests", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  return res.json({ requests: [] });
});

router.get("/api/rent-a-buddy/dashboard/availability", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  return res.json({ availability: [] });
});

router.post("/api/rent-a-buddy/dashboard/availability", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  return res.json({ ok: true });
});

router.patch("/api/rent-a-buddy/dashboard/offer", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  return res.json({ ok: true });
});

router.get("/api/rent-a-buddy/dashboard/packages", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  return res.json({ packages: [] });
});

router.post("/api/rent-a-buddy/dashboard/packages", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  return res.status(201).json({ pkg: null });
});

router.patch("/api/rent-a-buddy/dashboard/packages/:packageId", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  return res.json({ ok: true });
});

router.delete("/api/rent-a-buddy/dashboard/packages/:packageId", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  return res.json({ ok: true });
});

router.get("/api/rent-a-buddy/dashboard/addons", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  return res.json({ addons: [] });
});

router.post("/api/rent-a-buddy/dashboard/addons", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  return res.status(201).json({ addon: null });
});

router.patch("/api/rent-a-buddy/dashboard/addons/:addonId", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  return res.json({ ok: true });
});

router.delete("/api/rent-a-buddy/dashboard/addons/:addonId", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  return res.json({ ok: true });
});

router.get("/api/rent-a-buddy/dashboard/earnings", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  return res.json({ totalUsd: 0, thisMonthUsd: 0, completedBookings: 0, breakdown: [] });
});

// ── Admin ─────────────────────────────────────────────────────────────────────

router.get("/api/rent-a-buddy/admin/applications", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  return res.json({ applications: [], total: 0 });
});

router.patch("/api/rent-a-buddy/admin/applications/:appId", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  return res.json({ ok: true });
});

router.get("/api/rent-a-buddy/admin/buddies", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  return res.json({ buddies: [], total: 0 });
});

router.get("/api/rent-a-buddy/admin/bookings", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  return res.json({ bookings: [], total: 0 });
});

router.get("/api/rent-a-buddy/admin/analytics", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  return res.json({
    totalBuddies: 0,
    activeBuddies: 0,
    totalBookings: 0,
    completedBookings: 0,
    totalRevenueUsd: 0,
    pendingApplications: 0,
  });
});

export default router;
