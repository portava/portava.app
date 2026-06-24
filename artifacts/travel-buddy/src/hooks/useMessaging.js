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
exports.markHighlightsViewed = exports.markThreadRead = void 0;
exports.useMessagePermission = useMessagePermission;
exports.useOutgoingRequestStatus = useOutgoingRequestStatus;
exports.useIncomingMessageRequests = useIncomingMessageRequests;
exports.useMyThreads = useMyThreads;
exports.useThreadMessages = useThreadMessages;
exports.useUnreadCounts = useUnreadCounts;
exports.useLanguageSettings = useLanguageSettings;
/**
 * Messaging hooks — same {data, loading, error, reload} shape as other hooks.
 * All reads/writes go through src/services/messaging.ts → API server.
 *
 * Polling:
 *   - useMyThreads    — refreshes the inbox every 7 s while the app is active.
 *   - useThreadMessages — merges new messages every 3 s while the app is active.
 *   Both hooks pause polling when AppState leaves 'active' and resume on return.
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var messaging_1 = require("../services/messaging");
Object.defineProperty(exports, "markThreadRead", { enumerable: true, get: function () { return messaging_1.markThreadRead; } });
Object.defineProperty(exports, "markHighlightsViewed", { enumerable: true, get: function () { return messaging_1.markHighlightsViewed; } });
var telegraphRealtimeService_1 = require("../services/telegraphRealtimeService");
var SessionContext_1 = require("../context/SessionContext");
// When realtime is connected we lean on pushed events and poll only as a slow
// safety net. When realtime is unavailable the service reports 'polling' and
// these intervals carry the full load.
var THREAD_POLL_MS = 3000;
var INBOX_POLL_MS = 7000;
var UNREAD_POLL_MS = 15000;
/** How long a peer is shown as "typing" before we auto-clear it. */
var TYPING_TTL_MS = 6000;
function makeClientId() {
    return "c_".concat(Date.now().toString(36), "_").concat(Math.random().toString(36).slice(2, 10));
}
// ── Message permission (for profile / passport) ───────────────────────────────
function useMessagePermission(userId) {
    var _this = this;
    var _a = (0, react_1.useState)(null), verdict = _a[0], setVerdict = _a[1];
    var _b = (0, react_1.useState)(null), result = _b[0], setResult = _b[1];
    var _c = (0, react_1.useState)(false), loading = _c[0], setLoading = _c[1];
    var _d = (0, react_1.useState)(null), error = _d[0], setError = _d[1];
    var reload = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var res;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (!userId)
                        return [2 /*return*/];
                    setLoading(true);
                    setError(null);
                    return [4 /*yield*/, (0, messaging_1.getMessagePermission)(userId)];
                case 1:
                    res = _b.sent();
                    if (res.ok && res.data) {
                        setResult(res.data);
                        setVerdict(res.data.verdict);
                    }
                    else {
                        setError((_a = res.message) !== null && _a !== void 0 ? _a : 'Failed to load message permission');
                    }
                    setLoading(false);
                    return [2 /*return*/];
            }
        });
    }); }, [userId]);
    (0, react_1.useEffect)(function () {
        reload();
    }, [reload]);
    var send = (0, react_1.useCallback)(function (previewText) { return __awaiter(_this, void 0, void 0, function () {
        var res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (!userId)
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'config_error' }];
                    return [4 /*yield*/, (0, messaging_1.sendMessageRequest)(userId, previewText)];
                case 1:
                    res = _a.sent();
                    return [2 /*return*/, res];
            }
        });
    }); }, [userId]);
    return { verdict: verdict, result: result, loading: loading, error: error, reload: reload, send: send };
}
// ── Outgoing request status (for sender-side "Waiting for reply" state) ───────
function useOutgoingRequestStatus(otherUserId) {
    var _this = this;
    var _a = (0, react_1.useState)(null), pending = _a[0], setPending = _a[1];
    var _b = (0, react_1.useState)(false), loading = _b[0], setLoading = _b[1];
    var reload = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (!otherUserId)
                        return [2 /*return*/];
                    setLoading(true);
                    return [4 /*yield*/, (0, messaging_1.getOutgoingRequestStatus)(otherUserId)];
                case 1:
                    res = _a.sent();
                    if (res.ok && res.data)
                        setPending(res.data.pending);
                    setLoading(false);
                    return [2 /*return*/];
            }
        });
    }); }, [otherUserId]);
    (0, react_1.useEffect)(function () {
        reload();
    }, [reload]);
    return { pending: pending, loading: loading, reload: reload };
}
// ── Incoming message requests (for Request Inbox) ─────────────────────────────
function useIncomingMessageRequests() {
    var _this = this;
    var _a = (0, react_1.useState)([]), data = _a[0], setData = _a[1];
    var _b = (0, react_1.useState)(true), loading = _b[0], setLoading = _b[1];
    var _c = (0, react_1.useState)(null), error = _c[0], setError = _c[1];
    var reload = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var res;
        var _a, _b, _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    setLoading(true);
                    setError(null);
                    return [4 /*yield*/, (0, messaging_1.getIncomingMessageRequests)()];
                case 1:
                    res = _d.sent();
                    if (res.ok)
                        setData((_b = (_a = res.data) === null || _a === void 0 ? void 0 : _a.requests) !== null && _b !== void 0 ? _b : []);
                    else
                        setError((_c = res.message) !== null && _c !== void 0 ? _c : 'Failed to load message requests');
                    setLoading(false);
                    return [2 /*return*/];
            }
        });
    }); }, []);
    (0, react_1.useEffect)(function () {
        reload();
    }, [reload]);
    var accept = (0, react_1.useCallback)(function (requestId) { return __awaiter(_this, void 0, void 0, function () {
        var res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, messaging_1.acceptMessageRequest)(requestId)];
                case 1:
                    res = _a.sent();
                    if (res.ok)
                        setData(function (prev) { return prev.filter(function (r) { return r.requestId !== requestId; }); });
                    return [2 /*return*/, res];
            }
        });
    }); }, []);
    var decline = (0, react_1.useCallback)(function (requestId) { return __awaiter(_this, void 0, void 0, function () {
        var res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, messaging_1.declineMessageRequest)(requestId)];
                case 1:
                    res = _a.sent();
                    if (res.ok)
                        setData(function (prev) { return prev.filter(function (r) { return r.requestId !== requestId; }); });
                    return [2 /*return*/, res];
            }
        });
    }); }, []);
    return { data: data, loading: loading, error: error, reload: reload, accept: accept, decline: decline };
}
// ── Threads list (with inbox polling) ─────────────────────────────────────────
function useMyThreads() {
    var _this = this;
    var _a = (0, react_1.useState)([]), data = _a[0], setData = _a[1];
    var _b = (0, react_1.useState)(true), loading = _b[0], setLoading = _b[1];
    var _c = (0, react_1.useState)(null), error = _c[0], setError = _c[1];
    var appStateRef = (0, react_1.useRef)(react_native_1.AppState.currentState);
    var reload = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var res;
        var _a, _b, _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    setLoading(true);
                    setError(null);
                    return [4 /*yield*/, (0, messaging_1.getMyThreads)()];
                case 1:
                    res = _d.sent();
                    if (res.ok)
                        setData((_b = (_a = res.data) === null || _a === void 0 ? void 0 : _a.threads) !== null && _b !== void 0 ? _b : []);
                    else
                        setError((_c = res.message) !== null && _c !== void 0 ? _c : 'Failed to load threads');
                    setLoading(false);
                    return [2 /*return*/];
            }
        });
    }); }, []);
    var silentPoll = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var res;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (appStateRef.current !== 'active')
                        return [2 /*return*/];
                    return [4 /*yield*/, (0, messaging_1.getMyThreads)()];
                case 1:
                    res = _b.sent();
                    if (res.ok && res.data) {
                        setData((_a = res.data.threads) !== null && _a !== void 0 ? _a : []);
                    }
                    return [2 /*return*/];
            }
        });
    }); }, []);
    (0, react_1.useEffect)(function () {
        reload();
    }, [reload]);
    (0, react_1.useEffect)(function () {
        var sub = react_native_1.AppState.addEventListener('change', function (next) {
            appStateRef.current = next;
        });
        var timer = setInterval(silentPoll, INBOX_POLL_MS);
        return function () {
            sub.remove();
            clearInterval(timer);
        };
    }, [silentPoll]);
    // Realtime: refresh the inbox immediately when a relevant event arrives.
    (0, react_1.useEffect)(function () {
        var unsub = telegraphRealtimeService_1.telegraphRealtime.subscribe(function (evt) {
            if (evt.type === 'message.created' ||
                evt.type === 'thread.updated' ||
                evt.type === 'member.left' ||
                evt.type === 'request.accepted') {
                void silentPoll();
            }
        });
        return unsub;
    }, [silentPoll]);
    return { data: data, loading: loading, error: error, reload: reload };
}
// ── Thread chat (with message polling) ────────────────────────────────────────
function useThreadMessages(threadId) {
    var _this = this;
    var userId = (0, SessionContext_1.useSession)().userId;
    var _a = (0, react_1.useState)([]), messages = _a[0], setMessages = _a[1];
    var _b = (0, react_1.useState)(true), loading = _b[0], setLoading = _b[1];
    var _c = (0, react_1.useState)(null), error = _c[0], setError = _c[1];
    var _d = (0, react_1.useState)(false), sending = _d[0], setSending = _d[1];
    var _e = (0, react_1.useState)([]), typingUserIds = _e[0], setTypingUserIds = _e[1];
    var appStateRef = (0, react_1.useRef)(react_native_1.AppState.currentState);
    var sendingRef = (0, react_1.useRef)(false);
    var typingTimers = (0, react_1.useRef)(new Map());
    var lastTypingSentRef = (0, react_1.useRef)(0);
    var reload = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var res;
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    if (!threadId)
                        return [2 /*return*/];
                    setLoading(true);
                    setError(null);
                    return [4 /*yield*/, (0, messaging_1.getThreadMessages)(threadId)];
                case 1:
                    res = _c.sent();
                    if (res.ok && res.data) {
                        setMessages(__spreadArray([], ((_a = res.data.messages) !== null && _a !== void 0 ? _a : []), true).reverse());
                    }
                    else {
                        setError((_b = res.message) !== null && _b !== void 0 ? _b : 'Failed to load messages');
                    }
                    setLoading(false);
                    return [2 /*return*/];
            }
        });
    }); }, [threadId]);
    var silentPoll = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var res, incoming;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (!threadId || appStateRef.current !== 'active' || sendingRef.current)
                        return [2 /*return*/];
                    return [4 /*yield*/, (0, messaging_1.getThreadMessages)(threadId)];
                case 1:
                    res = _b.sent();
                    if (!res.ok || !res.data)
                        return [2 /*return*/];
                    incoming = __spreadArray([], ((_a = res.data.messages) !== null && _a !== void 0 ? _a : []), true).reverse();
                    if (incoming.length === 0)
                        return [2 /*return*/];
                    setMessages(function (prev) {
                        var incomingById = new Map(incoming.map(function (m) { return [m.id, m]; }));
                        var existingIds = new Set(prev.map(function (m) { return m.id; }));
                        var fresh = incoming.filter(function (m) { return !existingIds.has(m.id); });
                        // Merge translation updates for existing messages whose status resolved
                        // since the last render (pending → translated/failed/skipped).
                        // Only replace the entry when status actually changes to avoid flicker.
                        var hasTranslationUpdate = false;
                        var updated = prev.map(function (m) {
                            if (m.translationStatus === 'pending') {
                                var refreshed = incomingById.get(m.id);
                                if (refreshed && refreshed.translationStatus !== 'pending') {
                                    hasTranslationUpdate = true;
                                    return refreshed;
                                }
                            }
                            return m;
                        });
                        if (fresh.length === 0 && !hasTranslationUpdate)
                            return prev;
                        if (fresh.length === 0)
                            return updated;
                        return __spreadArray(__spreadArray([], updated, true), fresh, true);
                    });
                    return [2 /*return*/];
            }
        });
    }); }, [threadId]);
    (0, react_1.useEffect)(function () {
        reload();
    }, [reload]);
    (0, react_1.useEffect)(function () {
        var sub = react_native_1.AppState.addEventListener('change', function (next) {
            appStateRef.current = next;
        });
        var timer = setInterval(silentPoll, THREAD_POLL_MS);
        return function () {
            sub.remove();
            clearInterval(timer);
        };
    }, [silentPoll]);
    // Realtime: react to events scoped to this thread.
    (0, react_1.useEffect)(function () {
        if (!threadId)
            return;
        var clearTyping = function (uid) {
            var t = typingTimers.current.get(uid);
            if (t) {
                clearTimeout(t);
                typingTimers.current.delete(uid);
            }
            setTypingUserIds(function (prev) { return prev.filter(function (id) { return id !== uid; }); });
        };
        var unsub = telegraphRealtimeService_1.telegraphRealtime.subscribe(function (evt) {
            var _a, _b, _c, _d;
            if (evt.threadId && evt.threadId !== threadId)
                return;
            switch (evt.type) {
                case 'message.created':
                case 'message.updated':
                case 'message.translated':
                case 'read.updated':
                    void silentPoll();
                    break;
                case 'typing.started': {
                    var uid_1 = (_b = (_a = evt.payload) === null || _a === void 0 ? void 0 : _a.userId) !== null && _b !== void 0 ? _b : '';
                    if (!uid_1)
                        break;
                    var existing = typingTimers.current.get(uid_1);
                    if (existing)
                        clearTimeout(existing);
                    typingTimers.current.set(uid_1, setTimeout(function () { return clearTyping(uid_1); }, TYPING_TTL_MS));
                    setTypingUserIds(function (prev) { return (prev.includes(uid_1) ? prev : __spreadArray(__spreadArray([], prev, true), [uid_1], false)); });
                    break;
                }
                case 'typing.stopped': {
                    var uid = (_d = (_c = evt.payload) === null || _c === void 0 ? void 0 : _c.userId) !== null && _d !== void 0 ? _d : '';
                    if (uid)
                        clearTyping(uid);
                    break;
                }
                default:
                    break;
            }
        });
        var timers = typingTimers.current;
        return function () {
            unsub();
            timers.forEach(function (t) { return clearTimeout(t); });
            timers.clear();
            setTypingUserIds([]);
        };
    }, [threadId, silentPoll]);
    /** Optimistically append a message, then reconcile with the server response. */
    var send = (0, react_1.useCallback)(function (body, opts) { return __awaiter(_this, void 0, void 0, function () {
        var trimmed, clientId, optimistic, res, server_1;
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    trimmed = body.trim();
                    if (!threadId || !trimmed)
                        return [2 /*return*/];
                    clientId = makeClientId();
                    optimistic = {
                        id: clientId,
                        clientId: clientId,
                        threadId: threadId,
                        senderId: userId !== null && userId !== void 0 ? userId : '',
                        senderHandle: null,
                        senderName: null,
                        senderAvatarUrl: null,
                        body: trimmed,
                        deleted: false,
                        createdAt: new Date().toISOString(),
                        editedAt: null,
                        displayBody: trimmed,
                        originalBody: trimmed,
                        originalLanguage: null,
                        translated: false,
                        translationStatus: null,
                        translationLabel: null,
                        canShowOriginal: false,
                        msgType: (_a = opts === null || opts === void 0 ? void 0 : opts.msgType) !== null && _a !== void 0 ? _a : 'text',
                        subtype: (_b = opts === null || opts === void 0 ? void 0 : opts.subtype) !== null && _b !== void 0 ? _b : null,
                        deliveryStatus: 'sending',
                    };
                    sendingRef.current = true;
                    setSending(true);
                    setMessages(function (prev) { return __spreadArray(__spreadArray([], prev, true), [optimistic], false); });
                    return [4 /*yield*/, (0, messaging_1.sendMessage)(threadId, trimmed, __assign(__assign({}, opts), { clientId: clientId }))];
                case 1:
                    res = _c.sent();
                    if (res.ok && res.data) {
                        server_1 = res.data;
                        setMessages(function (prev) {
                            // Replace the optimistic placeholder; drop if the real one already
                            // arrived via realtime/poll to avoid duplicates.
                            var withoutTemp = prev.filter(function (m) { return m.clientId !== clientId; });
                            if (withoutTemp.some(function (m) { return m.id === server_1.id; }))
                                return withoutTemp;
                            return __spreadArray(__spreadArray([], withoutTemp, true), [__assign(__assign({}, server_1), { deliveryStatus: 'sent' })], false);
                        });
                    }
                    else {
                        setMessages(function (prev) {
                            return prev.map(function (m) {
                                return m.clientId === clientId ? __assign(__assign({}, m), { deliveryStatus: 'failed' }) : m;
                            });
                        });
                    }
                    setSending(false);
                    sendingRef.current = false;
                    return [2 /*return*/, res];
            }
        });
    }); }, [threadId]);
    /** Resend a previously-failed optimistic message (matched by its clientId). */
    var retrySend = (0, react_1.useCallback)(function (clientId) { return __awaiter(_this, void 0, void 0, function () {
        var failed, res, server_2;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (!threadId)
                        return [2 /*return*/];
                    failed = messages.find(function (m) { return m.clientId === clientId; });
                    if (!failed || !failed.body)
                        return [2 /*return*/];
                    setMessages(function (prev) {
                        return prev.map(function (m) {
                            return m.clientId === clientId ? __assign(__assign({}, m), { deliveryStatus: 'sending' }) : m;
                        });
                    });
                    return [4 /*yield*/, (0, messaging_1.sendMessage)(threadId, failed.body, {
                            msgType: failed.msgType,
                            subtype: (_a = failed.subtype) !== null && _a !== void 0 ? _a : undefined,
                            clientId: clientId,
                        })];
                case 1:
                    res = _b.sent();
                    if (res.ok && res.data) {
                        server_2 = res.data;
                        setMessages(function (prev) {
                            var withoutTemp = prev.filter(function (m) { return m.clientId !== clientId; });
                            if (withoutTemp.some(function (m) { return m.id === server_2.id; }))
                                return withoutTemp;
                            return __spreadArray(__spreadArray([], withoutTemp, true), [__assign(__assign({}, server_2), { deliveryStatus: 'sent' })], false);
                        });
                    }
                    else {
                        setMessages(function (prev) {
                            return prev.map(function (m) {
                                return m.clientId === clientId ? __assign(__assign({}, m), { deliveryStatus: 'failed' }) : m;
                            });
                        });
                    }
                    return [2 /*return*/, res];
            }
        });
    }); }, [threadId, messages]);
    /** Relay a typing indicator, throttled so we send at most one ping / 2 s. */
    var notifyTyping = (0, react_1.useCallback)(function (isTyping) {
        if (!threadId)
            return;
        if (!isTyping) {
            lastTypingSentRef.current = 0;
            void (0, messaging_1.sendTyping)(threadId, false);
            return;
        }
        var now = Date.now();
        if (now - lastTypingSentRef.current < 2000)
            return;
        lastTypingSentRef.current = now;
        void (0, messaging_1.sendTyping)(threadId, true);
    }, [threadId]);
    var retry = (0, react_1.useCallback)(function (messageId) { return __awaiter(_this, void 0, void 0, function () {
        var res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, messaging_1.retryTranslation)(messageId)];
                case 1:
                    res = _a.sent();
                    if (res.ok) {
                        setMessages(function (prev) {
                            return prev.map(function (m) {
                                return m.id === messageId
                                    ? __assign(__assign({}, m), { translationStatus: 'pending', translationLabel: null }) : m;
                            });
                        });
                    }
                    return [2 /*return*/, res];
            }
        });
    }); }, []);
    return {
        messages: messages,
        loading: loading,
        error: error,
        sending: sending,
        typingUserIds: typingUserIds,
        reload: reload,
        send: send,
        retrySend: retrySend,
        notifyTyping: notifyTyping,
        retry: retry,
    };
}
// ── Unread counts (for tab badge) ─────────────────────────────────────────────
function useUnreadCounts() {
    var _this = this;
    var _a = (0, react_1.useState)(0), messages = _a[0], setMessages = _a[1];
    var _b = (0, react_1.useState)(0), notifications = _b[0], setNotifications = _b[1];
    var _c = (0, react_1.useState)(0), meetups = _c[0], setMeetups = _c[1];
    var _d = (0, react_1.useState)(0), newHighlights = _d[0], setNewHighlights = _d[1];
    var appStateRef = (0, react_1.useRef)(react_native_1.AppState.currentState);
    var refresh = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var res;
        var _a, _b, _c, _d;
        return __generator(this, function (_e) {
            switch (_e.label) {
                case 0: return [4 /*yield*/, (0, messaging_1.getUnreadCounts)()];
                case 1:
                    res = _e.sent();
                    if (res.ok && res.data) {
                        setMessages((_a = res.data.messages) !== null && _a !== void 0 ? _a : 0);
                        setNotifications((_b = res.data.notifications) !== null && _b !== void 0 ? _b : 0);
                        setMeetups((_c = res.data.meetups) !== null && _c !== void 0 ? _c : 0);
                        setNewHighlights((_d = res.data.newHighlights) !== null && _d !== void 0 ? _d : 0);
                    }
                    return [2 /*return*/];
            }
        });
    }); }, []);
    (0, react_1.useEffect)(function () {
        refresh();
    }, [refresh]);
    (0, react_1.useEffect)(function () {
        var sub = react_native_1.AppState.addEventListener('change', function (next) {
            appStateRef.current = next;
            if (next === 'active')
                refresh();
        });
        var timer = setInterval(function () {
            if (appStateRef.current === 'active')
                refresh();
        }, UNREAD_POLL_MS);
        return function () {
            sub.remove();
            clearInterval(timer);
        };
    }, [refresh]);
    return { messages: messages, notifications: notifications, meetups: meetups, newHighlights: newHighlights, refresh: refresh };
}
// ── Language settings ─────────────────────────────────────────────────────────
function useLanguageSettings() {
    var _this = this;
    var _a = (0, react_1.useState)(null), data = _a[0], setData = _a[1];
    var _b = (0, react_1.useState)(true), loading = _b[0], setLoading = _b[1];
    var _c = (0, react_1.useState)(null), error = _c[0], setError = _c[1];
    var reload = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var res;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    setLoading(true);
                    setError(null);
                    return [4 /*yield*/, (0, messaging_1.getMyLanguageSettings)()];
                case 1:
                    res = _b.sent();
                    if (res.ok && res.data)
                        setData(res.data);
                    else
                        setError((_a = res.message) !== null && _a !== void 0 ? _a : 'Failed to load language settings');
                    setLoading(false);
                    return [2 /*return*/];
            }
        });
    }); }, []);
    (0, react_1.useEffect)(function () {
        reload();
    }, [reload]);
    var update = (0, react_1.useCallback)(function (patch) { return __awaiter(_this, void 0, void 0, function () {
        var res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, messaging_1.updateMyLanguageSettings)(patch)];
                case 1:
                    res = _a.sent();
                    if (res.ok && res.data)
                        setData(res.data);
                    return [2 /*return*/, res];
            }
        });
    }); }, []);
    return { data: data, loading: loading, error: error, reload: reload, update: update };
}
