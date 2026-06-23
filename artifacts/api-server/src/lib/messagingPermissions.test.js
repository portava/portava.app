"use strict";
/**
 * Unit tests for the canMessage permission resolver.
 *
 * Tests run with node:test. The Supabase client is fully faked — no network
 * calls are made.
 *
 * Scenario coverage (8 core scenarios):
 *   1. Cannot message self → denied / reason = 'self'
 *   2. message_privacy = 'no_one' → denied
 *   3. message_privacy = 'everyone' → allowed
 *   4. message_privacy = 'friends', not friends → requires_request
 *   5. message_privacy = 'friends', mutual friends → allowed
 *   6. message_privacy = 'following', not following → requires_request
 *   7. message_privacy = 'following', sender follows recipient → allowed
 *   8. allow_message_requests = false, primary denied → denied
 *
 * Plus: trip/circle override elevates to direct even when primary denies.
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
var node_test_1 = require("node:test");
var strict_1 = require("node:assert/strict");
var messagingPermissions_1 = require("./messagingPermissions");
var A = 'aaaaaaaa-0000-0000-0000-000000000001';
var B = 'bbbbbbbb-0000-0000-0000-000000000002';
function makeFakeClient(state) {
    var _a = state.settings, settings = _a === void 0 ? null : _a, _b = state.isFriend, isFriend = _b === void 0 ? false : _b, _c = state.senderFollowsRecipient, senderFollowsRecipient = _c === void 0 ? false : _c, _d = state.recipientFollowsSender, recipientFollowsSender = _d === void 0 ? false : _d, _e = state.sharedTrip, sharedTrip = _e === void 0 ? false : _e, _f = state.sharedCircle, sharedCircle = _f === void 0 ? false : _f;
    function chain(value) {
        var _this = this;
        var obj = {
            select: function () { return obj; },
            eq: function () { return obj; },
            or: function () { return obj; },
            limit: function () { return obj; },
            in: function () { return obj; },
            maybeSingle: function () { return __awaiter(_this, void 0, void 0, function () { return __generator(this, function (_a) {
                return [2 /*return*/, ({ data: value, error: null })];
            }); }); },
        };
        return obj;
    }
    var followCallIndex = 0;
    // Synthetic trip_members rows to model shared trips.
    // If sharedTrip=true, both A and B are members of trip-shared-1.
    var tripRows = sharedTrip
        ? [
            { trip_id: 'trip-shared-1', user_id: A, role: 'member' },
            { trip_id: 'trip-shared-1', user_id: B, role: 'member' },
        ]
        : [];
    function tripChain(initialRows) {
        var _this = this;
        var rows = __spreadArray([], initialRows, true);
        var b = {
            select: function () { return b; },
            eq: function (col, val) { rows = rows.filter(function (r) { return r[col] === val; }); return b; },
            in: function (col, vals) { rows = rows.filter(function (r) { return vals.includes(r[col]); }); return b; },
            limit: function (n) { rows = rows.slice(0, n); return b; },
            maybeSingle: function () { return __awaiter(_this, void 0, void 0, function () { var _a; return __generator(this, function (_b) {
                return [2 /*return*/, ({ data: (_a = rows[0]) !== null && _a !== void 0 ? _a : null, error: null })];
            }); }); },
            or: function () { return b; },
            then: function (onF, onR) { return Promise.resolve({ data: rows, error: null }).then(onF, onR); },
        };
        return b;
    }
    return {
        from: function (table) {
            return {
                select: function (_cols) {
                    if (table === 'user_message_settings')
                        return chain(settings);
                    if (table === 'user_friendships')
                        return chain(isFriend ? { user_a: A } : null);
                    if (table === 'user_follows') {
                        // First call = sender→recipient, second = recipient→sender
                        followCallIndex++;
                        if (followCallIndex === 1)
                            return chain(senderFollowsRecipient ? { follower_id: A } : null);
                        return chain(recipientFollowsSender ? { follower_id: B } : null);
                    }
                    if (table === 'trip_members')
                        return tripChain(tripRows);
                    if (table === 'circle_memberships')
                        return chain(sharedCircle ? { owner_id: B } : null);
                    return chain(null);
                },
            };
        },
    };
}
// ---------------------------------------------------------------------------
// Scenario 1: Self → denied
// ---------------------------------------------------------------------------
(0, node_test_1.default)('cannot message self', function () { return __awaiter(void 0, void 0, void 0, function () {
    var sc, r;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                sc = makeFakeClient({});
                return [4 /*yield*/, (0, messagingPermissions_1.canMessage)(sc, A, A)];
            case 1:
                r = _a.sent();
                strict_1.default.equal(r.verdict, 'denied');
                strict_1.default.equal(r.reason, 'self');
                strict_1.default.equal(r.allowed, false);
                return [2 /*return*/];
        }
    });
}); });
// ---------------------------------------------------------------------------
// Scenario 2: message_privacy = 'no_one' → denied
// ---------------------------------------------------------------------------
(0, node_test_1.default)('no_one privacy → denied', function () { return __awaiter(void 0, void 0, void 0, function () {
    var sc, r;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                sc = makeFakeClient({ settings: { message_privacy: 'no_one', allow_message_requests: true, allow_trip_member_messages: true, allow_circle_member_messages: true } });
                return [4 /*yield*/, (0, messagingPermissions_1.canMessage)(sc, A, B)];
            case 1:
                r = _a.sent();
                strict_1.default.equal(r.verdict, 'denied');
                strict_1.default.equal(r.reason, 'no_one');
                return [2 /*return*/];
        }
    });
}); });
// ---------------------------------------------------------------------------
// Scenario 3: message_privacy = 'everyone' → allowed
// ---------------------------------------------------------------------------
(0, node_test_1.default)('everyone privacy → allowed', function () { return __awaiter(void 0, void 0, void 0, function () {
    var sc, r;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                sc = makeFakeClient({ settings: { message_privacy: 'everyone', allow_message_requests: true, allow_trip_member_messages: false, allow_circle_member_messages: false } });
                return [4 /*yield*/, (0, messagingPermissions_1.canMessage)(sc, A, B)];
            case 1:
                r = _a.sent();
                strict_1.default.equal(r.verdict, 'allowed');
                strict_1.default.equal(r.allowed, true);
                return [2 /*return*/];
        }
    });
}); });
// ---------------------------------------------------------------------------
// Scenario 4: message_privacy = 'friends', not friends → requires_request
// ---------------------------------------------------------------------------
(0, node_test_1.default)('friends privacy, not friends, requests allowed → requires_request', function () { return __awaiter(void 0, void 0, void 0, function () {
    var sc, r;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                sc = makeFakeClient({
                    settings: { message_privacy: 'friends', allow_message_requests: true, allow_trip_member_messages: false, allow_circle_member_messages: false },
                    isFriend: false,
                });
                return [4 /*yield*/, (0, messagingPermissions_1.canMessage)(sc, A, B)];
            case 1:
                r = _a.sent();
                strict_1.default.equal(r.verdict, 'requires_request');
                strict_1.default.equal(r.relationship_context.isFriend, false);
                return [2 /*return*/];
        }
    });
}); });
// ---------------------------------------------------------------------------
// Scenario 5: message_privacy = 'friends', mutual friends → allowed
// ---------------------------------------------------------------------------
(0, node_test_1.default)('friends privacy, is friend → allowed', function () { return __awaiter(void 0, void 0, void 0, function () {
    var sc, r;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                sc = makeFakeClient({
                    settings: { message_privacy: 'friends', allow_message_requests: true, allow_trip_member_messages: false, allow_circle_member_messages: false },
                    isFriend: true,
                });
                return [4 /*yield*/, (0, messagingPermissions_1.canMessage)(sc, A, B)];
            case 1:
                r = _a.sent();
                strict_1.default.equal(r.verdict, 'allowed');
                strict_1.default.equal(r.relationship_context.isFriend, true);
                return [2 /*return*/];
        }
    });
}); });
// ---------------------------------------------------------------------------
// Scenario 6: message_privacy = 'following' → recipient accepts messages from people they follow.
//             The recipient does NOT follow the sender → requires_request.
// ---------------------------------------------------------------------------
(0, node_test_1.default)('following privacy, sender not following → requires_request', function () { return __awaiter(void 0, void 0, void 0, function () {
    var sc, r;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                sc = makeFakeClient({
                    settings: { message_privacy: 'following', allow_message_requests: true, allow_trip_member_messages: false, allow_circle_member_messages: false },
                    recipientFollowsSender: false,
                });
                return [4 /*yield*/, (0, messagingPermissions_1.canMessage)(sc, A, B)];
            case 1:
                r = _a.sent();
                strict_1.default.equal(r.verdict, 'requires_request');
                return [2 /*return*/];
        }
    });
}); });
// ---------------------------------------------------------------------------
// Scenario 7: message_privacy = 'following' → recipient follows sender → allowed.
// ---------------------------------------------------------------------------
(0, node_test_1.default)('following privacy, recipient follows sender → allowed', function () { return __awaiter(void 0, void 0, void 0, function () {
    var sc, r;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                sc = makeFakeClient({
                    settings: { message_privacy: 'following', allow_message_requests: true, allow_trip_member_messages: false, allow_circle_member_messages: false },
                    recipientFollowsSender: true,
                });
                return [4 /*yield*/, (0, messagingPermissions_1.canMessage)(sc, A, B)];
            case 1:
                r = _a.sent();
                strict_1.default.equal(r.verdict, 'allowed');
                strict_1.default.equal(r.relationship_context.recipientFollowsSender, true);
                return [2 /*return*/];
        }
    });
}); });
// ---------------------------------------------------------------------------
// Scenario 8: allow_message_requests = false, primary denied → denied
// ---------------------------------------------------------------------------
(0, node_test_1.default)('requests disabled, primary denied → denied', function () { return __awaiter(void 0, void 0, void 0, function () {
    var sc, r;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                sc = makeFakeClient({
                    settings: { message_privacy: 'friends', allow_message_requests: false, allow_trip_member_messages: false, allow_circle_member_messages: false },
                    isFriend: false,
                });
                return [4 /*yield*/, (0, messagingPermissions_1.canMessage)(sc, A, B)];
            case 1:
                r = _a.sent();
                strict_1.default.equal(r.verdict, 'denied');
                strict_1.default.equal(r.reason, 'privacy_setting');
                return [2 /*return*/];
        }
    });
}); });
// ---------------------------------------------------------------------------
// Scenario 9: shared trip override elevates to direct (even if primary denies)
// ---------------------------------------------------------------------------
(0, node_test_1.default)('shared trip override with allow_trip_member_messages=true → allowed', function () { return __awaiter(void 0, void 0, void 0, function () {
    var sc, r;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                sc = makeFakeClient({
                    settings: { message_privacy: 'friends', allow_message_requests: false, allow_trip_member_messages: true, allow_circle_member_messages: false },
                    isFriend: false,
                    sharedTrip: true,
                });
                return [4 /*yield*/, (0, messagingPermissions_1.canMessage)(sc, A, B)];
            case 1:
                r = _a.sent();
                strict_1.default.equal(r.verdict, 'allowed');
                strict_1.default.equal(r.relationship_context.sharedTrip, true);
                return [2 /*return*/];
        }
    });
}); });
// ---------------------------------------------------------------------------
// Scenario 10: shared circle override elevates to direct
// ---------------------------------------------------------------------------
(0, node_test_1.default)('shared circle override with allow_circle_member_messages=true → allowed', function () { return __awaiter(void 0, void 0, void 0, function () {
    var sc, r;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                sc = makeFakeClient({
                    settings: { message_privacy: 'friends', allow_message_requests: false, allow_trip_member_messages: false, allow_circle_member_messages: true },
                    isFriend: false,
                    sharedCircle: true,
                });
                return [4 /*yield*/, (0, messagingPermissions_1.canMessage)(sc, A, B)];
            case 1:
                r = _a.sent();
                strict_1.default.equal(r.verdict, 'allowed');
                strict_1.default.equal(r.relationship_context.sharedCircle, true);
                return [2 /*return*/];
        }
    });
}); });
// ---------------------------------------------------------------------------
// Scenario 11: no settings row → defaults apply (everyone → allowed)
// ---------------------------------------------------------------------------
(0, node_test_1.default)('no settings row → defaults (everyone) → allowed', function () { return __awaiter(void 0, void 0, void 0, function () {
    var sc, r;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                sc = makeFakeClient({ settings: null });
                return [4 /*yield*/, (0, messagingPermissions_1.canMessage)(sc, A, B)];
            case 1:
                r = _a.sent();
                strict_1.default.equal(r.verdict, 'allowed');
                return [2 /*return*/];
        }
    });
}); });
// ---------------------------------------------------------------------------
// Scenario 12: followers privacy → recipient accepts messages from their followers.
//              Sender follows recipient → allowed.
// ---------------------------------------------------------------------------
(0, node_test_1.default)('followers privacy, sender follows recipient → allowed', function () { return __awaiter(void 0, void 0, void 0, function () {
    var sc, r;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                sc = makeFakeClient({
                    settings: { message_privacy: 'followers', allow_message_requests: true, allow_trip_member_messages: false, allow_circle_member_messages: false },
                    senderFollowsRecipient: true,
                });
                return [4 /*yield*/, (0, messagingPermissions_1.canMessage)(sc, A, B)];
            case 1:
                r = _a.sent();
                strict_1.default.equal(r.verdict, 'allowed');
                strict_1.default.equal(r.relationship_context.senderFollowsRecipient, true);
                return [2 /*return*/];
        }
    });
}); });
// ---------------------------------------------------------------------------
// Scenario 13: followers privacy, sender does NOT follow recipient → requires_request
// ---------------------------------------------------------------------------
(0, node_test_1.default)('followers privacy, sender not following recipient → requires_request', function () { return __awaiter(void 0, void 0, void 0, function () {
    var sc, r;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                sc = makeFakeClient({
                    settings: { message_privacy: 'followers', allow_message_requests: true, allow_trip_member_messages: false, allow_circle_member_messages: false },
                    senderFollowsRecipient: false,
                });
                return [4 /*yield*/, (0, messagingPermissions_1.canMessage)(sc, A, B)];
            case 1:
                r = _a.sent();
                strict_1.default.equal(r.verdict, 'requires_request');
                return [2 /*return*/];
        }
    });
}); });
