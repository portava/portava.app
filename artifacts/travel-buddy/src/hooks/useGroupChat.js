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
exports.useGroupChat = useGroupChat;
/**
 * useGroupChat — fetch and send messages in trip or circle group threads.
 *
 * Handles all 5 states:
 *   loading, empty (no messages), no-access (left/removed), pending-invite, error
 *
 * Translation display hook: shows translated body when available;
 * otherwise shows original_body. No-op until Task #7 populates translation rows.
 */
var react_1 = require("react");
var messaging_1 = require("../services/messaging");
var SessionContext_1 = require("../context/SessionContext");
var telegraphRealtimeService_1 = require("../services/telegraphRealtimeService");
function makeClientId() {
    return "client-".concat(Date.now(), "-").concat(Math.random().toString(36).slice(2));
}
var TYPING_TTL_MS = 4000;
function useGroupChat(type, id) {
    var _this = this;
    var _a;
    var userId = (0, SessionContext_1.useSession)().userId;
    var _b = (0, react_1.useState)('loading'), state = _b[0], setState = _b[1];
    var _c = (0, react_1.useState)(null), thread = _c[0], setThread = _c[1];
    var _d = (0, react_1.useState)([]), messages = _d[0], setMessages = _d[1];
    var _e = (0, react_1.useState)(false), sending = _e[0], setSending = _e[1];
    var _f = (0, react_1.useState)(null), errorMessage = _f[0], setErrorMessage = _f[1];
    var _g = (0, react_1.useState)([]), typingUserIds = _g[0], setTypingUserIds = _g[1];
    var threadIdRef = (0, react_1.useRef)(null);
    threadIdRef.current = (_a = thread === null || thread === void 0 ? void 0 : thread.id) !== null && _a !== void 0 ? _a : null;
    var typingTimers = (0, react_1.useRef)(new Map());
    var lastTypingSentRef = (0, react_1.useRef)(0);
    var load = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var res, _a, errMsg, d;
        var _b, _c, _d;
        return __generator(this, function (_e) {
            switch (_e.label) {
                case 0:
                    if (!id)
                        return [2 /*return*/];
                    setState('loading');
                    setErrorMessage(null);
                    if (!(type === 'trip')) return [3 /*break*/, 2];
                    return [4 /*yield*/, (0, messaging_1.getTripChat)(id)];
                case 1:
                    _a = _e.sent();
                    return [3 /*break*/, 4];
                case 2: return [4 /*yield*/, (0, messaging_1.getCircleChat)(id)];
                case 3:
                    _a = _e.sent();
                    _e.label = 4;
                case 4:
                    res = _a;
                    if (!res.ok) {
                        if (res.errorKind === 'forbidden') {
                            errMsg = (_b = res.message) !== null && _b !== void 0 ? _b : '';
                            if (errMsg.includes('pending') || errMsg.includes('invite')) {
                                setState('pending_invite');
                            }
                            else {
                                setState('no_access');
                            }
                            return [2 /*return*/];
                        }
                        setState('error');
                        setErrorMessage((_c = res.message) !== null && _c !== void 0 ? _c : 'Failed to load chat');
                        return [2 /*return*/];
                    }
                    d = res.data;
                    setThread(d.thread);
                    setMessages((_d = d.messages) !== null && _d !== void 0 ? _d : []);
                    if (d.thread.memberAccess === 'removed') {
                        setState('no_access');
                    }
                    else {
                        setState('active');
                    }
                    return [2 /*return*/];
            }
        });
    }); }, [type, id]);
    (0, react_1.useEffect)(function () {
        if (id)
            load();
    }, [load, id]);
    // Silent refetch — merges new/updated messages without flipping to 'loading'.
    var silentRefresh = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var tid, res, incoming;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    tid = threadIdRef.current;
                    if (!tid)
                        return [2 /*return*/];
                    return [4 /*yield*/, (0, messaging_1.getThreadMessages)(tid)];
                case 1:
                    res = _b.sent();
                    if (!res.ok || !res.data)
                        return [2 /*return*/];
                    incoming = (_a = res.data.messages) !== null && _a !== void 0 ? _a : [];
                    setMessages(function (prev) {
                        // Replace any confirmed incoming messages; keep still-pending optimistic ones
                        var confirmedIds = new Set(incoming.map(function (m) { return m.id; }));
                        var byId = new Map();
                        for (var _i = 0, prev_1 = prev; _i < prev_1.length; _i++) {
                            var m = prev_1[_i];
                            // Drop optimistic 'sending'/'failed' messages that were confirmed server-side
                            if (!m.clientId || !confirmedIds.has(m.id))
                                byId.set(m.id, m);
                        }
                        var changed = false;
                        for (var _a = 0, incoming_1 = incoming; _a < incoming_1.length; _a++) {
                            var m = incoming_1[_a];
                            if (!byId.has(m.id))
                                changed = true;
                            byId.set(m.id, m);
                        }
                        if (!changed && byId.size === prev.length)
                            return prev;
                        return Array.from(byId.values()).sort(function (a, b) {
                            return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
                        });
                    });
                    return [2 /*return*/];
            }
        });
    }); }, []);
    // Helper: clear a user from typing list
    var clearTyping = (0, react_1.useCallback)(function (uid) {
        typingTimers.current.delete(uid);
        setTypingUserIds(function (prev) { return prev.filter(function (u) { return u !== uid; }); });
    }, []);
    // Realtime: refresh on message events; handle typing events
    (0, react_1.useEffect)(function () {
        var unsub = telegraphRealtimeService_1.telegraphRealtime.subscribe(function (evt) {
            var _a;
            var tid = threadIdRef.current;
            if (!tid || (evt.threadId && evt.threadId !== tid))
                return;
            if (evt.type === 'message.created' ||
                evt.type === 'message.updated' ||
                evt.type === 'message.translated') {
                void silentRefresh();
                return;
            }
            var uid = (_a = evt.payload) === null || _a === void 0 ? void 0 : _a.userId;
            if (!uid)
                return;
            if (evt.type === 'typing.started') {
                setTypingUserIds(function (prev) { return prev.includes(uid) ? prev : __spreadArray(__spreadArray([], prev, true), [uid], false); });
                var existing = typingTimers.current.get(uid);
                if (existing)
                    clearTimeout(existing);
                typingTimers.current.set(uid, setTimeout(function () { return clearTyping(uid); }, TYPING_TTL_MS));
            }
            else if (evt.type === 'typing.stopped') {
                var t = typingTimers.current.get(uid);
                if (t) {
                    clearTimeout(t);
                    typingTimers.current.delete(uid);
                }
                setTypingUserIds(function (prev) { return prev.filter(function (u) { return u !== uid; }); });
            }
        });
        return function () {
            unsub();
            for (var _i = 0, _a = typingTimers.current.values(); _i < _a.length; _i++) {
                var t = _a[_i];
                clearTimeout(t);
            }
            typingTimers.current.clear();
        };
    }, [silentRefresh, clearTyping]);
    var send = (0, react_1.useCallback)(function (body) { return __awaiter(_this, void 0, void 0, function () {
        var clientId, optimistic, res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (!thread || !body.trim())
                        return [2 /*return*/, { ok: false }];
                    clientId = makeClientId();
                    optimistic = {
                        id: clientId,
                        clientId: clientId,
                        threadId: thread.id,
                        senderId: userId !== null && userId !== void 0 ? userId : '',
                        body: body.trim(),
                        originalBody: body.trim(),
                        displayBody: body.trim(),
                        createdAt: new Date().toISOString(),
                        editedAt: null,
                        deleted: false,
                        msgType: 'text',
                        subtype: null,
                        deliveryStatus: 'sending',
                        translationStatus: null,
                        translationLabel: null,
                        translated: false,
                        canShowOriginal: false,
                        senderName: null,
                        senderHandle: null,
                        senderAvatarUrl: null,
                    };
                    setSending(true);
                    setMessages(function (prev) { return __spreadArray(__spreadArray([], prev, true), [optimistic], false); });
                    return [4 /*yield*/, (0, messaging_1.sendMessage)(thread.id, body.trim(), { clientId: clientId })];
                case 1:
                    res = _a.sent();
                    if (res.ok && res.data) {
                        setMessages(function (prev) {
                            var withoutOptimistic = prev.filter(function (m) { return m.clientId !== clientId; });
                            return __spreadArray(__spreadArray([], withoutOptimistic, true), [__assign(__assign({}, res.data), { deliveryStatus: 'sent' })], false);
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
                    return [2 /*return*/, { ok: res.ok }];
            }
        });
    }); }, [thread]);
    var retrySend = (0, react_1.useCallback)(function (clientId) { return __awaiter(_this, void 0, void 0, function () {
        var failed, res;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    failed = messages.find(function (m) { return m.clientId === clientId; });
                    if (!failed || !thread)
                        return [2 /*return*/];
                    setMessages(function (prev) {
                        return prev.map(function (m) {
                            return m.clientId === clientId ? __assign(__assign({}, m), { deliveryStatus: 'sending' }) : m;
                        });
                    });
                    return [4 /*yield*/, (0, messaging_1.sendMessage)(thread.id, (_a = failed.body) !== null && _a !== void 0 ? _a : '', { clientId: clientId })];
                case 1:
                    res = _b.sent();
                    if (res.ok && res.data) {
                        setMessages(function (prev) {
                            var withoutOptimistic = prev.filter(function (m) { return m.clientId !== clientId; });
                            return __spreadArray(__spreadArray([], withoutOptimistic, true), [__assign(__assign({}, res.data), { deliveryStatus: 'sent' })], false);
                        });
                    }
                    else {
                        setMessages(function (prev) {
                            return prev.map(function (m) {
                                return m.clientId === clientId ? __assign(__assign({}, m), { deliveryStatus: 'failed' }) : m;
                            });
                        });
                    }
                    return [2 /*return*/];
            }
        });
    }); }, [messages, thread]);
    var notifyTyping = (0, react_1.useCallback)(function (isTyping) {
        var tid = threadIdRef.current;
        if (!tid)
            return;
        if (!isTyping) {
            lastTypingSentRef.current = 0;
            void (0, messaging_1.sendTyping)(tid, false);
            return;
        }
        var now = Date.now();
        if (now - lastTypingSentRef.current < 2000)
            return;
        lastTypingSentRef.current = now;
        void (0, messaging_1.sendTyping)(tid, true);
    }, []);
    var edit = (0, react_1.useCallback)(function (messageId, body) { return __awaiter(_this, void 0, void 0, function () {
        var res, updated_1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, messaging_1.editMessage)(messageId, body)];
                case 1:
                    res = _a.sent();
                    if (res.ok && res.data) {
                        updated_1 = res.data;
                        setMessages(function (prev) {
                            return prev.map(function (m) {
                                return m.id === messageId
                                    ? __assign(__assign({}, m), { body: updated_1.body, editedAt: updated_1.editedAt }) : m;
                            });
                        });
                    }
                    return [2 /*return*/];
            }
        });
    }); }, []);
    var remove = (0, react_1.useCallback)(function (messageId) { return __awaiter(_this, void 0, void 0, function () {
        var res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, messaging_1.deleteMessage)(messageId)];
                case 1:
                    res = _a.sent();
                    if (res.ok) {
                        setMessages(function (prev) {
                            return prev.map(function (m) { return (m.id === messageId ? __assign(__assign({}, m), { deleted: true, body: null }) : m); });
                        });
                    }
                    return [2 /*return*/];
            }
        });
    }); }, []);
    var loadMore = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var oldest, res, older_1;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (!thread || messages.length === 0)
                        return [2 /*return*/];
                    oldest = messages[0];
                    return [4 /*yield*/, (0, messaging_1.getThreadMessages)(thread.id, oldest.createdAt)];
                case 1:
                    res = _b.sent();
                    if (res.ok && res.data) {
                        older_1 = __spreadArray([], ((_a = res.data.messages) !== null && _a !== void 0 ? _a : []), true).reverse();
                        setMessages(function (prev) { return __spreadArray(__spreadArray([], older_1, true), prev, true); });
                    }
                    return [2 /*return*/];
            }
        });
    }); }, [thread, messages]);
    return { state: state, thread: thread, messages: messages, sending: sending, errorMessage: errorMessage, typingUserIds: typingUserIds, reload: load, send: send, retrySend: retrySend, notifyTyping: notifyTyping, edit: edit, remove: remove, loadMore: loadMore };
}
