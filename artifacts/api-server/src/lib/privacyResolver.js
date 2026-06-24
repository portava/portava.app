"use strict";
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
exports.resolveContext = resolveContext;
/**
 * Look up whether the requesting user has opted in to availability sharing.
 * Conservative default: false if the preference profile is missing or unset.
 * We check this only for accepted members to avoid unnecessary DB calls.
 */
function resolveAvailabilityConsent(client, userId) {
    return __awaiter(this, void 0, void 0, function () {
        var data_1, explicit, _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    _b.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, client
                            .from("user_preference_profiles")
                            .select("explicit_preferences_json")
                            .eq("user_id", userId)
                            .maybeSingle()];
                case 1:
                    data_1 = (_b.sent()).data;
                    if (!data_1)
                        return [2 /*return*/, false];
                    explicit = (function () {
                        try {
                            return JSON.parse(data_1.explicit_preferences_json);
                        }
                        catch (_a) {
                            return {};
                        }
                    })();
                    // `shareAvailability` is an explicit opt-in field; absence = false.
                    return [2 /*return*/, explicit.shareAvailability === true];
                case 2:
                    _a = _b.sent();
                    return [2 /*return*/, false]; // fail-safe: deny if we cannot read the preference
                case 3: return [2 /*return*/];
            }
        });
    });
}
/**
 * Checks whether the requesting user is a member of the trip owner's circle.
 * Fetches the trip owner from trip_members (role='owner') then checks
 * circle_memberships. Returns false on any DB error (fail-safe).
 */
function resolveCircleMembership(client, userId, tripId) {
    return __awaiter(this, void 0, void 0, function () {
        var ownerRow, ownerId, membership, _a;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    _c.trys.push([0, 3, , 4]);
                    return [4 /*yield*/, client
                            .from("trip_members")
                            .select("user_id")
                            .eq("trip_id", tripId)
                            .eq("role", "owner")
                            .maybeSingle()];
                case 1:
                    ownerRow = (_c.sent()).data;
                    ownerId = (_b = ownerRow === null || ownerRow === void 0 ? void 0 : ownerRow.user_id) !== null && _b !== void 0 ? _b : null;
                    if (!ownerId)
                        return [2 /*return*/, false];
                    // The trip owner is always in their own circle
                    if (ownerId === userId)
                        return [2 /*return*/, true];
                    return [4 /*yield*/, client
                            .from("circle_memberships")
                            .select("member_id")
                            .eq("owner_id", ownerId)
                            .eq("member_id", userId)
                            .maybeSingle()];
                case 2:
                    membership = (_c.sent()).data;
                    return [2 /*return*/, membership !== null];
                case 3:
                    _a = _c.sent();
                    return [2 /*return*/, false]; // fail-safe: deny on unexpected error
                case 4: return [2 /*return*/];
            }
        });
    });
}
/**
 * Resolves privacy context for a user + optional trip.
 * Never rejects the promise — returns access_denied verdict on any DB failure.
 */
function resolveContext(client, userId, tripId) {
    return __awaiter(this, void 0, void 0, function () {
        var base, _a, membership, error, role, isOwner, isAccepted, _b, availabilitySharingEnabled, isInTripOwnerCircle, _c;
        var _d;
        return __generator(this, function (_e) {
            switch (_e.label) {
                case 0:
                    base = {
                        userId: userId,
                        tripId: tripId !== null && tripId !== void 0 ? tripId : null,
                        access: "partial",
                        isAcceptedMember: false,
                        isTripOwner: false,
                        isInTripOwnerCircle: false,
                        availabilitySharingEnabled: false,
                        locationSharingEnabled: false,
                        canReadPlanItems: false,
                        canReadMeetups: false,
                    };
                    if (!tripId) {
                        base.access = "partial";
                        return [2 /*return*/, base];
                    }
                    _e.label = 1;
                case 1:
                    _e.trys.push([1, 4, , 5]);
                    return [4 /*yield*/, client
                            .from("trip_members")
                            .select("role")
                            .eq("trip_id", tripId)
                            .eq("user_id", userId)
                            .maybeSingle()];
                case 2:
                    _a = _e.sent(), membership = _a.data, error = _a.error;
                    if (error) {
                        return [2 /*return*/, __assign(__assign({}, base), { access: "access_denied", denialReason: "db_error" })];
                    }
                    role = (_d = membership === null || membership === void 0 ? void 0 : membership.role) !== null && _d !== void 0 ? _d : null;
                    if (!role) {
                        return [2 /*return*/, __assign(__assign({}, base), { access: "access_denied", denialReason: "not_a_member" })];
                    }
                    if (role === "invited") {
                        return [2 /*return*/, __assign(__assign({}, base), { access: "access_denied", denialReason: "pending_invite" })];
                    }
                    isOwner = role === "owner";
                    isAccepted = role === "owner" || role === "member";
                    if (!isAccepted) {
                        return [2 /*return*/, __assign(__assign({}, base), { access: "access_denied", denialReason: "insufficient_role" })];
                    }
                    return [4 /*yield*/, Promise.all([
                            resolveAvailabilityConsent(client, userId),
                            resolveCircleMembership(client, userId, tripId),
                        ])];
                case 3:
                    _b = _e.sent(), availabilitySharingEnabled = _b[0], isInTripOwnerCircle = _b[1];
                    return [2 /*return*/, __assign(__assign({}, base), { access: "full", isAcceptedMember: true, isTripOwner: isOwner, isInTripOwnerCircle: isInTripOwnerCircle, availabilitySharingEnabled: availabilitySharingEnabled, locationSharingEnabled: false, canReadPlanItems: true, canReadMeetups: true })];
                case 4:
                    _c = _e.sent();
                    return [2 /*return*/, __assign(__assign({}, base), { access: "access_denied", denialReason: "unexpected_error" })];
                case 5: return [2 /*return*/];
            }
        });
    });
}
