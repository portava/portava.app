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
var node_test_1 = require("node:test");
var strict_1 = require("node:assert/strict");
var telegraphEvents_js_1 = require("../lib/telegraphEvents.js");
(0, node_test_1.test)("subscribe delivers events to the right user and unsubscribe stops them", function () {
    var received = [];
    var unsub = (0, telegraphEvents_js_1.subscribe)("user-a", function (e) { return received.push(e); });
    strict_1.default.equal((0, telegraphEvents_js_1.isUserConnected)("user-a"), true);
    strict_1.default.equal((0, telegraphEvents_js_1.isUserConnected)("user-b"), false);
    (0, telegraphEvents_js_1.publishToUsers)(["user-a"], { type: "message.created", payload: { messageId: "m1" } });
    strict_1.default.equal(received.length, 1);
    strict_1.default.equal(received[0].type, "message.created");
    strict_1.default.ok(received[0].ts, "event has a timestamp");
    // Event for a different user is not delivered.
    (0, telegraphEvents_js_1.publishToUsers)(["user-b"], { type: "message.created", payload: { messageId: "m2" } });
    strict_1.default.equal(received.length, 1);
    unsub();
    strict_1.default.equal((0, telegraphEvents_js_1.isUserConnected)("user-a"), false);
    (0, telegraphEvents_js_1.publishToUsers)(["user-a"], { type: "message.created", payload: { messageId: "m3" } });
    strict_1.default.equal(received.length, 1, "no delivery after unsubscribe");
});
(0, node_test_1.test)("publishToUsers de-duplicates repeated ids", function () {
    var received = [];
    var unsub = (0, telegraphEvents_js_1.subscribe)("dedupe-user", function (e) { return received.push(e); });
    (0, telegraphEvents_js_1.publishToUsers)(["dedupe-user", "dedupe-user", "dedupe-user"], { type: "read.updated" });
    strict_1.default.equal(received.length, 1);
    unsub();
});
(0, node_test_1.test)("a throwing subscriber is isolated and does not block others", function () {
    var good = [];
    var unsub1 = (0, telegraphEvents_js_1.subscribe)("multi", function () {
        throw new Error("boom");
    });
    var unsub2 = (0, telegraphEvents_js_1.subscribe)("multi", function (e) { return good.push(e); });
    (0, telegraphEvents_js_1.publishToUsers)(["multi"], { type: "thread.updated" });
    strict_1.default.equal(good.length, 1, "second subscriber still received the event");
    unsub1();
    unsub2();
});
(0, node_test_1.test)("multiple connections for one user all receive the event", function () {
    var a = 0;
    var b = 0;
    var u1 = (0, telegraphEvents_js_1.subscribe)("dual", function () { a++; });
    var u2 = (0, telegraphEvents_js_1.subscribe)("dual", function () { b++; });
    strict_1.default.equal((0, telegraphEvents_js_1.connectedUserCount)() >= 1, true);
    (0, telegraphEvents_js_1.publishToUsers)(["dual"], { type: "typing.started" });
    strict_1.default.equal(a, 1);
    strict_1.default.equal(b, 1);
    u1();
    u2();
});
(0, node_test_1.test)("publishToThread resolves active members and excludes the actor", function () { return __awaiter(void 0, void 0, void 0, function () {
    var fakeClient, actorEvents, other1Events, ua, uo;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                fakeClient = {
                    from: function () {
                        var builder = {
                            select: function () { return builder; },
                            eq: function () { return builder; },
                            is: function () { return builder; },
                            then: function (onF, onR) {
                                return Promise.resolve({
                                    data: [{ user_id: "actor" }, { user_id: "other-1" }, { user_id: "other-2" }],
                                    error: null,
                                }).then(onF, onR);
                            },
                        };
                        return builder;
                    },
                };
                actorEvents = [];
                other1Events = [];
                ua = (0, telegraphEvents_js_1.subscribe)("actor", function (e) { return actorEvents.push(e); });
                uo = (0, telegraphEvents_js_1.subscribe)("other-1", function (e) { return other1Events.push(e); });
                return [4 /*yield*/, (0, telegraphEvents_js_1.publishToThread)(fakeClient, "thread-1", { type: "message.created", payload: { messageId: "m9" } }, { excludeUserId: "actor" })];
            case 1:
                _a.sent();
                strict_1.default.equal(actorEvents.length, 0, "actor is excluded");
                strict_1.default.equal(other1Events.length, 1, "other member received it");
                strict_1.default.equal(other1Events[0].threadId, "thread-1");
                ua();
                uo();
                return [2 /*return*/];
        }
    });
}); });
(0, node_test_1.test)("publishToThread swallows resolver errors", function () { return __awaiter(void 0, void 0, void 0, function () {
    var failingClient;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                failingClient = {
                    from: function () {
                        var builder = {
                            select: function () { return builder; },
                            eq: function () { return builder; },
                            is: function () { return builder; },
                            then: function (_onF, onR) {
                                return Promise.reject(new Error("db down")).then(_onF, onR);
                            },
                        };
                        return builder;
                    },
                };
                // Should not throw.
                return [4 /*yield*/, (0, telegraphEvents_js_1.publishToThread)(failingClient, "thread-x", { type: "thread.updated" })];
            case 1:
                // Should not throw.
                _a.sent();
                strict_1.default.ok(true);
                return [2 /*return*/];
        }
    });
}); });
