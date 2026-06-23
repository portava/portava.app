"use strict";
/**
 * Group chat membership sync helpers.
 *
 * These functions are called (fire-and-forget) whenever a user's membership
 * in a trip or circle changes:
 *
 *   syncTripChatMembers(sc, tripId)
 *     — Called after a user accepts a trip invite.
 *       Finds or creates the trip's group-chat thread and reconciles the
 *       message_thread_members table with the current accepted trip members
 *       (role IN ('owner', 'member')).
 *
 *   syncCircleChatMembers(sc, circleOwnerId)
 *     — Called after a user accepts a circle invite.
 *       Finds or creates the circle-owner's group-chat thread and reconciles
 *       message_thread_members with the circle's current members.
 *
 * Both functions are idempotent and race-safe: concurrent calls converge to
 * the same state because they use ON CONFLICT upserts and a single unique
 * partial index per trip / circle owner.
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
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncTripChatMembers = syncTripChatMembers;
exports.syncCircleChatMembers = syncCircleChatMembers;
// ---------------------------------------------------------------------------
// Trip group chat sync
// ---------------------------------------------------------------------------
/**
 * Ensure a 'trip' type thread exists for tripId, then reconcile its membership
 * to exactly the set of accepted trip members (role IN ('owner', 'member')).
 *
 * Returns the thread's UUID.
 */
function syncTripChatMembers(sc, tripId) {
    return __awaiter(this, void 0, void 0, function () {
        var now, trip, threadTitle, threadId, existing, _a, created, createErr, raceWinner, tripMembers, acceptedIds, upsertRows, activeMembers, toRemove;
        var _b, _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    now = new Date().toISOString();
                    return [4 /*yield*/, sc
                            .from('trips')
                            .select('id, title, destination_city')
                            .eq('id', tripId)
                            .maybeSingle()];
                case 1:
                    trip = (_d.sent()).data;
                    threadTitle = (_c = (_b = trip === null || trip === void 0 ? void 0 : trip.title) !== null && _b !== void 0 ? _b : trip === null || trip === void 0 ? void 0 : trip.destination_city) !== null && _c !== void 0 ? _c : 'Trip Chat';
                    return [4 /*yield*/, sc
                            .from('message_threads')
                            .select('id')
                            .eq('thread_type', 'trip')
                            .eq('trip_id', tripId)
                            .maybeSingle()];
                case 2:
                    existing = (_d.sent()).data;
                    if (!existing) return [3 /*break*/, 3];
                    threadId = existing.id;
                    return [3 /*break*/, 7];
                case 3: return [4 /*yield*/, sc
                        .from('message_threads')
                        .insert({
                        thread_type: 'trip',
                        trip_id: tripId,
                        title: threadTitle,
                        status: 'active',
                        created_at: now,
                        updated_at: now,
                    })
                        .select('id')
                        .single()];
                case 4:
                    _a = _d.sent(), created = _a.data, createErr = _a.error;
                    if (!createErr) return [3 /*break*/, 6];
                    return [4 /*yield*/, sc
                            .from('message_threads')
                            .select('id')
                            .eq('thread_type', 'trip')
                            .eq('trip_id', tripId)
                            .maybeSingle()];
                case 5:
                    raceWinner = (_d.sent()).data;
                    if (!raceWinner)
                        throw new Error("syncTripChatMembers: cannot find or create thread for trip ".concat(tripId, ": ").concat(createErr.message));
                    threadId = raceWinner.id;
                    return [3 /*break*/, 7];
                case 6:
                    threadId = created.id;
                    _d.label = 7;
                case 7: return [4 /*yield*/, sc
                        .from('trip_members')
                        .select('user_id')
                        .eq('trip_id', tripId)
                        .in('role', ['owner', 'member'])];
                case 8:
                    tripMembers = (_d.sent()).data;
                    acceptedIds = new Set((tripMembers !== null && tripMembers !== void 0 ? tripMembers : []).map(function (m) { return m.user_id; }));
                    if (acceptedIds.size === 0)
                        return [2 /*return*/, threadId];
                    upsertRows = __spreadArray([], acceptedIds, true).map(function (userId) { return ({
                        thread_id: threadId,
                        user_id: userId,
                        role: 'member',
                        joined_at: now,
                        left_at: null,
                    }); });
                    return [4 /*yield*/, sc.from('message_thread_members').upsert(upsertRows, {
                            onConflict: 'thread_id,user_id',
                            ignoreDuplicates: false,
                        })];
                case 9:
                    _d.sent();
                    return [4 /*yield*/, sc
                            .from('message_thread_members')
                            .select('user_id')
                            .eq('thread_id', threadId)
                            .is('left_at', null)];
                case 10:
                    activeMembers = (_d.sent()).data;
                    toRemove = (activeMembers !== null && activeMembers !== void 0 ? activeMembers : [])
                        .map(function (m) { return m.user_id; })
                        .filter(function (id) { return !acceptedIds.has(id); });
                    if (!(toRemove.length > 0)) return [3 /*break*/, 12];
                    return [4 /*yield*/, sc
                            .from('message_thread_members')
                            .update({ left_at: now })
                            .eq('thread_id', threadId)
                            .in('user_id', toRemove)];
                case 11:
                    _d.sent();
                    _d.label = 12;
                case 12: return [2 /*return*/, threadId];
            }
        });
    });
}
// ---------------------------------------------------------------------------
// Circle group chat sync
// ---------------------------------------------------------------------------
/**
 * Ensure a 'circle' type thread exists for circleOwnerId, then reconcile its
 * membership to the owner plus all circle_memberships members.
 *
 * Returns the thread's UUID.
 */
