"use strict";
/**
 * Telegraph realtime event bus.
 *
 * An in-memory pub/sub used by the SSE delivery layer (telegraphStream route).
 * Mutating routes publish small, structured events to the set of affected
 * users; each open SSE connection registers one subscriber callback.
 *
 * Single-instance delivery is handled by `publishToUsersLocal`, which writes
 * directly to the in-memory subscriber map.  `publishToUsers` additionally
 * calls the broadcast hook (when registered) so the same event reaches clients
 * connected to other server instances via the cross-instance channel
 * (telegraphBroadcast).
 *
 * The bus never throws into callers — publish failures are logged and swallowed
 * so realtime delivery can never break a write path.  The mobile client always
 * keeps a polling fallback, so any missed event self-heals on the next poll.
 */
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
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
exports.setBroadcastHook = setBroadcastHook;
exports.subscribe = subscribe;
exports.connectedUserCount = connectedUserCount;
exports.isUserConnected = isUserConnected;
exports.publishToUsersLocal = publishToUsersLocal;
exports.publishToUsers = publishToUsers;
exports.publishToThread = publishToThread;
var logger_1 = require("./logger");
/** userId -> set of subscriber callbacks (one per open SSE connection). */
var subscribers = new Map();
// ── Cross-instance broadcast hook ─────────────────────────────────────────────
/**
 * Optional hook registered by telegraphBroadcast at startup.  When set,
 * publishToUsers fans the event out to other server instances after local
 * delivery.
 */
var _broadcastHook = null;
/**
 * Register the cross-instance broadcast hook.  Called once at server startup
 * by initTelegraphBroadcast().  Subsequent calls replace the previous hook.
 */
function setBroadcastHook(hook) {
    _broadcastHook = hook;
}
// ── Subscriber management ─────────────────────────────────────────────────────
/**
 * Register a subscriber for a user. Returns an unsubscribe function that must
 * be called when the connection closes.
 */
function subscribe(userId, cb) {
    var set = subscribers.get(userId);
    if (!set) {
        set = new Set();
        subscribers.set(userId, set);
    }
    set.add(cb);
    return function () {
        var s = subscribers.get(userId);
        if (!s)
            return;
        s.delete(cb);
        if (s.size === 0)
            subscribers.delete(userId);
    };
}
/** Number of distinct users with at least one live connection. */
function connectedUserCount() {
    return subscribers.size;
}
/** Whether a user currently has at least one live connection. */
function isUserConnected(userId) {
    var s = subscribers.get(userId);
    return Boolean(s && s.size > 0);
}
// ── Delivery ──────────────────────────────────────────────────────────────────
/**
 * Deliver an event to local subscribers only (no cross-instance fan-out).
 * Used by telegraphBroadcast when it receives a remote event so it doesn't
 * re-broadcast and cause infinite loops.
 */
function publishToUsersLocal(userIds, event) {
    for (var _i = 0, userIds_1 = userIds; _i < userIds_1.length; _i++) {
        var uid = userIds_1[_i];
        if (!uid)
            continue;
        var set = subscribers.get(uid);
        if (!set)
            continue;
        for (var _a = 0, set_1 = set; _a < set_1.length; _a++) {
            var cb = set_1[_a];
            try {
                cb(event);
            }
            catch (err) {
                logger_1.logger.warn({ err: err, type: event.type }, "telegraph remote subscriber callback threw");
            }
        }
    }
}
/**
 * Publish an event to an explicit set of user ids.  De-duplicates ids,
 * delivers to local subscribers, then fans out to other instances via the
 * registered broadcast hook (if any).  Never throws.
 */
function publishToUsers(userIds, event) {
    var _a;
    var full = __assign(__assign({}, event), { ts: (_a = event.ts) !== null && _a !== void 0 ? _a : new Date().toISOString() });
    var seen = new Set();
    for (var _i = 0, userIds_2 = userIds; _i < userIds_2.length; _i++) {
        var uid = userIds_2[_i];
        if (!uid || seen.has(uid))
            continue;
        seen.add(uid);
        var set = subscribers.get(uid);
        if (!set)
            continue;
        for (var _b = 0, set_2 = set; _b < set_2.length; _b++) {
            var cb = set_2[_b];
            try {
                cb(full);
            }
            catch (err) {
                logger_1.logger.warn({ err: err, type: full.type }, "telegraph subscriber callback threw");
            }
        }
    }
    // Fan out to other instances — fire-and-forget, never block callers.
    if (_broadcastHook && seen.size > 0) {
        try {
            _broadcastHook(Array.from(seen), full);
        }
        catch (err) {
            logger_1.logger.warn({ err: err, type: full.type }, "telegraph broadcast hook threw");
        }
    }
}
/**
 * Resolve the active members of a thread (left_at IS NULL) and publish to them,
 * optionally excluding one user (typically the actor). Best-effort: a failure
 * to resolve members is logged and swallowed.
 */
function publishToThread(sc_1, threadId_1, event_1) {
    return __awaiter(this, arguments, void 0, function (sc, threadId, event, options) {
        var data, userIds, err_1;
        if (options === void 0) { options = {}; }
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, sc
                            .from("message_thread_members")
                            .select("user_id")
                            .eq("thread_id", threadId)
                            .is("left_at", null)];
                case 1:
                    data = (_a.sent()).data;
                    userIds = (data !== null && data !== void 0 ? data : [])
                        .map(function (r) { return r.user_id; })
                        .filter(function (uid) { return Boolean(uid) && uid !== options.excludeUserId; });
                    if (userIds.length === 0)
                        return [2 /*return*/];
                    publishToUsers(userIds, __assign(__assign({}, event), { threadId: threadId }));
                    return [3 /*break*/, 3];
                case 2:
                    err_1 = _a.sent();
                    logger_1.logger.warn({ err: err_1, threadId: threadId, type: event.type }, "publishToThread failed to resolve members");
                    return [3 /*break*/, 3];
                case 3: return [2 /*return*/];
            }
        });
    });
}
