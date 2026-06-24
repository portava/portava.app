"use strict";
/**
 * Chat membership sync — the single source of truth for group thread membership.
 *
 * syncTripChatMembers(tripId, sc)
 *   • Ensures a 'trip' thread exists for the trip (create if absent, idempotent).
 *   • Reads currently-accepted members from trip_members (role owner | member).
 *   • Upserts them as thread members (left_at = NULL, role mirrors trip role).
 *   • Sets left_at = now() for any thread members no longer in the accepted set.
 *
 * syncCircleChatMembers(circleOwnerId, sc)
 *   • Ensures a 'circle' thread exists for the circle owner (create if absent).
 *   • Reads accepted members from circle_memberships (owner_id = circleOwnerId).
 *   • Upserts circle owner + accepted members as thread members.
 *   • Sets left_at = now() for members no longer in the accepted set.
 *
 * Both functions return the resolved threadId.
 *
 * Privacy: these functions read ONLY trip_members / circle_memberships and
 * message_thread_members. They never read live location, private posts, or GPS.
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
function syncTripChatMembers(tripId, sc) {
    return __awaiter(this, void 0, void 0, function () {
        var now, existing, threadId, trip, title, _a, created, cErr, acceptedRows, accepted, acceptedIds, currentMembers, currentById, _i, accepted_1, _b, user_id, role, existing_1, _c, _d, _e, user_id, m;
        return __generator(this, function (_f) {
            switch (_f.label) {
                case 0:
                    now = new Date().toISOString();
                    return [4 /*yield*/, sc
                            .from('message_threads')
                            .select('id, title')
                            .eq('trip_id', tripId)
                            .eq('thread_type', 'trip')
                            .maybeSingle()];
                case 1:
                    existing = (_f.sent()).data;
                    if (!existing) return [3 /*break*/, 2];
                    threadId = existing.id;
                    return [3 /*break*/, 5];
                case 2: return [4 /*yield*/, sc
                        .from('trips')
                        .select('title, destination_city')
                        .eq('id', tripId)
                        .maybeSingle()];
                case 3:
                    trip = (_f.sent()).data;
                    title = trip
                        ? "".concat(trip.title).concat(trip.destination_city ? " \u00B7 ".concat(trip.destination_city) : '')
                        : 'Trip Chat';
                    return [4 /*yield*/, sc
                            .from('message_threads')
                            .insert({
                            thread_type: 'trip',
                            trip_id: tripId,
                            title: title,
                            created_at: now,
                            updated_at: now,
                        })
                            .select('id')
                            .single()];
                case 4:
                    _a = _f.sent(), created = _a.data, cErr = _a.error;
                    if (cErr || !created)
                        return [2 /*return*/, null];
                    threadId = created.id;
                    _f.label = 5;
                case 5: return [4 /*yield*/, sc
                        .from('trip_members')
                        .select('user_id, role')
                        .eq('trip_id', tripId)
                        .in('role', ['owner', 'member'])];
                case 6:
                    acceptedRows = (_f.sent()).data;
                    accepted = (acceptedRows !== null && acceptedRows !== void 0 ? acceptedRows : []);
                    acceptedIds = new Set(accepted.map(function (r) { return r.user_id; }));
                    return [4 /*yield*/, sc
                            .from('message_thread_members')
                            .select('user_id, left_at, role')
                            .eq('thread_id', threadId)];
                case 7:
                    currentMembers = (_f.sent()).data;
                    currentById = new Map((currentMembers !== null && currentMembers !== void 0 ? currentMembers : []).map(function (m) { return [m.user_id, m]; }));
                    _i = 0, accepted_1 = accepted;
                    _f.label = 8;
                case 8:
                    if (!(_i < accepted_1.length)) return [3 /*break*/, 13];
                    _b = accepted_1[_i], user_id = _b.user_id, role = _b.role;
                    existing_1 = currentById.get(user_id);
                    if (!!existing_1) return [3 /*break*/, 10];
                    return [4 /*yield*/, sc.from('message_thread_members').insert({
                            thread_id: threadId,
                            user_id: user_id,
                            role: role,
                            joined_at: now,
                            left_at: null,
                        })];
                case 9:
                    _f.sent();
                    return [3 /*break*/, 12];
                case 10:
                    if (!(existing_1.left_at !== null || existing_1.role !== role)) return [3 /*break*/, 12];
                    return [4 /*yield*/, sc
                            .from('message_thread_members')
                            .update({ left_at: null, role: role })
                            .eq('thread_id', threadId)
                            .eq('user_id', user_id)];
                case 11:
                    _f.sent();
                    _f.label = 12;
                case 12:
                    _i++;
                    return [3 /*break*/, 8];
                case 13:
                    _c = 0, _d = currentById.entries();
                    _f.label = 14;
                case 14:
                    if (!(_c < _d.length)) return [3 /*break*/, 17];
                    _e = _d[_c], user_id = _e[0], m = _e[1];
                    if (!(!acceptedIds.has(user_id) && m.left_at === null)) return [3 /*break*/, 16];
                    return [4 /*yield*/, sc
                            .from('message_thread_members')
                            .update({ left_at: now })
                            .eq('thread_id', threadId)
                            .eq('user_id', user_id)];
                case 15:
                    _f.sent();
                    _f.label = 16;
                case 16:
                    _c++;
                    return [3 /*break*/, 14];
                case 17: return [2 /*return*/, threadId];
            }
        });
    });
}
function syncCircleChatMembers(circleOwnerId, sc) {
    return __awaiter(this, void 0, void 0, function () {
        var now, existing, threadId, ownerProfile, title, _a, created, cErr, memberRows, memberIds, acceptedSet, allAccepted, currentMembers, currentById, _i, allAccepted_1, _b, user_id, role, ex, _c, _d, _e, user_id, m;
        var _f, _g;
        return __generator(this, function (_h) {
            switch (_h.label) {
                case 0:
                    now = new Date().toISOString();
                    return [4 /*yield*/, sc
                            .from('message_threads')
                            .select('id')
                            .eq('circle_owner_id', circleOwnerId)
                            .eq('thread_type', 'circle')
                            .maybeSingle()];
                case 1:
                    existing = (_h.sent()).data;
                    if (!existing) return [3 /*break*/, 2];
                    threadId = existing.id;
                    return [3 /*break*/, 5];
                case 2: return [4 /*yield*/, sc
                        .from('profiles')
                        .select('name, handle')
                        .eq('id', circleOwnerId)
                        .maybeSingle()];
                case 3:
                    ownerProfile = (_h.sent()).data;
                    title = ownerProfile
                        ? "".concat((_g = (_f = ownerProfile.name) !== null && _f !== void 0 ? _f : ownerProfile.handle) !== null && _g !== void 0 ? _g : 'Circle', "'s Trusted Circle")
                        : 'Trusted Circle';
                    return [4 /*yield*/, sc
                            .from('message_threads')
                            .insert({
                            thread_type: 'circle',
                            circle_owner_id: circleOwnerId,
                            title: title,
                            created_at: now,
                            updated_at: now,
                        })
                            .select('id')
                            .single()];
                case 4:
                    _a = _h.sent(), created = _a.data, cErr = _a.error;
                    if (cErr || !created)
                        return [2 /*return*/, null];
                    threadId = created.id;
                    _h.label = 5;
                case 5: return [4 /*yield*/, sc
                        .from('circle_memberships')
                        .select('member_id')
                        .eq('owner_id', circleOwnerId)];
                case 6:
                    memberRows = (_h.sent()).data;
                    memberIds = (memberRows !== null && memberRows !== void 0 ? memberRows : []).map(function (r) { return r.member_id; });
                    acceptedSet = new Set(__spreadArray([circleOwnerId], memberIds, true));
                    allAccepted = __spreadArray([
                        { user_id: circleOwnerId, role: 'owner' }
                    ], memberIds.map(function (id) { return ({ user_id: id, role: 'member' }); }), true);
                    return [4 /*yield*/, sc
                            .from('message_thread_members')
                            .select('user_id, left_at, role')
                            .eq('thread_id', threadId)];
                case 7:
                    currentMembers = (_h.sent()).data;
                    currentById = new Map((currentMembers !== null && currentMembers !== void 0 ? currentMembers : []).map(function (m) { return [m.user_id, m]; }));
                    _i = 0, allAccepted_1 = allAccepted;
                    _h.label = 8;
                case 8:
                    if (!(_i < allAccepted_1.length)) return [3 /*break*/, 13];
                    _b = allAccepted_1[_i], user_id = _b.user_id, role = _b.role;
                    ex = currentById.get(user_id);
                    if (!!ex) return [3 /*break*/, 10];
                    return [4 /*yield*/, sc.from('message_thread_members').insert({
                            thread_id: threadId,
                            user_id: user_id,
                            role: role,
                            joined_at: now,
                            left_at: null,
                        })];
                case 9:
                    _h.sent();
                    return [3 /*break*/, 12];
                case 10:
                    if (!(ex.left_at !== null || ex.role !== role)) return [3 /*break*/, 12];
                    return [4 /*yield*/, sc
                            .from('message_thread_members')
                            .update({ left_at: null, role: role })
                            .eq('thread_id', threadId)
                            .eq('user_id', user_id)];
                case 11:
                    _h.sent();
                    _h.label = 12;
                case 12:
                    _i++;
                    return [3 /*break*/, 8];
                case 13:
                    _c = 0, _d = currentById.entries();
                    _h.label = 14;
                case 14:
                    if (!(_c < _d.length)) return [3 /*break*/, 17];
                    _e = _d[_c], user_id = _e[0], m = _e[1];
                    if (!(!acceptedSet.has(user_id) && m.left_at === null)) return [3 /*break*/, 16];
                    return [4 /*yield*/, sc
                            .from('message_thread_members')
                            .update({ left_at: now })
                            .eq('thread_id', threadId)
                            .eq('user_id', user_id)];
                case 15:
                    _h.sent();
                    _h.label = 16;
                case 16:
                    _c++;
                    return [3 /*break*/, 14];
                case 17: return [2 /*return*/, threadId];
            }
        });
    });
}