function syncCircleChatMembers(sc, circleOwnerId) {
    return __awaiter(this, void 0, void 0, function () {
        var now, ownerProfile, displayName, threadTitle, threadId, existing, _a, created, createErr, raceWinner, circleMembers, memberIds, upsertRows, activeMembers, toRemove;
        var _b, _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    now = new Date().toISOString();
                    return [4 /*yield*/, sc
                            .from('profiles')
                            .select('id, name, handle')
                            .eq('id', circleOwnerId)
                            .maybeSingle()];
                case 1:
                    ownerProfile = (_d.sent()).data;
                    displayName = (_c = (_b = ownerProfile === null || ownerProfile === void 0 ? void 0 : ownerProfile.name) !== null && _b !== void 0 ? _b : ownerProfile === null || ownerProfile === void 0 ? void 0 : ownerProfile.handle) !== null && _c !== void 0 ? _c : 'Circle';
                    threadTitle = "".concat(displayName, "'s Circle");
                    return [4 /*yield*/, sc
                            .from('message_threads')
                            .select('id')
                            .eq('thread_type', 'circle')
                            .eq('circle_owner_id', circleOwnerId)
                            .maybeSingle()];
                case 2:
                    existing = (_d.sent()).data;
                    if (!existing) return [3 /*break*/, 3];
                    threadId = existing.id;
                    return [3 /*break*/, 7];
                case 3: return [4 /*yield*/, sc
                        .from('message_threads')
                        .insert({
                        thread_type: 'circle',
                        circle_owner_id: circleOwnerId,
                        title: threadTitle,
                        status: 'active',
                        created_at: now,
                        updated_at: now,
                    })
                        .select('id')
                        .single()];
                case 4:
                    _a = _d.sent(), created = _a.data, createErr = _a.error;
                    if (!createErr) return [3 /*break*/, 6];
                    return [4 /*yield*/, sc
                            .from('message_threads')
                            .select('id')
                            .eq('thread_type', 'circle')
                            .eq('circle_owner_id', circleOwnerId)
                            .maybeSingle()];
                case 5:
                    raceWinner = (_d.sent()).data;
                    if (!raceWinner)
                        throw new Error("syncCircleChatMembers: cannot find or create thread for circle ".concat(circleOwnerId, ": ").concat(createErr.message));
                    threadId = raceWinner.id;
                    return [3 /*break*/, 7];
                case 6:
                    threadId = created.id;
                    _d.label = 7;
                case 7: return [4 /*yield*/, sc
                        .from('circle_memberships')
                        .select('member_id')
                        .eq('owner_id', circleOwnerId)];
                case 8:
                    circleMembers = (_d.sent()).data;
                    memberIds = new Set(__spreadArray([
                        circleOwnerId
                    ], (circleMembers !== null && circleMembers !== void 0 ? circleMembers : []).map(function (m) { return m.member_id; }), true));
                    upsertRows = __spreadArray([], memberIds, true).map(function (userId) { return ({
                        thread_id: threadId,
                        user_id: userId,
                        role: 'member',
                        joined_at: now,
                        left_at: null,
                    }); });
                    return [4 /*yield*/, sc.from('message_thread_members').upsert(upsertRows, {
                            onConflict: 'thread_id,user_id',
                            ignoreDuplicates: false,
                        })];
                case 9:
                    _d.sent();
                    return [4 /*yield*/, sc
                            .from('message_thread_members')
                            .select('user_id')
                            .eq('thread_id', threadId)
                            .is('left_at', null)];
                case 10:
                    activeMembers = (_d.sent()).data;
                    toRemove = (activeMembers !== null && activeMembers !== void 0 ? activeMembers : [])
                        .map(function (m) { return m.user_id; })
                        .filter(function (id) { return !memberIds.has(id); });
                    if (!(toRemove.length > 0)) return [3 /*break*/, 12];
                    return [4 /*yield*/, sc
                            .from('message_thread_members')
                            .update({ left_at: now })
                            .eq('thread_id', threadId)
                            .in('user_id', toRemove)];
                case 11:
                    _d.sent();
                    _d.label = 12;
                case 12: return [2 /*return*/, threadId];
            }
        });
    });
}
