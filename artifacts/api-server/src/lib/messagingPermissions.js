"use strict";
/**
 * canMessage — messaging permission resolver.
 *
 * Accepts (supabaseServiceClient, senderId, recipientId) and returns a
 * MessagePermissionVerdict describing whether the sender may open a direct
 * thread, must send a message request first, or is blocked entirely.
 *
 * HARD RULES:
 *   - Cannot message self → denied.
 *   - Blocked (TODO: plug in block table) → denied.
 *   - recipient.message_privacy = 'no_one' → denied.
 *   - 'friends' → allowed only if mutual friendship exists.
 *   - 'followers' → allowed only if the recipient follows the sender.
 *   - 'following' → allowed only if the sender follows the recipient.
 *   - 'trip_members' → allowed if allow_trip_member_messages=true AND shared trip.
 *   - 'everyone' → directly allowed.
 *   - Trip/circle overrides are checked independently and can elevate to direct.
 *   - If not directly allowed and allow_message_requests=true → requires_request.
 *   - Otherwise → denied.
 *
 * Follow alone does NOT grant direct messaging unless message_privacy='following'
 * or 'everyone'.  No private posts, trips, location, or circle data is exposed.
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
exports.canMessage = canMessage;
var DEFAULT_SETTINGS = {
    message_privacy: 'everyone',
    allow_message_requests: true,
    allow_trip_member_messages: true,
    allow_circle_member_messages: true,
};
function deny(reason, ctx) {
    return { allowed: false, verdict: 'denied', reason: reason, relationship_context: ctx };
}
function allow(ctx) {
    return { allowed: true, verdict: 'allowed', relationship_context: ctx };
}
function requiresRequest(ctx) {
    return { allowed: false, verdict: 'requires_request', relationship_context: ctx };
}
function canMessage(sc, senderId, recipientId) {
    return __awaiter(this, void 0, void 0, function () {
        var emptyCtx, blockRow, _a, settingsRes, friendshipRes, sfRes, rfRes, sharedTrip, circleRes, settings, ctx, directlyAllowed;
        var _this = this;
        var _b, _c, _d, _e;
        return __generator(this, function (_f) {
            switch (_f.label) {
                case 0:
                    emptyCtx = {
                        isFriend: false,
                        senderFollowsRecipient: false,
                        recipientFollowsSender: false,
                        sharedTrip: false,
                        sharedCircle: false,
                    };
                    if (senderId === recipientId)
                        return [2 /*return*/, deny('self', emptyCtx)];
                    return [4 /*yield*/, sc
                            .from('blocks')
                            .select('blocker_id')
                            .or("and(blocker_id.eq.".concat(senderId, ",blocked_id.eq.").concat(recipientId, "),and(blocker_id.eq.").concat(recipientId, ",blocked_id.eq.").concat(senderId, ")"))
                            .limit(1)
                            .maybeSingle()];
                case 1:
                    blockRow = (_f.sent()).data;
                    if (blockRow)
                        return [2 /*return*/, deny('blocked', emptyCtx)];
                    return [4 /*yield*/, Promise.all([
                            // Recipient's message settings (or null → use defaults).
                            // NOTE: caller must pass a service-role client; user-scoped client cannot
                            // read another user's settings due to RLS policy ums_select_own.
                            sc
                                .from('user_message_settings')
                                .select('message_privacy, allow_message_requests, allow_trip_member_messages, allow_circle_member_messages')
                                .eq('user_id', recipientId)
                                .maybeSingle(),
                            // Mutual friendship (normalized pair).
                            sc
                                .from('user_friendships')
                                .select('user_a')
                                .or("and(user_a.eq.".concat(senderId < recipientId ? senderId : recipientId, ",user_b.eq.").concat(senderId < recipientId ? recipientId : senderId, ")"))
                                .maybeSingle(),
                            // Does sender follow recipient?
                            sc
                                .from('user_follows')
                                .select('follower_id')
                                .eq('follower_id', senderId)
                                .eq('following_id', recipientId)
                                .maybeSingle(),
                            // Does recipient follow sender?
                            sc
                                .from('user_follows')
                                .select('follower_id')
                                .eq('follower_id', recipientId)
                                .eq('following_id', senderId)
                                .maybeSingle(),
                            // Shared accepted trip membership — direct two-step query, no RPC needed.
                            (function () { return __awaiter(_this, void 0, void 0, function () {
                                var senderTrips, ids, shared;
                                return __generator(this, function (_a) {
                                    switch (_a.label) {
                                        case 0: return [4 /*yield*/, sc
                                                .from('trip_members')
                                                .select('trip_id')
                                                .eq('user_id', senderId)
                                                .in('role', ['owner', 'member'])];
                                        case 1:
                                            senderTrips = (_a.sent()).data;
                                            ids = (senderTrips !== null && senderTrips !== void 0 ? senderTrips : []).map(function (m) { return m.trip_id; });
                                            if (ids.length === 0)
                                                return [2 /*return*/, false];
                                            return [4 /*yield*/, sc
                                                    .from('trip_members')
                                                    .select('trip_id')
                                                    .eq('user_id', recipientId)
                                                    .in('role', ['owner', 'member'])
                                                    .in('trip_id', ids)
                                                    .limit(1)
                                                    .maybeSingle()];
                                        case 2:
                                            shared = (_a.sent()).data;
                                            return [2 /*return*/, Boolean(shared)];
                                    }
                                });
                            }); })(),
                            // Shared circle: sender is in recipient's circle OR recipient is in sender's circle.
                            sc
                                .from('circle_memberships')
                                .select('owner_id')
                                .or("and(owner_id.eq.".concat(recipientId, ",member_id.eq.").concat(senderId, "),and(owner_id.eq.").concat(senderId, ",member_id.eq.").concat(recipientId, ")"))
                                .limit(1)
                                .maybeSingle(),
                        ])];
                case 2:
                    _a = _f.sent(), settingsRes = _a[0], friendshipRes = _a[1], sfRes = _a[2], rfRes = _a[3], sharedTrip = _a[4], circleRes = _a[5];
                    settings = settingsRes.data
                        ? {
                            message_privacy: (_b = settingsRes.data.message_privacy) !== null && _b !== void 0 ? _b : 'everyone',
                            allow_message_requests: (_c = settingsRes.data.allow_message_requests) !== null && _c !== void 0 ? _c : true,
                            allow_trip_member_messages: (_d = settingsRes.data.allow_trip_member_messages) !== null && _d !== void 0 ? _d : true,
                            allow_circle_member_messages: (_e = settingsRes.data.allow_circle_member_messages) !== null && _e !== void 0 ? _e : true,
                        }
                        : DEFAULT_SETTINGS;
                    ctx = {
                        isFriend: Boolean(friendshipRes.data),
                        senderFollowsRecipient: Boolean(sfRes.data),
                        recipientFollowsSender: Boolean(rfRes.data),
                        sharedTrip: sharedTrip,
                        sharedCircle: Boolean(circleRes.data),
                    };
                    // Hard deny: no_one.
                    if (settings.message_privacy === 'no_one')
                        return [2 /*return*/, deny('no_one', ctx)];
                    directlyAllowed = false;
                    switch (settings.message_privacy) {
                        case 'everyone':
                            directlyAllowed = true;
                            break;
                        case 'friends':
                            directlyAllowed = ctx.isFriend;
                            break;
                        case 'followers':
                            // "followers": recipient only accepts messages from their own followers.
                            // A follower of the recipient is someone whose following_id = recipient.id
                            // → sender follows recipient = senderFollowsRecipient.
                            directlyAllowed = ctx.senderFollowsRecipient;
                            break;
                        case 'following':
                            // "following": recipient only accepts messages from people they follow.
                            // The recipient follows the sender = recipientFollowsSender.
                            directlyAllowed = ctx.recipientFollowsSender;
                            break;
                        case 'trip_members':
                            directlyAllowed = settings.allow_trip_member_messages && ctx.sharedTrip;
                            break;
                        default:
                            directlyAllowed = false;
                    }
                    // Trip/circle overrides — can elevate to direct even if primary setting denies.
                    if (!directlyAllowed && settings.allow_trip_member_messages && ctx.sharedTrip) {
                        directlyAllowed = true;
                    }
                    if (!directlyAllowed && settings.allow_circle_member_messages && ctx.sharedCircle) {
                        directlyAllowed = true;
                    }
                    if (directlyAllowed)
                        return [2 /*return*/, allow(ctx)];
                    // Not directly allowed — can a request be sent?
                    if (settings.allow_message_requests)
                        return [2 /*return*/, requiresRequest(ctx)];
                    return [2 /*return*/, deny('privacy_setting', ctx)];
            }
        });
    });
}
