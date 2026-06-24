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
exports._setTestClient = _setTestClient;
exports._clearTestClient = _clearTestClient;
exports.sendError = sendError;
exports.requireUser = requireUser;
exports.requireTripMember = requireTripMember;
exports.isAcceptedTripMember = isAcceptedTripMember;
exports.tripExists = tripExists;
exports.canEditPlan = canEditPlan;
exports.canEditPlanItem = canEditPlanItem;
var supabase_1 = require("./supabase");
// ---------------------------------------------------------------------------
// Test-only client injection — lets unit tests pass a fake Supabase client
// without module-level mocking. Never set in production (env has no test vars).
// ---------------------------------------------------------------------------
var _testClient = null;
var _testReady = null;
/** Call from test helpers before each test to inject a fake client. */
function _setTestClient(client, ready) {
    _testClient = client;
    _testReady = ready;
}
/** Reset after tests if needed (makeApp re-injects, so usually unnecessary). */
function _clearTestClient() {
    _testClient = null;
    _testReady = null;
}
var STATUS = {
    server_not_configured: 503,
    unauthenticated: 401,
    forbidden: 403,
    not_member: 403,
    invalid_payload: 400,
    not_found: 404,
    db_error: 500,
    feature_disabled: 404,
};
function sendError(res, code, message) {
    res.status(STATUS[code]).json({ error: code, message: message !== null && message !== void 0 ? message : code });
}
/**
 * Resolve the authenticated user from the request, using the SERVICE-ROLE
 * client to verify the Bearer token via Supabase Auth (auth.getUser), which
 * verifies ECC P-256 tokens regardless of PostgREST's JWT support.
 *
 * Returns either { client, user } on success, or null after having already
 * written the appropriate error response. Callers should `return` on null.
 *
 * IMPORTANT: the token's user is the ONLY source of identity. Never trust any
 * user_id / author_id supplied in the request body.
 */
function requireUser(req, res) {
    return __awaiter(this, void 0, void 0, function () {
        var ready, authHeader, token, client, _a, data, error;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    ready = _testReady !== null ? _testReady : supabase_1.isServiceClientReady;
                    if (!ready) {
                        sendError(res, "server_not_configured", "SUPABASE_SERVICE_ROLE_KEY is missing");
                        return [2 /*return*/, null];
                    }
                    authHeader = req.headers.authorization;
                    if (!(authHeader === null || authHeader === void 0 ? void 0 : authHeader.startsWith("Bearer "))) {
                        sendError(res, "unauthenticated", "Missing or malformed Authorization header");
                        return [2 /*return*/, null];
                    }
                    token = authHeader.slice(7).trim();
                    if (!token) {
                        sendError(res, "unauthenticated", "Empty bearer token");
                        return [2 /*return*/, null];
                    }
                    client = (_testClient !== null && _testClient !== void 0 ? _testClient : (0, supabase_1.getServiceClient)());
                    return [4 /*yield*/, client.auth.getUser(token)];
                case 1:
                    _a = _c.sent(), data = _a.data, error = _a.error;
                    if (error || !(data === null || data === void 0 ? void 0 : data.user)) {
                        sendError(res, "unauthenticated", (_b = error === null || error === void 0 ? void 0 : error.message) !== null && _b !== void 0 ? _b : "Invalid or expired token");
                        return [2 /*return*/, null];
                    }
                    return [2 /*return*/, { client: client, user: data.user }];
            }
        });
    });
}
/**
 * Unified membership lookup for trip routes.
 *
 * Returns the membership row `{ role }` when the user is a trip member, or
 * `null` when they are not (or when a DB error occurs).
 *
 * Options:
 *   status: "accepted" (default) — only owner/member rows qualify.
 *   status: "any"                — any role including "invited" qualifies.
 *
 * Callers that only need a boolean can call `isAcceptedTripMember`, which
 * delegates here and is kept for back-compat.
 */
function requireTripMember(client_1, tripId_1, userId_1) {
    return __awaiter(this, arguments, void 0, function (client, tripId, userId, options) {
        var _a, status, query, _b, data, error;
        if (options === void 0) { options = {}; }
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    _a = options.status, status = _a === void 0 ? "accepted" : _a;
                    query = client
                        .from("trip_members")
                        .select("role")
                        .eq("trip_id", tripId)
                        .eq("user_id", userId);
                    if (status === "accepted") {
                        query = query.in("role", ["owner", "member"]);
                    }
                    return [4 /*yield*/, query.maybeSingle()];
                case 1:
                    _b = _c.sent(), data = _b.data, error = _b.error;
                    if (error || !data)
                        return [2 /*return*/, null];
                    return [2 /*return*/, { role: data.role }];
            }
        });
    });
}
/**
 * Is `userId` an ACCEPTED participant (owner or member, NOT 'invited') of the
 * trip? Delegates to requireTripMember. Kept for back-compat.
 */
