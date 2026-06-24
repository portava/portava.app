"use strict";
/**
 * Telegraph realtime delivery — Server-Sent Events (SSE) transport.
 *
 * GET  /api/telegraph/stream   — long-lived SSE connection; pushes per-user
 *                                events from the in-memory bus (telegraphEvents).
 * POST /api/threads/:threadId/typing — typing relay (no persistence); fans out
 *                                typing.started / typing.stopped to other members.
 *
 * Auth: SSE clients (EventSource) cannot set Authorization headers, so the
 * stream accepts the bearer token either in the Authorization header OR a
 * `?token=` query param. The token is verified via Supabase Auth getUser()
 * (Auth endpoint, not PostgREST) exactly like requireUser().
 *
 * The mobile client always retains polling as a fallback, so this transport is
 * an enhancement, never a hard dependency.
 */
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
var supabase_1 = require("../lib/supabase");
var http_1 = require("../lib/http");
var telegraphEvents_1 = require("../lib/telegraphEvents");
var router = (0, express_1.Router)();
var UUID = /^[0-9a-f-]{36}$/i;
/** Heartbeat keeps proxies from closing the idle socket and detects dead peers. */
var HEARTBEAT_MS = 25000;
router.get("/telegraph/stream", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var authHeader, token, sc, _a, data, error, userId, send, unsubscribe, heartbeat, cleanedUp, cleanup;
    var _b;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0:
                authHeader = req.headers.authorization;
                token = null;
                if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
                    token = authHeader.slice(7).trim();
                }
                else if (typeof req.query.token === "string" && req.query.token) {
                    token = req.query.token;
                }
                if (!token) {
                    (0, http_1.sendError)(res, "unauthenticated", "Missing token");
                    return [2 /*return*/];
                }
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, "server_not_configured", "Service client not ready");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc.auth.getUser(token)];
            case 1:
                _a = _c.sent(), data = _a.data, error = _a.error;
                if (error || !(data === null || data === void 0 ? void 0 : data.user)) {
                    (0, http_1.sendError)(res, "unauthenticated", "Invalid token");
                    return [2 /*return*/];
                }
                userId = data.user.id;
                // Open the SSE stream.
                res.writeHead(200, {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache, no-transform",
                    Connection: "keep-alive",
                    // Disable proxy buffering so events flush immediately.
                    "X-Accel-Buffering": "no",
                });
                res.write("event: connected\ndata: ".concat(JSON.stringify({ userId: userId, ts: new Date().toISOString() }), "\n\n"));
                send = function (evt) {
                    try {
                        res.write("event: ".concat(evt.type, "\ndata: ").concat(JSON.stringify(evt), "\n\n"));
                    }
                    catch (_a) {
                        // Socket is closing; cleanup handlers will run.
                    }
                };
                unsubscribe = (0, telegraphEvents_1.subscribe)(userId, send);
                heartbeat = setInterval(function () {
                    try {
                        res.write(": ping ".concat(Date.now(), "\n\n"));
                    }
                    catch (_a) {
                        // ignore — cleanup will handle a dead socket
                    }
                }, HEARTBEAT_MS);
                (_b = heartbeat.unref) === null || _b === void 0 ? void 0 : _b.call(heartbeat);
                cleanedUp = false;
                cleanup = function () {
                    if (cleanedUp)
                        return;
                    cleanedUp = true;
                    clearInterval(heartbeat);
                    unsubscribe();
                };
                req.on("close", cleanup);
                res.on("close", cleanup);
                res.on("error", cleanup);
                return [2 /*return*/];
        }
    });
}); });
/**
 * POST /api/threads/:threadId/typing
 * Body: { typing: boolean }
 * Relays a typing indicator to the other active members of the thread. Not
 * persisted — purely transient presence. Members-only.
 */
router.post("/threads/:threadId/typing", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, threadId, typing, membership;
    var _a;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _b.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                threadId = req.params.threadId;
                if (!UUID.test(threadId)) {
                    (0, http_1.sendError)(res, "invalid_payload", "Invalid thread id");
                    return [2 /*return*/];
                }
                typing = ((_a = req.body) === null || _a === void 0 ? void 0 : _a.typing) === true;
                return [4 /*yield*/, client
                        .from("message_thread_members")
                        .select("user_id")
                        .eq("thread_id", threadId)
                        .eq("user_id", user.id)
                        .is("left_at", null)
                        .maybeSingle()];
            case 2:
                membership = (_b.sent()).data;
                if (!membership) {
                    (0, http_1.sendError)(res, "forbidden", "Not a member of this thread");
                    return [2 /*return*/];
                }
                // Fire-and-forget fan-out; never block the response on delivery.
                void (0, telegraphEvents_1.publishToThread)(client, threadId, {
                    type: typing ? "typing.started" : "typing.stopped",
                    payload: { userId: user.id },
                }, { excludeUserId: user.id });
                res.status(200).json({ ok: true, typing: typing });
                return [2 /*return*/];
        }
    });
}); });
exports.default = router;
