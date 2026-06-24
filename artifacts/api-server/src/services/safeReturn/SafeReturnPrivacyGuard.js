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
exports.stripGPS = stripGPS;
exports.toPublicSession = toPublicSession;
exports.toPublicContact = toPublicContact;
exports.requireSafeReturnRecipient = requireSafeReturnRecipient;
var http_1 = require("../../lib/http");
var supabase_1 = require("../../lib/supabase");
// ── GPS stripping ─────────────────────────────────────────────────────────────
/** Fields that must never appear in public Safe Return API responses. */
var GPS_FIELDS = ["lat", "lng", "latitude", "longitude", "coords", "coordinates"];
/**
 * Deeply remove GPS fields from an object.  Safe to call on null/undefined.
 * Returns a new object (does not mutate the original).
 */
function stripGPS(obj) {
    if (!obj || typeof obj !== "object")
        return obj;
    var result = Array.isArray(obj) ? [] : {};
    for (var _i = 0, _a = Object.keys(obj); _i < _a.length; _i++) {
        var key = _a[_i];
        if (GPS_FIELDS.includes(key))
            continue;
        var val = obj[key];
        result[key] = val && typeof val === "object" ? stripGPS(val) : val;
    }
    return result;
}
/**
 * Public-safe session shape: strip GPS and internal metadata.
 * Call this before every session response.
 */
function toPublicSession(session) {
    return stripGPS({
        id: session.id,
        status: session.status,
        escalationLevel: session.escalationLevel,
        timerStartAt: session.timerStartAt,
        timerEndAt: session.timerEndAt,
        trustedCircleEnabled: session.trustedCircleEnabled,
        liveShareEnabled: session.liveShareEnabled,
        notifyHostEnabled: session.notifyHostEnabled,
        notifyTripCrewEnabled: session.notifyTripCrewEnabled,
        planItemId: session.planItemId,
        tripId: session.tripId,
        triggerReason: session.triggerReason,
        emergencyNote: session.emergencyNote,
        closedAt: session.closedAt,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        // Deliberately excluded: userId (implied by auth), lastSafeConfirmationAt (internal)
    });
}
/**
 * Public-safe contact shape: strip phone/email unless the caller is the owner.
 */
function toPublicContact(contact, isOwner) {
    var base = {
        id: contact.id,
        sessionId: contact.sessionId,
        contactUserId: contact.contactUserId,
        contactName: contact.contactName,
        contactMethod: contact.contactMethod,
        canReceiveLiveLocation: contact.canReceiveLiveLocation,
        notifiedAt: contact.notifiedAt,
        acknowledgedAt: contact.acknowledgedAt,
    };
    // Only expose phone/email to the session owner
    if (isOwner) {
        base.contactPhone = contact.contactPhone;
        base.contactEmail = contact.contactEmail;
    }
    return base;
}
// ── requireSafeReturnRecipient middleware ─────────────────────────────────────
/**
 * Express middleware that verifies the authenticated user is an authorized
 * recipient of the live share identified by req.params.shareId.
 *
 * On success: attaches { shareId, callerUserId, db } to req.safeReturnRecipient.
 * On failure: sends the appropriate error response and calls next() without
 * setting the attachment (route should guard on its absence).
 *
 * Use on: GET /api/safe-return/live-share/:shareId
 */
function requireSafeReturnRecipient(req, res, next) {
    return __awaiter(this, void 0, void 0, function () {
        var auth, shareId, db, share, s;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
                case 1:
                    auth = _b.sent();
                    if (!auth)
                        return [2 /*return*/]; // requireUser already sent the error
                    shareId = req.params.shareId;
                    if (!shareId) {
                        (0, http_1.sendError)(res, "invalid_payload", "shareId is required");
                        return [2 /*return*/];
                    }
                    db = (_a = (0, supabase_1.getServiceClient)()) !== null && _a !== void 0 ? _a : auth.client;
                    if (!db) {
                        (0, http_1.sendError)(res, "server_not_configured");
                        return [2 /*return*/];
                    }
                    return [4 /*yield*/, db
                            .from("safe_return_live_shares")
                            .select("id, user_id, recipient_user_id, recipient_contact_id, status, expires_at")
                            .eq("id", shareId)
                            .maybeSingle()];
                case 2:
                    share = (_b.sent()).data;
                    if (!share) {
                        (0, http_1.sendError)(res, "not_found", "Live share not found");
                        return [2 /*return*/];
                    }
                    s = share;
                    // Hard expiry check
                    if (s.expires_at && new Date(s.expires_at) < new Date()) {
                        (0, http_1.sendError)(res, "not_found", "Live share has expired");
                        return [2 /*return*/];
                    }
                    if (s.status !== "active") {
                        (0, http_1.sendError)(res, "not_found", "Live share is no longer active");
                        return [2 /*return*/];
                    }
                    // Strict recipient-only check — the sharer accesses their own share data
                    // through the session endpoints, not this recipient-view endpoint.
                    if (s.recipient_user_id !== auth.user.id) {
                        (0, http_1.sendError)(res, "forbidden", "You are not an authorized recipient of this share");
                        return [2 /*return*/];
                    }
                    // Attach to request for route handler
                    req.safeReturnRecipient = {
                        shareId: shareId,
                        callerUserId: auth.user.id,
                        db: db,
                        share: s,
                    };
                    next();
                    return [2 /*return*/];
            }
        });
    });
}