function isAcceptedTripMember(client, tripId, userId) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, requireTripMember(client, tripId, userId)];
                case 1: return [2 /*return*/, (_a.sent()) !== null];
            }
        });
    });
}
/** Does the trip exist? (service-role read) */
function tripExists(client, tripId) {
    return __awaiter(this, void 0, void 0, function () {
        var _a, data, error;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, client
                        .from("trips")
                        .select("id")
                        .eq("id", tripId)
                        .maybeSingle()];
                case 1:
                    _a = _b.sent(), data = _a.data, error = _a.error;
                    if (error)
                        return [2 /*return*/, false];
                    return [2 /*return*/, Boolean(data)];
            }
        });
    });
}
/**
 * Checks whether `userId` has trip-level permission to add or edit plan items.
 *
 * Rules:
 *   - Trip owner is always permitted.
 *   - 'all_members': any accepted member is permitted.
 *   - 'owner_only': only the owner is permitted.
 *   - 'specific_members': owner + users listed in plan_editors are permitted.
 *
 * Returns true/false. Does NOT write any HTTP response.
 * Returns null when the trip is not found (caller should treat as 403/404).
 */
function canEditPlan(client, tripId, userId) {
    return __awaiter(this, void 0, void 0, function () {
        var trip, ownerId, perm, membership, editorRow;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, client
                        .from("trips")
                        .select("owner_id, plan_edit_permission")
                        .eq("id", tripId)
                        .maybeSingle()];
                case 1:
                    trip = (_b.sent()).data;
                    if (!trip)
                        return [2 /*return*/, null];
                    ownerId = trip.owner_id;
                    perm = (_a = trip.plan_edit_permission) !== null && _a !== void 0 ? _a : "all_members";
                    if (userId === ownerId)
                        return [2 /*return*/, true];
                    return [4 /*yield*/, requireTripMember(client, tripId, userId)];
                case 2:
                    membership = _b.sent();
                    if (!membership)
                        return [2 /*return*/, false];
                    if (perm === "all_members")
                        return [2 /*return*/, true];
                    if (perm === "owner_only")
                        return [2 /*return*/, false];
                    return [4 /*yield*/, client
                            .from("plan_editors")
                            .select("user_id")
                            .eq("trip_id", tripId)
                            .eq("user_id", userId)
                            .maybeSingle()];
                case 3:
                    editorRow = (_b.sent()).data;
                    return [2 /*return*/, Boolean(editorRow)];
            }
        });
    });
}
/**
 * Single authoritative check for edit / remove / reorder operations on a
 * trip plan item.  Consolidates item-fetch + membership-check + ownership
 * rule so every mutating route applies the same logic from one place.
 *
 * Rules (default, ownerOnly = false):
 *   - Item must exist and not be soft-deleted  → not_found
 *   - Caller must be an accepted member         → not_member
 *   - Trip owner may edit any item              → permitted
 *   - Member may only edit their own item       → forbidden if creator_id ≠ userId
 *
 * When ownerOnly = true (reorder):
 *   - Item must exist and not be soft-deleted   → not_found
 *   - Caller must be accepted member            → not_member
 *   - Caller must be trip owner                 → forbidden otherwise
 *
 * No HTTP response is written; callers inspect the result and decide.
 */
function canEditPlanItem(client_1, tripId_1, itemId_1, userId_1) {
    return __awaiter(this, arguments, void 0, function (client, tripId, itemId, userId, ownerOnly) {
        var item, membership, role, creatorId;
        if (ownerOnly === void 0) { ownerOnly = false; }
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, client
                        .from("trip_plan_items")
                        .select("creator_id")
                        .eq("id", itemId)
                        .eq("trip_id", tripId)
                        .is("removed_at", null)
                        .maybeSingle()];
                case 1:
                    item = (_a.sent()).data;
                    if (!item) {
                        return [2 /*return*/, { permitted: false, code: "not_found", message: "Plan item not found" }];
                    }
                    return [4 /*yield*/, requireTripMember(client, tripId, userId)];
                case 2:
                    membership = _a.sent();
                    if (!membership) {
                        return [2 /*return*/, { permitted: false, code: "not_member", message: "Not a trip member" }];
                    }
                    role = membership.role;
                    creatorId = item.creator_id;
                    if (ownerOnly) {
                        if (role !== "owner") {
                            return [2 /*return*/, { permitted: false, code: "forbidden", message: "Only the trip owner can reorder plan items" }];
                        }
                        return [2 /*return*/, { permitted: true, role: role, creatorId: creatorId }];
                    }
                    if (role !== "owner" && creatorId !== userId) {
                        return [2 /*return*/, { permitted: false, code: "forbidden", message: "You can only edit your own plan items" }];
                    }
                    return [2 /*return*/, { permitted: true, role: role, creatorId: creatorId }];
            }
        });
    });
}
