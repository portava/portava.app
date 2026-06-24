"use strict";
/**
 * Minimal Expo Push Notification helper.
 *
 * Uses the Expo Push API directly (no SDK dependency).
 * Silently no-ops if no tokens are provided or the request fails.
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
exports.sendPushNotification = sendPushNotification;
var logger_js_1 = require("./logger.js");
var EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
/**
 * Send a push notification to one or more Expo push tokens.
 * Tokens that are empty or non-Expo-format are silently dropped.
 */
function sendPushNotification(tokens, payload) {
    return __awaiter(this, void 0, void 0, function () {
        var valid, messages, res, err_1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    valid = tokens.filter(function (t) {
                        return typeof t === "string" && t.startsWith("ExponentPushToken[");
                    });
                    if (valid.length === 0)
                        return [2 /*return*/];
                    messages = valid.map(function (to) {
                        var _a;
                        return ({
                            to: to,
                            title: payload.title,
                            body: payload.body,
                            data: (_a = payload.data) !== null && _a !== void 0 ? _a : {},
                            sound: "default",
                        });
                    });
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, fetch(EXPO_PUSH_URL, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify(messages),
                        })];
                case 2:
                    res = _a.sent();
                    if (!res.ok) {
                        logger_js_1.logger.warn({ status: res.status }, "expo push: non-2xx response");
                    }
                    return [3 /*break*/, 4];
                case 3:
                    err_1 = _a.sent();
                    logger_js_1.logger.warn({ err: err_1 }, "expo push: network error");
                    return [3 /*break*/, 4];
                case 4: return [2 /*return*/];
            }
        });
    });
}
