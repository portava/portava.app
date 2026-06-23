"use strict";
var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (Object.prototype.hasOwnProperty.call(b, p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        if (typeof b !== "function" && b !== null)
            throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
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
var __rest = (this && this.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ResponseParseError = exports.ApiError = void 0;
exports.setBaseUrl = setBaseUrl;
exports.setAuthTokenGetter = setAuthTokenGetter;
exports.customFetch = customFetch;
var NO_BODY_STATUS = new Set([204, 205, 304]);
var DEFAULT_JSON_ACCEPT = "application/json, application/problem+json";
// ---------------------------------------------------------------------------
// Module-level configuration
// ---------------------------------------------------------------------------
var _baseUrl = null;
var _authTokenGetter = null;
/**
 * Set a base URL that is prepended to every relative request URL
 * (i.e. paths that start with `/`).
 *
 * Useful for Expo bundles that need to call a remote API server.
 * Pass `null` to clear the base URL.
 */
function setBaseUrl(url) {
    _baseUrl = url ? url.replace(/\/+$/, "") : null;
}
/**
 * Register a getter that supplies a bearer auth token.  Before every fetch
 * the getter is invoked; when it returns a non-null string, an
 * `Authorization: Bearer <token>` header is attached to the request.
 *
 * Useful for Expo bundles making token-gated API calls.
 * Pass `null` to clear the getter.
 *
 * NOTE: This function should never be used in web applications where session
 * token cookies are automatically associated with API calls by the browser.
 */
function setAuthTokenGetter(getter) {
    _authTokenGetter = getter;
}
function isRequest(input) {
    return typeof Request !== "undefined" && input instanceof Request;
}
function resolveMethod(input, explicitMethod) {
    if (explicitMethod)
        return explicitMethod.toUpperCase();
    if (isRequest(input))
        return input.method.toUpperCase();
    return "GET";
}
// Use loose check for URL — some runtimes (e.g. React Native) polyfill URL
// differently, so `instanceof URL` can fail.
function isUrl(input) {
    return typeof URL !== "undefined" && input instanceof URL;
}
function applyBaseUrl(input) {
    if (!_baseUrl)
        return input;
    var url = resolveUrl(input);
    // Only prepend to relative paths (starting with /)
    if (!url.startsWith("/"))
        return input;
    var absolute = "".concat(_baseUrl).concat(url);
    if (typeof input === "string")
        return absolute;
    if (isUrl(input))
        return new URL(absolute);
    return new Request(absolute, input);
}
function resolveUrl(input) {
    if (typeof input === "string")
        return input;
    if (isUrl(input))
        return input.toString();
    return input.url;
}
function mergeHeaders() {
    var sources = [];
    for (var _i = 0; _i < arguments.length; _i++) {
        sources[_i] = arguments[_i];
    }
    var headers = new Headers();
    for (var _a = 0, sources_1 = sources; _a < sources_1.length; _a++) {
        var source = sources_1[_a];
        if (!source)
            continue;
        new Headers(source).forEach(function (value, key) {
            headers.set(key, value);
        });
    }
    return headers;
}
function getMediaType(headers) {
    var value = headers.get("content-type");
    return value ? value.split(";", 1)[0].trim().toLowerCase() : null;
}
function isJsonMediaType(mediaType) {
    return mediaType === "application/json" || Boolean(mediaType === null || mediaType === void 0 ? void 0 : mediaType.endsWith("+json"));
}
function isTextMediaType(mediaType) {
    return Boolean(mediaType &&
        (mediaType.startsWith("text/") ||
            mediaType === "application/xml" ||
            mediaType === "text/xml" ||
            mediaType.endsWith("+xml") ||
            mediaType === "application/x-www-form-urlencoded"));
}
// Use strict equality: in browsers, `response.body` is `null` when the
// response genuinely has no content.  In React Native, `response.body` is
// always `undefined` because the ReadableStream API is not implemented —
// even when the response carries a full payload readable via `.text()` or
// `.json()`.  Loose equality (`== null`) matches both `null` and `undefined`,
// which causes every React Native response to be treated as empty.
function hasNoBody(response, method) {
    if (method === "HEAD")
        return true;
    if (NO_BODY_STATUS.has(response.status))
        return true;
    if (response.headers.get("content-length") === "0")
        return true;
    if (response.body === null)
        return true;
    return false;
}
function stripBom(text) {
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
function looksLikeJson(text) {
    var trimmed = text.trimStart();
    return trimmed.startsWith("{") || trimmed.startsWith("[");
}
function getStringField(value, key) {
    if (!value || typeof value !== "object")
        return undefined;
    var candidate = value[key];
    if (typeof candidate !== "string")
        return undefined;
    var trimmed = candidate.trim();
    return trimmed === "" ? undefined : trimmed;
}
function truncate(text, maxLength) {
    if (maxLength === void 0) { maxLength = 300; }
    return text.length > maxLength ? "".concat(text.slice(0, maxLength - 1), "\u2026") : text;
}
function buildErrorMessage(response, data) {
    var _a, _b;
    var prefix = "HTTP ".concat(response.status, " ").concat(response.statusText);
    if (typeof data === "string") {
        var text = data.trim();
        return text ? "".concat(prefix, ": ").concat(truncate(text)) : prefix;
    }
    var title = getStringField(data, "title");
    var detail = getStringField(data, "detail");
    var message = (_b = (_a = getStringField(data, "message")) !== null && _a !== void 0 ? _a : getStringField(data, "error_description")) !== null && _b !== void 0 ? _b : getStringField(data, "error");
    if (title && detail)
        return "".concat(prefix, ": ").concat(title, " \u2014 ").concat(detail);
    if (detail)
        return "".concat(prefix, ": ").concat(detail);
    if (message)
        return "".concat(prefix, ": ").concat(message);
    if (title)
        return "".concat(prefix, ": ").concat(title);
    return prefix;
}
var ApiError = /** @class */ (function (_super) {
    __extends(ApiError, _super);
    function ApiError(response, data, requestInfo) {
        var _newTarget = this.constructor;
        var _this = _super.call(this, buildErrorMessage(response, data)) || this;
        _this.name = "ApiError";
        Object.setPrototypeOf(_this, _newTarget.prototype);
        _this.status = response.status;
        _this.statusText = response.statusText;
        _this.data = data;
        _this.headers = response.headers;
        _this.response = response;
        _this.method = requestInfo.method;
        _this.url = response.url || requestInfo.url;
        return _this;
    }
    return ApiError;
}(Error));
exports.ApiError = ApiError;
var ResponseParseError = /** @class */ (function (_super) {
    __extends(ResponseParseError, _super);
    function ResponseParseError(response, rawBody, cause, requestInfo) {
        var _newTarget = this.constructor;
        var _this = _super.call(this, "Failed to parse response from ".concat(requestInfo.method, " ").concat(response.url || requestInfo.url, " ") +
            "(".concat(response.status, " ").concat(response.statusText, ") as JSON")) || this;
        _this.name = "ResponseParseError";
        Object.setPrototypeOf(_this, _newTarget.prototype);
        _this.status = response.status;
        _this.statusText = response.statusText;
        _this.headers = response.headers;
        _this.response = response;
        _this.method = requestInfo.method;
        _this.url = response.url || requestInfo.url;
        _this.rawBody = rawBody;
        _this.cause = cause;
        return _this;
    }
    return ResponseParseError;
}(Error));
exports.ResponseParseError = ResponseParseError;
function parseJsonBody(response, requestInfo) {
    return __awaiter(this, void 0, void 0, function () {
        var raw, normalized;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, response.text()];
                case 1:
                    raw = _a.sent();
                    normalized = stripBom(raw);
                    if (normalized.trim() === "") {
                        return [2 /*return*/, null];
                    }
                    try {
                        return [2 /*return*/, JSON.parse(normalized)];
                    }
                    catch (cause) {
                        throw new ResponseParseError(response, raw, cause, requestInfo);
                    }
                    return [2 /*return*/];
            }
        });
    });
}
function parseErrorBody(response, method) {
    return __awaiter(this, void 0, void 0, function () {
        var mediaType, raw, normalized, trimmed;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (hasNoBody(response, method)) {
                        return [2 /*return*/, null];
                    }
                    mediaType = getMediaType(response.headers);
                    // Fall back to text when blob() is unavailable (e.g. some React Native builds).
                    if (mediaType && !isJsonMediaType(mediaType) && !isTextMediaType(mediaType)) {
                        return [2 /*return*/, typeof response.blob === "function" ? response.blob() : response.text()];
                    }
                    return [4 /*yield*/, response.text()];
                case 1:
                    raw = _a.sent();
                    normalized = stripBom(raw);
                    trimmed = normalized.trim();
                    if (trimmed === "") {
                        return [2 /*return*/, null];
                    }
                    if (isJsonMediaType(mediaType) || looksLikeJson(normalized)) {
                        try {
                            return [2 /*return*/, JSON.parse(normalized)];
                        }
                        catch (_b) {
                            return [2 /*return*/, raw];
                        }
                    }
                    return [2 /*return*/, raw];
            }
        });
    });
}
function inferResponseType(response) {
    var mediaType = getMediaType(response.headers);
    if (isJsonMediaType(mediaType))
        return "json";
    if (isTextMediaType(mediaType) || mediaType == null)
        return "text";
    return "blob";
}
function parseSuccessBody(response, responseType, requestInfo) {
    return __awaiter(this, void 0, void 0, function () {
        var effectiveType, _a, text;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (hasNoBody(response, requestInfo.method)) {
                        return [2 /*return*/, null];
                    }
                    effectiveType = responseType === "auto" ? inferResponseType(response) : responseType;
                    _a = effectiveType;
                    switch (_a) {
                        case "json": return [3 /*break*/, 1];
                        case "text": return [3 /*break*/, 2];
                        case "blob": return [3 /*break*/, 4];
                    }
                    return [3 /*break*/, 5];
                case 1: return [2 /*return*/, parseJsonBody(response, requestInfo)];
                case 2: return [4 /*yield*/, response.text()];
                case 3:
                    text = _b.sent();
                    return [2 /*return*/, text === "" ? null : text];
                case 4:
                    if (typeof response.blob !== "function") {
                        throw new TypeError("Blob responses are not supported in this runtime. " +
                            "Use responseType \"json\" or \"text\" instead.");
                    }
                    return [2 /*return*/, response.blob()];
                case 5: return [2 /*return*/];
            }
        });
    });
}
function customFetch(input_1) {
    return __awaiter(this, arguments, void 0, function (input, options) {
        var _a, responseType, headersInit, init, method, headers, token, requestInfo, response, errorData;
        if (options === void 0) { options = {}; }
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    input = applyBaseUrl(input);
                    _a = options.responseType, responseType = _a === void 0 ? "auto" : _a, headersInit = options.headers, init = __rest(options, ["responseType", "headers"]);
                    method = resolveMethod(input, init.method);
                    if (init.body != null && (method === "GET" || method === "HEAD")) {
                        throw new TypeError("customFetch: ".concat(method, " requests cannot have a body."));
                    }
                    headers = mergeHeaders(isRequest(input) ? input.headers : undefined, headersInit);
                    if (typeof init.body === "string" &&
                        !headers.has("content-type") &&
                        looksLikeJson(init.body)) {
                        headers.set("content-type", "application/json");
                    }
                    if (responseType === "json" && !headers.has("accept")) {
                        headers.set("accept", DEFAULT_JSON_ACCEPT);
                    }
                    if (!(_authTokenGetter && !headers.has("authorization"))) return [3 /*break*/, 2];
                    return [4 /*yield*/, _authTokenGetter()];
                case 1:
                    token = _b.sent();
                    if (token) {
                        headers.set("authorization", "Bearer ".concat(token));
                    }
                    _b.label = 2;
                case 2:
                    requestInfo = { method: method, url: resolveUrl(input) };
                    return [4 /*yield*/, fetch(input, __assign(__assign({}, init), { method: method, headers: headers }))];
                case 3:
                    response = _b.sent();
                    if (!!response.ok) return [3 /*break*/, 5];
                    return [4 /*yield*/, parseErrorBody(response, method)];
                case 4:
                    errorData = _b.sent();
                    throw new ApiError(response, errorData, requestInfo);
                case 5: return [4 /*yield*/, parseSuccessBody(response, responseType, requestInfo)];
                case 6: return [2 /*return*/, (_b.sent())];
            }
        });
    });
}
