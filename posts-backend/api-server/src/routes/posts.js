"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
var express_1 = require("express");
var http_1 = require("../lib/http");
var postSchemas_1 = require("../lib/postSchemas");
var router = (0, express_1.Router)();
// Columns returned to clients (never expose nothing extra; these are all safe).
var POST_COLUMNS = "id, author_id, trip_id, content, media_urls, visibility, status, created_at, updated_at";
/* ===========================================================================
 * POST /posts  — create a standalone or trip-attached post
 * ===========================================================================
 * - requires a valid bearer token (author = verified user; client author_id ignored)
 * - if trip_id present: trip must exist AND user must be owner/accepted member
 * - visibility=trip_only requires trip_id (schema + DB both enforce)
 * - service-role insert; audit fields set server-side
 */
router.post("/posts", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, parsed, _a, content, mediaUrls, tripId, visibility, _b, data, error;
    var _c, _d;
    return __generator(this, function (_e) {
        switch (_e.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _e.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                parsed = postSchemas_1.createPostSchema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_1.sendError)(res, "invalid_payload", (_d = (_c = parsed.error.issues[0]) === null || _c === void 0 ? void 0 : _c.message) !== null && _d !== void 0 ? _d : "Invalid payload");
                    return [2 /*return*/];
                }
                _a = parsed.data, content = _a.content, mediaUrls = _a.mediaUrls, tripId = _a.tripId, visibility = _a.visibility;
                if (!tripId) return [3 /*break*/, 4];
                return [4 /*yield*/, (0, http_1.tripExists)(client, tripId)];
            case 2:
                if (!(_e.sent())) {
                    (0, http_1.sendError)(res, "not_found", "Trip not found");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, http_1.isAcceptedTripMember)(client, tripId, user.id)];
            case 3:
                if (!(_e.sent())) {
                    // invited-but-not-accepted, declined, removed, or non-member all land here
                    (0, http_1.sendError)(res, "not_member", "You must be an accepted member of this trip to post to it");
                    return [2 /*return*/];
                }
                _e.label = 4;
            case 4: return [4 /*yield*/, client
                    .from("posts")
                    .insert({
                    author_id: user.id, // verified user only — never from client
                    trip_id: tripId !== null && tripId !== void 0 ? tripId : null,
                    content: content !== null && content !== void 0 ? content : "",
                    media_urls: mediaUrls !== null && mediaUrls !== void 0 ? mediaUrls : [],
                    visibility: visibility,
                    status: "active",
                    created_by: user.id,
                    updated_by: user.id,
                    source: "api_server",
                })
                    .select(POST_COLUMNS)
                    .single()];
            case 5:
                _b = _e.sent(), data = _b.data, error = _b.error;
                if (error) {
                    req.log.error({ err: error }, "Failed to insert post");
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                res.status(201).json(data);
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * GET /posts  — global feed: active PUBLIC STANDALONE posts only
 * ===========================================================================
 * Deliberately excludes trip_only and private and trip-attached posts so no
 * private/trip content can leak into the global feed. (Trip feeds have their
 * own endpoint below.) Auth required so we can attribute/se the reader, but the
 * feed itself is public-standalone content.
 */
router.get("/posts", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, parsed, _a, limit, before, q, _b, data, error;
    var _c, _d;
    return __generator(this, function (_e) {
        switch (_e.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _e.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client;
                parsed = postSchemas_1.listPostsQuerySchema.safeParse(req.query);
                if (!parsed.success) {
                    (0, http_1.sendError)(res, "invalid_payload", (_d = (_c = parsed.error.issues[0]) === null || _c === void 0 ? void 0 : _c.message) !== null && _d !== void 0 ? _d : "Invalid query");
                    return [2 /*return*/];
                }
                _a = parsed.data, limit = _a.limit, before = _a.before;
                q = client
                    .from("posts")
                    .select(POST_COLUMNS)
                    .is("trip_id", null) // standalone only
                    .eq("visibility", "public") // public only — no trip_only/private leakage
                    .eq("status", "active")
                    .order("created_at", { ascending: false })
                    .limit(limit);
                if (before)
                    q = q.lt("created_at", before);
                return [4 /*yield*/, q];
            case 2:
                _b = _e.sent(), data = _b.data, error = _b.error;
                if (error) {
                    req.log.error({ err: error }, "Failed to list posts");
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                res.status(200).json({ posts: data !== null && data !== void 0 ? data : [] });
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * GET /trips/:tripId/posts  — a trip's feed
 * ===========================================================================
 * - requires accepted membership to view trip_only content
 * - returns active posts attached to that trip that the user may see:
 *     public (anyone who can load the trip) + trip_only (accepted members)
 *   excludes other users' private posts.
 */
router.get("/trips/:tripId/posts", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, tripId, accepted, q, _a, data, error;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _b.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                tripId = req.params.tripId;
                if (!/^[0-9a-f-]{36}$/i.test(tripId)) {
                    (0, http_1.sendError)(res, "invalid_payload", "Invalid trip id");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, http_1.tripExists)(client, tripId)];
            case 2:
                if (!(_b.sent())) {
                    (0, http_1.sendError)(res, "not_found", "Trip not found");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, http_1.isAcceptedTripMember)(client, tripId, user.id)];
            case 3:
                accepted = _b.sent();
                q = client
                    .from("posts")
                    .select(POST_COLUMNS)
                    .eq("trip_id", tripId)
                    .eq("status", "active")
                    .order("created_at", { ascending: false })
                    .limit(100);
                if (accepted) {
                    // public + trip_only, plus own private
                    q = q.or("visibility.eq.public,visibility.eq.trip_only,and(visibility.eq.private,author_id.eq.".concat(user.id, ")"));
                }
                else {
                    // public only, plus own private
                    q = q.or("visibility.eq.public,and(visibility.eq.private,author_id.eq.".concat(user.id, ")"));
                }
                return [4 /*yield*/, q];
            case 4:
                _a = _b.sent(), data = _a.data, error = _a.error;
                if (error) {
                    req.log.error({ err: error }, "Failed to list trip posts");
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                res.status(200).json({ posts: data !== null && data !== void 0 ? data : [], isMember: accepted });
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * PATCH /posts/:postId  — author-only edit
 * ===========================================================================
 */
router.patch("/posts/:postId", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, postId, parsed, _a, existing, loadErr, nextVisibility, patch, _b, data, error;
    var _c, _d, _e;
    return __generator(this, function (_f) {
        switch (_f.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _f.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                postId = req.params.postId;
                parsed = postSchemas_1.updatePostSchema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_1.sendError)(res, "invalid_payload", (_d = (_c = parsed.error.issues[0]) === null || _c === void 0 ? void 0 : _c.message) !== null && _d !== void 0 ? _d : "Invalid payload");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("posts")
                        .select("id, author_id, trip_id, visibility")
                        .eq("id", postId)
                        .maybeSingle()];
            case 2:
                _a = _f.sent(), existing = _a.data, loadErr = _a.error;
                if (loadErr) {
                    req.log.error({ err: loadErr }, "Failed to load post for update");
                    (0, http_1.sendError)(res, "db_error", loadErr.message);
                    return [2 /*return*/];
                }
                if (!existing) {
                    (0, http_1.sendError)(res, "not_found", "Post not found");
                    return [2 /*return*/];
                }
                if (existing.author_id !== user.id) {
                    (0, http_1.sendError)(res, "forbidden", "Only the author can edit this post");
                    return [2 /*return*/];
                }
                nextVisibility = (_e = parsed.data.visibility) !== null && _e !== void 0 ? _e : existing.visibility;
                if (nextVisibility === "trip_only" && !existing.trip_id) {
                    (0, http_1.sendError)(res, "invalid_payload", "Cannot set trip_only on a standalone post");
                    return [2 /*return*/];
                }
                patch = { updated_by: user.id };
                if (parsed.data.content !== undefined)
                    patch.content = parsed.data.content;
                if (parsed.data.mediaUrls !== undefined)
                    patch.media_urls = parsed.data.mediaUrls;
                if (parsed.data.visibility !== undefined)
                    patch.visibility = parsed.data.visibility;
                if (parsed.data.status !== undefined)
                    patch.status = parsed.data.status;
                return [4 /*yield*/, client
                        .from("posts")
                        .update(patch)
                        .eq("id", postId)
                        .eq("author_id", user.id) // belt-and-suspenders ownership guard
                        .select(POST_COLUMNS)
                        .single()];
            case 3:
                _b = _f.sent(), data = _b.data, error = _b.error;
                if (error) {
                    req.log.error({ err: error }, "Failed to update post");
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                res.status(200).json(data);
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * DELETE /posts/:postId  — author-only soft delete
 * ===========================================================================
 * Soft delete (status=deleted, deleted_at=now) so feeds hide it but the row is
 * retained for moderation/audit. Author only.
 */
router.delete("/posts/:postId", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, postId, _a, existing, loadErr, error;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _b.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                postId = req.params.postId;
                return [4 /*yield*/, client
                        .from("posts")
                        .select("id, author_id")
                        .eq("id", postId)
                        .maybeSingle()];
            case 2:
                _a = _b.sent(), existing = _a.data, loadErr = _a.error;
                if (loadErr) {
                    (0, http_1.sendError)(res, "db_error", loadErr.message);
                    return [2 /*return*/];
                }
                if (!existing) {
                    (0, http_1.sendError)(res, "not_found", "Post not found");
                    return [2 /*return*/];
                }
                if (existing.author_id !== user.id) {
                    (0, http_1.sendError)(res, "forbidden", "Only the author can delete this post");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("posts")
                        .update({ status: "deleted", deleted_at: new Date().toISOString(), updated_by: user.id })
                        .eq("id", postId)
                        .eq("author_id", user.id)];
            case 3:
                error = (_b.sent()).error;
                if (error) {
                    req.log.error({ err: error }, "Failed to delete post");
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                res.status(204).send();
                return [2 /*return*/];
        }
    });
}); });
exports.default = router;
