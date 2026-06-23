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
var vitest_1 = require("vitest");
var supertest_1 = require("supertest");
var helpers_1 = require("./helpers");
/**
 * Backend authorization tests for the posts API. Each test stages an in-memory
 * DB state and drives the real route handlers via supertest. These prove the
 * security rules WITHOUT a live database (the fake client mirrors the subset of
 * supabase-js the routes use).
 *
 * Identity tokens used:
 *   "owner-tok"  -> user owner-1   (trip owner)
 *   "member-tok" -> user member-1  (accepted member)
 *   "invited-tok"-> user invited-1 (invited, NOT accepted)
 *   "stranger-tok"-> user stranger-1 (no trip relation)
 *   "bad-tok"    -> invalid (auth.getUser fails)
 */
var TRIP = "trip-1";
function baseState() {
    return {
        users: {
            "owner-tok": { id: "owner-1" },
            "member-tok": { id: "member-1" },
            "invited-tok": { id: "invited-1" },
            "stranger-tok": { id: "stranger-1" },
            // bad-tok intentionally absent -> getUser returns null
        },
        trips: new Set([TRIP]),
        members: [
            { trip_id: TRIP, user_id: "owner-1", role: "owner" },
            { trip_id: TRIP, user_id: "member-1", role: "member" },
            { trip_id: TRIP, user_id: "invited-1", role: "invited" }, // not accepted
        ],
        posts: [],
    };
}
(0, vitest_1.beforeEach)(function () {
    vitest_1.vi.resetModules();
});
(0, vitest_1.describe)("POST /api/posts — create", function () {
    (0, vitest_1.it)("1. authenticated user can create a standalone post", function () { return __awaiter(void 0, void 0, void 0, function () {
        var app, res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, helpers_1.makeApp)(baseState())];
                case 1:
                    app = (_a.sent()).app;
                    return [4 /*yield*/, (0, supertest_1.default)(app)
                            .post("/api/posts")
                            .set((0, helpers_1.BEARER)("member-tok"))
                            .send({ content: "hello world", visibility: "public" })];
                case 2:
                    res = _a.sent();
                    (0, vitest_1.expect)(res.status).toBe(201);
                    (0, vitest_1.expect)(res.body.author_id).toBe("member-1");
                    (0, vitest_1.expect)(res.body.trip_id).toBeNull();
                    return [2 /*return*/];
            }
        });
    }); });
    (0, vitest_1.it)("2. server sets author_id from the verified token, ignoring client author_id", function () { return __awaiter(void 0, void 0, void 0, function () {
        var _a, app, client, res, insertedPost;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, (0, helpers_1.makeApp)(baseState())];
                case 1:
                    _a = _b.sent(), app = _a.app, client = _a.client;
                    return [4 /*yield*/, (0, supertest_1.default)(app)
                            .post("/api/posts")
                            .set((0, helpers_1.BEARER)("member-tok"))
                            .send({ content: "x", author_id: "owner-1", user_id: "owner-1", created_by: "owner-1" })];
                case 2:
                    res = _b.sent();
                    (0, vitest_1.expect)(res.status).toBe(201);
                    insertedPost = client.__inserted.find(function (r) { return r.table === "posts"; });
                    (0, vitest_1.expect)(insertedPost.row.author_id).toBe("member-1");
                    (0, vitest_1.expect)(insertedPost.row.created_by).toBe("member-1");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, vitest_1.it)("3. unauthenticated request (no token) fails 401", function () { return __awaiter(void 0, void 0, void 0, function () {
        var app, res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, helpers_1.makeApp)(baseState())];
                case 1:
                    app = (_a.sent()).app;
                    return [4 /*yield*/, (0, supertest_1.default)(app).post("/api/posts").send({ content: "x" })];
                case 2:
                    res = _a.sent();
                    (0, vitest_1.expect)(res.status).toBe(401);
                    (0, vitest_1.expect)(res.body.error).toBe("unauthenticated");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, vitest_1.it)("3b. invalid/expired token fails 401", function () { return __awaiter(void 0, void 0, void 0, function () {
        var app, res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, helpers_1.makeApp)(baseState())];
                case 1:
                    app = (_a.sent()).app;
                    return [4 /*yield*/, (0, supertest_1.default)(app).post("/api/posts").set((0, helpers_1.BEARER)("bad-tok")).send({ content: "x" })];
                case 2:
                    res = _a.sent();
                    (0, vitest_1.expect)(res.status).toBe(401);
                    (0, vitest_1.expect)(res.body.error).toBe("unauthenticated");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, vitest_1.it)("4. empty payload (no content, no media) fails 400 invalid_payload", function () { return __awaiter(void 0, void 0, void 0, function () {
        var app, res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, helpers_1.makeApp)(baseState())];
                case 1:
                    app = (_a.sent()).app;
                    return [4 /*yield*/, (0, supertest_1.default)(app).post("/api/posts").set((0, helpers_1.BEARER)("member-tok")).send({})];
                case 2:
                    res = _a.sent();
                    (0, vitest_1.expect)(res.status).toBe(400);
                    (0, vitest_1.expect)(res.body.error).toBe("invalid_payload");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, vitest_1.it)("5. owner can post to their trip feed", function () { return __awaiter(void 0, void 0, void 0, function () {
        var app, res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, helpers_1.makeApp)(baseState())];
                case 1:
                    app = (_a.sent()).app;
                    return [4 /*yield*/, (0, supertest_1.default)(app)
                            .post("/api/posts")
                            .set((0, helpers_1.BEARER)("owner-tok"))
                            .send({ content: "trip note", tripId: TRIP, visibility: "trip_only" })];
                case 2:
                    res = _a.sent();
                    (0, vitest_1.expect)(res.status).toBe(201);
                    (0, vitest_1.expect)(res.body.trip_id).toBe(TRIP);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, vitest_1.it)("6. accepted member can post to the trip feed", function () { return __awaiter(void 0, void 0, void 0, function () {
        var app, res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, helpers_1.makeApp)(baseState())];
                case 1:
                    app = (_a.sent()).app;
                    return [4 /*yield*/, (0, supertest_1.default)(app)
                            .post("/api/posts")
                            .set((0, helpers_1.BEARER)("member-tok"))
                            .send({ content: "member note", tripId: TRIP, visibility: "trip_only" })];
                case 2:
                    res = _a.sent();
                    (0, vitest_1.expect)(res.status).toBe(201);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, vitest_1.it)("7. invited-but-not-accepted user CANNOT post to the trip feed (403 not_member)", function () { return __awaiter(void 0, void 0, void 0, function () {
        var app, res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, helpers_1.makeApp)(baseState())];
                case 1:
                    app = (_a.sent()).app;
                    return [4 /*yield*/, (0, supertest_1.default)(app)
                            .post("/api/posts")
                            .set((0, helpers_1.BEARER)("invited-tok"))
                            .send({ content: "sneaky", tripId: TRIP, visibility: "trip_only" })];
                case 2:
                    res = _a.sent();
                    (0, vitest_1.expect)(res.status).toBe(403);
                    (0, vitest_1.expect)(res.body.error).toBe("not_member");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, vitest_1.it)("8. non-member (stranger) cannot post to the trip feed (403 not_member)", function () { return __awaiter(void 0, void 0, void 0, function () {
        var app, res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, helpers_1.makeApp)(baseState())];
                case 1:
                    app = (_a.sent()).app;
                    return [4 /*yield*/, (0, supertest_1.default)(app)
                            .post("/api/posts")
                            .set((0, helpers_1.BEARER)("stranger-tok"))
                            .send({ content: "intrude", tripId: TRIP, visibility: "public" })];
                case 2:
                    res = _a.sent();
                    (0, vitest_1.expect)(res.status).toBe(403);
                    (0, vitest_1.expect)(res.body.error).toBe("not_member");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, vitest_1.it)("9. posting to a non-existent trip fails 404 not_found", function () { return __awaiter(void 0, void 0, void 0, function () {
        var app, res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, helpers_1.makeApp)(baseState())];
                case 1:
                    app = (_a.sent()).app;
                    return [4 /*yield*/, (0, supertest_1.default)(app)
                            .post("/api/posts")
                            .set((0, helpers_1.BEARER)("owner-tok"))
                            .send({ content: "x", tripId: "trip-does-not-exist" })];
                case 2:
                    res = _a.sent();
                    (0, vitest_1.expect)(res.status).toBe(404);
                    (0, vitest_1.expect)(res.body.error).toBe("not_found");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, vitest_1.it)("10. trip_only without tripId fails 400 (cross-field rule)", function () { return __awaiter(void 0, void 0, void 0, function () {
        var app, res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, helpers_1.makeApp)(baseState())];
                case 1:
                    app = (_a.sent()).app;
                    return [4 /*yield*/, (0, supertest_1.default)(app)
                            .post("/api/posts")
                            .set((0, helpers_1.BEARER)("member-tok"))
                            .send({ content: "x", visibility: "trip_only" })];
                case 2:
                    res = _a.sent();
                    (0, vitest_1.expect)(res.status).toBe(400);
                    (0, vitest_1.expect)(res.body.error).toBe("invalid_payload");
                    return [2 /*return*/];
            }
        });
    }); });
});
(0, vitest_1.describe)("GET /api/posts — global feed", function () {
    (0, vitest_1.it)("11. global feed returns only public standalone active posts (no trip_only/private leak)", function () { return __awaiter(void 0, void 0, void 0, function () {
        var st, app, res, ids;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    st = baseState();
                    st.posts = [
                        { id: "p1", author_id: "member-1", trip_id: null, visibility: "public", status: "active", content: "a", media_urls: [], created_at: "2026-01-03" },
                        { id: "p2", author_id: "member-1", trip_id: null, visibility: "private", status: "active", content: "secret", media_urls: [], created_at: "2026-01-02" },
                        { id: "p3", author_id: "owner-1", trip_id: TRIP, visibility: "trip_only", status: "active", content: "trip", media_urls: [], created_at: "2026-01-01" },
                    ];
                    return [4 /*yield*/, (0, helpers_1.makeApp)(st)];
                case 1:
                    app = (_a.sent()).app;
                    return [4 /*yield*/, (0, supertest_1.default)(app).get("/api/posts").set((0, helpers_1.BEARER)("stranger-tok"))];
                case 2:
                    res = _a.sent();
                    (0, vitest_1.expect)(res.status).toBe(200);
                    ids = res.body.posts.map(function (p) { return p.id; });
                    (0, vitest_1.expect)(ids).toContain("p1");
                    (0, vitest_1.expect)(ids).not.toContain("p2"); // private must not leak
                    (0, vitest_1.expect)(ids).not.toContain("p3"); // trip_only must not leak
                    return [2 /*return*/];
            }
        });
    }); });
});
(0, vitest_1.describe)("PATCH /api/posts/:id — author-only edit", function () {
    (0, vitest_1.it)("12. author can edit their own post", function () { return __awaiter(void 0, void 0, void 0, function () {
        var st, app, res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    st = baseState();
                    st.posts = [{ id: "p1", author_id: "member-1", trip_id: null, visibility: "public", status: "active", content: "old", media_urls: [] }];
                    return [4 /*yield*/, (0, helpers_1.makeApp)(st)];
                case 1:
                    app = (_a.sent()).app;
                    return [4 /*yield*/, (0, supertest_1.default)(app).patch("/api/posts/p1").set((0, helpers_1.BEARER)("member-tok")).send({ content: "new" })];
                case 2:
                    res = _a.sent();
                    (0, vitest_1.expect)(res.status).toBe(200);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, vitest_1.it)("13. non-author cannot edit another user's post (403 forbidden)", function () { return __awaiter(void 0, void 0, void 0, function () {
        var st, app, res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    st = baseState();
                    st.posts = [{ id: "p1", author_id: "member-1", trip_id: null, visibility: "public", status: "active", content: "old", media_urls: [] }];
                    return [4 /*yield*/, (0, helpers_1.makeApp)(st)];
                case 1:
                    app = (_a.sent()).app;
                    return [4 /*yield*/, (0, supertest_1.default)(app).patch("/api/posts/p1").set((0, helpers_1.BEARER)("stranger-tok")).send({ content: "hijack" })];
                case 2:
                    res = _a.sent();
                    (0, vitest_1.expect)(res.status).toBe(403);
                    (0, vitest_1.expect)(res.body.error).toBe("forbidden");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, vitest_1.it)("14. cannot set trip_only on a standalone post (400)", function () { return __awaiter(void 0, void 0, void 0, function () {
        var st, app, res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    st = baseState();
                    st.posts = [{ id: "p1", author_id: "member-1", trip_id: null, visibility: "public", status: "active", content: "x", media_urls: [] }];
                    return [4 /*yield*/, (0, helpers_1.makeApp)(st)];
                case 1:
                    app = (_a.sent()).app;
                    return [4 /*yield*/, (0, supertest_1.default)(app).patch("/api/posts/p1").set((0, helpers_1.BEARER)("member-tok")).send({ visibility: "trip_only" })];
                case 2:
                    res = _a.sent();
                    (0, vitest_1.expect)(res.status).toBe(400);
                    (0, vitest_1.expect)(res.body.error).toBe("invalid_payload");
                    return [2 /*return*/];
            }
        });
    }); });
});
(0, vitest_1.describe)("DELETE /api/posts/:id — author-only soft delete", function () {
    (0, vitest_1.it)("15. author can soft-delete their own post", function () { return __awaiter(void 0, void 0, void 0, function () {
        var st, _a, app, client, res;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    st = baseState();
                    st.posts = [{ id: "p1", author_id: "member-1", trip_id: null, visibility: "public", status: "active", content: "x", media_urls: [] }];
                    return [4 /*yield*/, (0, helpers_1.makeApp)(st)];
                case 1:
                    _a = _b.sent(), app = _a.app, client = _a.client;
                    return [4 /*yield*/, (0, supertest_1.default)(app).delete("/api/posts/p1").set((0, helpers_1.BEARER)("member-tok"))];
                case 2:
                    res = _b.sent();
                    (0, vitest_1.expect)(res.status).toBe(204);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, vitest_1.it)("16. non-author cannot delete another user's post (403 forbidden)", function () { return __awaiter(void 0, void 0, void 0, function () {
        var st, app, res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    st = baseState();
                    st.posts = [{ id: "p1", author_id: "member-1", trip_id: null, visibility: "public", status: "active", content: "x", media_urls: [] }];
                    return [4 /*yield*/, (0, helpers_1.makeApp)(st)];
                case 1:
                    app = (_a.sent()).app;
                    return [4 /*yield*/, (0, supertest_1.default)(app).delete("/api/posts/p1").set((0, helpers_1.BEARER)("stranger-tok"))];
                case 2:
                    res = _a.sent();
                    (0, vitest_1.expect)(res.status).toBe(403);
                    (0, vitest_1.expect)(res.body.error).toBe("forbidden");
                    return [2 /*return*/];
            }
        });
    }); });
});
(0, vitest_1.describe)("GET /api/trips/:tripId/posts — trip feed membership", function () {
    (0, vitest_1.it)("17. non-member request to trip feed succeeds but is flagged isMember=false", function () { return __awaiter(void 0, void 0, void 0, function () {
        var app, res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, helpers_1.makeApp)(baseState())];
                case 1:
                    app = (_a.sent()).app;
                    return [4 /*yield*/, (0, supertest_1.default)(app).get("/api/trips/".concat(TRIP, "/posts")).set((0, helpers_1.BEARER)("stranger-tok"))];
                case 2:
                    res = _a.sent();
                    (0, vitest_1.expect)(res.status).toBe(200);
                    (0, vitest_1.expect)(res.body.isMember).toBe(false);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, vitest_1.it)("17b. accepted member sees isMember=true", function () { return __awaiter(void 0, void 0, void 0, function () {
        var app, res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, helpers_1.makeApp)(baseState())];
                case 1:
                    app = (_a.sent()).app;
                    return [4 /*yield*/, (0, supertest_1.default)(app).get("/api/trips/".concat(TRIP, "/posts")).set((0, helpers_1.BEARER)("member-tok"))];
                case 2:
                    res = _a.sent();
                    (0, vitest_1.expect)(res.status).toBe(200);
                    (0, vitest_1.expect)(res.body.isMember).toBe(true);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, vitest_1.it)("17c. invited user is NOT counted as a member (isMember=false)", function () { return __awaiter(void 0, void 0, void 0, function () {
        var app, res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, helpers_1.makeApp)(baseState())];
                case 1:
                    app = (_a.sent()).app;
                    return [4 /*yield*/, (0, supertest_1.default)(app).get("/api/trips/".concat(TRIP, "/posts")).set((0, helpers_1.BEARER)("invited-tok"))];
                case 2:
                    res = _a.sent();
                    (0, vitest_1.expect)(res.status).toBe(200);
                    (0, vitest_1.expect)(res.body.isMember).toBe(false);
                    return [2 /*return*/];
            }
        });
    }); });
});
