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
exports.BEARER = void 0;
exports.makeFakeClient = makeFakeClient;
exports.makeApp = makeApp;
var express_1 = require("express");
var vitest_1 = require("vitest");
function makeFakeClient(state) {
    var _this = this;
    // capture inserts for assertions
    var inserted = [];
    function from(table) {
        // builder accumulates filters; terminal methods resolve
        var filters = [];
        var pendingInsert = null;
        var pendingUpdate = null;
        var builder = {
            select: function () { return builder; },
            insert: function (row) {
                pendingInsert = row;
                inserted.push({ table: table, row: row });
                return builder;
            },
            update: function (patch) {
                pendingUpdate = patch;
                return builder;
            },
            delete: function () { return builder; },
            eq: function (col, val) { filters.push(function (r) { return r[col] === val; }); return builder; },
            in: function (col, vals) { filters.push(function (r) { return vals.includes(r[col]); }); return builder; },
            is: function (col, val) { filters.push(function (r) { return (val === null ? r[col] == null : r[col] === val); }); return builder; },
            lt: function (col, val) { filters.push(function (r) { return r[col] < val; }); return builder; },
            or: function () { return builder; }, // visibility OR is not exercised by these unit tests
            order: function () { return builder; },
            limit: function () { return builder; },
            maybeSingle: function () { return resolve(true); },
            single: function () { return resolve(false); },
            then: function (onF, onR) { return resolve(false).then(onF, onR); },
        };
        function rows() {
            var source = [];
            if (table === "trips")
                source = __spreadArray([], state.trips, true).map(function (id) { return ({ id: id }); });
            else if (table === "trip_members")
                source = state.members;
            else if (table === "posts")
                source = state.posts;
            return source.filter(function (r) { return filters.every(function (f) { return f(r); }); });
        }
        function resolve(maybe) {
            return __awaiter(this, void 0, void 0, function () {
                var row, matched_1, row, matched;
                var _a, _b;
                return __generator(this, function (_c) {
                    if (pendingInsert) {
                        row = __assign({ id: "post-new" }, pendingInsert);
                        return [2 /*return*/, { data: row, error: null }];
                    }
                    if (pendingUpdate) {
                        matched_1 = rows();
                        row = matched_1[0] ? __assign(__assign({}, matched_1[0]), pendingUpdate) : null;
                        return [2 /*return*/, { data: row, error: null }];
                    }
                    matched = rows();
                    if (maybe)
                        return [2 /*return*/, { data: (_a = matched[0]) !== null && _a !== void 0 ? _a : null, error: null }];
                    // .single(): error if not exactly one
                    if (matched.length === 1)
                        return [2 /*return*/, { data: matched[0], error: null }];
                    return [2 /*return*/, { data: (_b = matched[0]) !== null && _b !== void 0 ? _b : null, error: null }];
                });
            });
        }
        return builder;
    }
    var client = {
        from: from,
        auth: {
            getUser: vitest_1.vi.fn(function (token) { return __awaiter(_this, void 0, void 0, function () {
                var u;
                return __generator(this, function (_a) {
                    u = state.users[token];
                    if (!u)
                        return [2 /*return*/, { data: { user: null }, error: { message: "invalid" } }];
                    return [2 /*return*/, { data: { user: u }, error: null }];
                });
            }); }),
        },
        __inserted: inserted,
    };
    return client;
}
/**
 * Build an Express app with the posts routes, wired to a fake client.
 * We mock the ../lib/supabase module so requireUser() uses our fake.
 */
function makeApp(state) {
    return __awaiter(this, void 0, void 0, function () {
        var client, fake, postsRouter, app;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    client = makeFakeClient(state);
                    fake = { isServiceClientReady: true, getServiceClient: function () { return client; } };
                    vitest_1.vi.doMock("../lib/supabase", function () { return fake; });
                    vitest_1.vi.doMock("../lib/supabase.js", function () { return fake; });
                    return [4 /*yield*/, Promise.resolve().then(function () { return require("../routes/posts"); })];
                case 1:
                    postsRouter = (_a.sent()).default;
                    app = (0, express_1.default)();
                    app.use(express_1.default.json());
                    // minimal req.log so route error logging doesn't throw
                    app.use(function (req, _res, next) {
                        req.log = { error: function () { }, info: function () { }, warn: function () { } };
                        next();
                    });
                    app.use("/api", postsRouter);
                    return [2 /*return*/, { app: app, client: client }];
            }
        });
    });
}
var BEARER = function (t) { return ({ Authorization: "Bearer ".concat(t) }); };
exports.BEARER = BEARER;
