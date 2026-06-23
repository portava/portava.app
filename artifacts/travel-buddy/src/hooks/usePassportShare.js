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
exports.usePassportShare = usePassportShare;
/**
 * usePassportShare — captures the PassportShareCard and opens the native share sheet.
 *
 * Uses react-native-share which supports sharing a file + text on both iOS and
 * Android (EXTRA_STREAM + EXTRA_TEXT on Android; UIActivityViewController on iOS).
 *
 * Share payload:
 *   - title:   "@<username>'s Travel Buddy Passport"
 *   - message: human-readable text with deep-link + web fallback URL
 *   - url:     captured JPEG file URI (both platforms)
 *
 * Fallback: if image capture or image-share fails, opens text-only share so
 * the deep-link + web fallback URL always reaches the recipient.
 *
 * Deep link:    travelbuddy://passport/@<username>
 * Web fallback: <EXPO_PUBLIC_WEB_ORIGIN>/u/<username>
 *   EXPO_PUBLIC_WEB_ORIGIN is the Expo web-app root (same Replit dev domain),
 *   distinct from EXPO_PUBLIC_API_BASE_URL so intent is unambiguous.
 *   Falls back to EXPO_PUBLIC_API_BASE_URL origin if WEB_ORIGIN is not set.
 */
var react_1 = require("react");
var react_native_view_shot_1 = require("react-native-view-shot");
var react_native_share_1 = require("react-native-share");
function makeDeepLink(username) {
    return "travelbuddy://passport/@".concat(encodeURIComponent(username));
}
function makeWebFallback(username) {
    var webOrigin = process.env.EXPO_PUBLIC_WEB_ORIGIN ||
        (function () {
            var _a;
            var apiBase = (_a = process.env.EXPO_PUBLIC_API_BASE_URL) !== null && _a !== void 0 ? _a : '';
            try {
                return new URL(apiBase).origin;
            }
            catch (_b) {
                return '';
            }
        })();
    var base = webOrigin.replace(/\/$/, '');
    return base
        ? "".concat(base, "/u/").concat(encodeURIComponent(username))
        : "https://travelbuddy.app/u/".concat(encodeURIComponent(username));
}
/** Ensure the URI has exactly one file:// prefix regardless of what captureRef returns. */
function toFileUri(uri) {
    return uri.startsWith('file://') ? uri : "file://".concat(uri);
}
function usePassportShare(username) {
    var _this = this;
    var cardRef = (0, react_1.useRef)(null);
    var _a = (0, react_1.useState)({ sharing: false, error: null }), state = _a[0], setState = _a[1];
    var share = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var deepLink, webFallback, message, title, imageUri, raw, _a, imgErr_1, msg, e_1, msg;
        var _b, _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    if (!username)
                        return [2 /*return*/];
                    setState({ sharing: true, error: null });
                    deepLink = makeDeepLink(username);
                    webFallback = makeWebFallback(username);
                    message = [
                        "Check out @".concat(username, "'s Travel Buddy Passport! \u2708\uFE0F"),
                        '',
                        "Open in app: ".concat(deepLink),
                        "View online: ".concat(webFallback),
                    ].join('\n');
                    title = "@".concat(username, "'s Travel Buddy Passport");
                    _d.label = 1;
                case 1:
                    _d.trys.push([1, 11, 12, 13]);
                    imageUri = null;
                    if (!cardRef.current) return [3 /*break*/, 5];
                    _d.label = 2;
                case 2:
                    _d.trys.push([2, 4, , 5]);
                    return [4 /*yield*/, (0, react_native_view_shot_1.captureRef)(cardRef, {
                            format: 'jpg',
                            quality: 0.9,
                            result: 'tmpfile',
                        })];
                case 3:
                    raw = _d.sent();
                    imageUri = toFileUri(raw);
                    return [3 /*break*/, 5];
                case 4:
                    _a = _d.sent();
                    imageUri = null;
                    return [3 /*break*/, 5];
                case 5:
                    if (!imageUri) return [3 /*break*/, 9];
                    _d.label = 6;
                case 6:
                    _d.trys.push([6, 8, , 9]);
                    return [4 /*yield*/, react_native_share_1.default.open({
                            title: title,
                            message: message,
                            url: imageUri,
                            type: 'image/jpeg',
                            failOnCancel: false,
                        })];
                case 7:
                    _d.sent();
                    return [2 /*return*/];
                case 8:
                    imgErr_1 = _d.sent();
                    msg = (_b = imgErr_1 === null || imgErr_1 === void 0 ? void 0 : imgErr_1.message) !== null && _b !== void 0 ? _b : '';
                    if (msg.includes('User did not share') || msg.includes('cancelled'))
                        return [2 /*return*/];
                    return [3 /*break*/, 9];
                case 9: 
                /* Text-only fallback: deep-link + web URL always reach the recipient */
                return [4 /*yield*/, react_native_share_1.default.open({ title: title, message: message, failOnCancel: false })];
                case 10:
                    /* Text-only fallback: deep-link + web URL always reach the recipient */
                    _d.sent();
                    return [3 /*break*/, 13];
                case 11:
                    e_1 = _d.sent();
                    msg = (_c = e_1 === null || e_1 === void 0 ? void 0 : e_1.message) !== null && _c !== void 0 ? _c : '';
                    if (!msg.includes('User did not share') && !msg.includes('cancelled')) {
                        setState(function (s) { return (__assign(__assign({}, s), { error: 'Could not open share sheet' })); });
                    }
                    return [3 /*break*/, 13];
                case 12:
                    setState(function (s) { return (__assign(__assign({}, s), { sharing: false })); });
                    return [7 /*endfinally*/];
                case 13: return [2 /*return*/];
            }
        });
    }); }, [username]);
    return { cardRef: cardRef, share: share, sharing: state.sharing, error: state.error };
}
