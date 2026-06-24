"use strict";
/**
 * Telegraph realtime service.
 *
 * Maintains a single long-lived Server-Sent Events (SSE) connection to the API
 * server (`GET /api/telegraph/stream`) and fans incoming events out to local
 * subscribers. Implemented over XMLHttpRequest because React Native's XHR can
 * set an Authorization header and exposes the incrementally-growing
 * `responseText` during the LOADING state — EventSource is not built in.
 *
 * Design guarantees:
 *   - Polling remains the source of truth. This service is an *enhancement*: if
 *     the stream cannot connect, status flips to 'polling' and consumers simply
 *     keep their existing poll loops. Nothing breaks when realtime is down.
 *   - Reconnects with exponential backoff (capped). Each consumer subscribes
 *     once; the underlying connection is reference-counted and shared.
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
exports.telegraphRealtime = void 0;
var supabase_1 = require("../lib/supabase");
var RECONNECT_BASE_MS = 1000;
var RECONNECT_MAX_MS = 30000;
/** After this many consecutive failures we surface 'polling' to consumers. */
var POLLING_AFTER_FAILURES = 2;
function apiBase() {
    var _a;
    return (_a = process.env.EXPO_PUBLIC_API_BASE_URL) !== null && _a !== void 0 ? _a : '';
}
var TelegraphRealtime = /** @class */ (function () {
    function TelegraphRealtime() {
        this.xhr = null;
        this.eventListeners = new Set();
        this.statusListeners = new Set();
        this.status = 'idle';
        this.parseOffset = 0;
        this.reconnectTimer = null;
        this.failureCount = 0;
        this.started = false;
        this.stopped = false;
    }
    /** Subscribe to realtime events. Starts the connection on first subscriber. */
    TelegraphRealtime.prototype.subscribe = function (listener) {
        var _this = this;
        this.eventListeners.add(listener);
        this.ensureStarted();
        return function () {
            _this.eventListeners.delete(listener);
            _this.maybeStop();
        };
    };
    /** Subscribe to connection-status changes. */
    TelegraphRealtime.prototype.onStatus = function (listener) {
        var _this = this;
        this.statusListeners.add(listener);
        listener(this.status);
        return function () {
            _this.statusListeners.delete(listener);
        };
    };
    TelegraphRealtime.prototype.getStatus = function () {
        return this.status;
    };
    TelegraphRealtime.prototype.ensureStarted = function () {
        if (this.started)
            return;
        this.started = true;
        this.stopped = false;
        void this.connect();
    };
    TelegraphRealtime.prototype.maybeStop = function () {
        // Keep the connection while any consumer is interested.
        if (this.eventListeners.size > 0)
            return;
        this.stopped = true;
        this.started = false;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.xhr) {
            try {
                this.xhr.abort();
            }
            catch ( /* noop */_a) { /* noop */ }
            this.xhr = null;
        }
        this.setStatus('idle');
    };
    TelegraphRealtime.prototype.setStatus = function (next) {
        if (this.status === next)
            return;
        this.status = next;
        for (var _i = 0, _a = this.statusListeners; _i < _a.length; _i++) {
            var l = _a[_i];
            try {
                l(next);
            }
            catch ( /* isolate */_b) { /* isolate */ }
        }
    };
    TelegraphRealtime.prototype.connect = function () {
        return __awaiter(this, void 0, void 0, function () {
            var base, data, token, xhr;
            var _this = this;
            var _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        if (this.stopped)
                            return [2 /*return*/];
                        base = apiBase();
                        if (!base) {
                            this.setStatus('polling');
                            return [2 /*return*/];
                        }
                        return [4 /*yield*/, supabase_1.supabase.auth.getSession()];
                    case 1:
                        data = (_b.sent()).data;
                        token = (_a = data.session) === null || _a === void 0 ? void 0 : _a.access_token;
                        if (!token) {
                            // Not signed in yet; retry later without escalating to a hard failure.
                            this.scheduleReconnect();
                            return [2 /*return*/];
                        }
                        if (this.stopped)
                            return [2 /*return*/];
                        this.setStatus('connecting');
                        this.parseOffset = 0;
                        xhr = new XMLHttpRequest();
                        this.xhr = xhr;
                        try {
                            xhr.open('GET', "".concat(base, "/api/telegraph/stream"));
                            xhr.setRequestHeader('Authorization', "Bearer ".concat(token));
                            xhr.setRequestHeader('Accept', 'text/event-stream');
                            xhr.onreadystatechange = function () {
                                var _a;
                                if (xhr.readyState >= 2 && xhr.status === 200 && _this.status !== 'open') {
                                    _this.failureCount = 0;
                                    _this.setStatus('open');
                                }
                                if (xhr.readyState === 3 || xhr.readyState === 4) {
                                    _this.consume((_a = xhr.responseText) !== null && _a !== void 0 ? _a : '');
                                }
                                if (xhr.readyState === 4) {
                                    _this.handleDisconnect();
                                }
                            };
                            xhr.onerror = function () { return _this.handleDisconnect(); };
                            xhr.ontimeout = function () { return _this.handleDisconnect(); };
                            xhr.send();
                        }
                        catch (_c) {
                            this.handleDisconnect();
                        }
                        return [2 /*return*/];
                }
            });
        });
    };
    /** Parse any newly-arrived bytes from the accumulating responseText. */
    TelegraphRealtime.prototype.consume = function (text) {
        if (text.length <= this.parseOffset)
            return;
        var chunk = text.slice(this.parseOffset);
        this.parseOffset = text.length;
        // SSE frames are separated by a blank line. Keep the trailing partial frame
        // by rewinding the offset to the last complete boundary.
        var lastBoundary = chunk.lastIndexOf('\n\n');
        if (lastBoundary === -1) {
            // No complete frame yet — rewind so we re-read this chunk next time.
            this.parseOffset -= chunk.length;
            return;
        }
        var complete = chunk.slice(0, lastBoundary);
        // Push back the unparsed remainder.
        this.parseOffset -= chunk.length - (lastBoundary + 2);
        for (var _i = 0, _a = complete.split('\n\n'); _i < _a.length; _i++) {
            var frame = _a[_i];
            this.parseFrame(frame);
        }
    };
    TelegraphRealtime.prototype.parseFrame = function (frame) {
        var trimmed = frame.trim();
        if (!trimmed || trimmed.startsWith(':'))
            return; // heartbeat / comment
        var dataLine = '';
        for (var _i = 0, _a = trimmed.split('\n'); _i < _a.length; _i++) {
            var line = _a[_i];
            if (line.startsWith('data:'))
                dataLine += line.slice(5).trim();
        }
        if (!dataLine)
            return;
        try {
            var evt = JSON.parse(dataLine);
            if (!evt || typeof evt.type !== 'string')
                return;
            for (var _b = 0, _c = this.eventListeners; _b < _c.length; _b++) {
                var l = _c[_b];
                try {
                    l(evt);
                }
                catch ( /* isolate consumer errors */_d) { /* isolate consumer errors */ }
            }
        }
        catch (_e) {
            // Ignore the `connected` handshake and any malformed frame.
        }
    };
    TelegraphRealtime.prototype.handleDisconnect = function () {
        if (this.xhr) {
            try {
                this.xhr.abort();
            }
            catch ( /* noop */_a) { /* noop */ }
            this.xhr = null;
        }
        if (this.stopped)
            return;
        this.failureCount += 1;
        if (this.failureCount >= POLLING_AFTER_FAILURES) {
            this.setStatus('polling');
        }
        this.scheduleReconnect();
    };
    TelegraphRealtime.prototype.scheduleReconnect = function () {
        var _this = this;
        if (this.stopped || this.reconnectTimer)
            return;
        var delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, Math.min(this.failureCount, 5)), RECONNECT_MAX_MS);
        this.reconnectTimer = setTimeout(function () {
            _this.reconnectTimer = null;
            void _this.connect();
        }, delay);
    };
    return TelegraphRealtime;
}());
exports.telegraphRealtime = new TelegraphRealtime();
