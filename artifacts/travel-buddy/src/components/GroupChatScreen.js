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
exports.GroupChatScreen = GroupChatScreen;
/**
 * GroupChatScreen — reusable group chat UI for trip and circle contexts.
 *
 * Handles all 5 states:
 *   loading, empty, no-access (removed), pending-invite, error
 *
 * Features: day dividers, system-event pills, long-press action sheet,
 * read receipts, rich header with type badge + action icons,
 * updated composer with Discovery / AI stub icons.
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var async_storage_1 = require("@react-native-async-storage/async-storage");
var expo_router_1 = require("expo-router");
var lucide_react_native_1 = require("lucide-react-native");
var react_native_safe_area_context_1 = require("react-native-safe-area-context");
var useGroupChat_1 = require("../hooks/useGroupChat");
var SessionContext_1 = require("../context/SessionContext");
var tokens_1 = require("../theme/tokens");
var TelegraphSystemNotice_1 = require("./TelegraphSystemNotice");
var TranslationSettingsSheet_1 = require("./TranslationSettingsSheet");
var TripMembersSheet_1 = require("./TripMembersSheet");
var messaging_1 = require("../services/messaging");
var friends_1 = require("../services/friends");
var Haptics = require("expo-haptics");
var Clipboard = require("expo-clipboard");
function formatTime(iso) {
    return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
function formatDayLabel(isoDay) {
    var today = new Date().toISOString().slice(0, 10);
    var yest = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    if (isoDay === today)
        return 'Today';
    if (isoDay === yest)
        return 'Yesterday';
    return new Date(isoDay + 'T12:00:00').toLocaleDateString(undefined, {
        weekday: 'long', month: 'long', day: 'numeric',
    });
}
function DayDivider(_a) {
    var label = _a.label;
    return (<react_native_1.View style={dd.wrap}>
      <react_native_1.View style={dd.line}/>
      <react_native_1.Text style={dd.label}>{label}</react_native_1.Text>
      <react_native_1.View style={dd.line}/>
    </react_native_1.View>);
}
var dd = react_native_1.StyleSheet.create({
    wrap: { flexDirection: 'row', alignItems: 'center', marginVertical: 12, paddingHorizontal: 4 },
    line: { flex: 1, height: react_native_1.StyleSheet.hairlineWidth, backgroundColor: tokens_1.color.haze },
    label: __assign(__assign({}, tokens_1.type.stamp), { fontFamily: 'Courier', fontSize: 10, color: tokens_1.color.mute, paddingHorizontal: 10, letterSpacing: 0.5 }),
});
function LongPressActionSheet(_a) {
    var _this = this;
    var _b, _c;
    var message = _a.message, mine = _a.mine, onClose = _a.onClose, onDeleteForMe = _a.onDeleteForMe;
    if (!message)
        return null;
    var text = (_c = (_b = message.displayBody) !== null && _b !== void 0 ? _b : message.body) !== null && _c !== void 0 ? _c : '';
    var actions = [
        ['reply', 'Reply', lucide_react_native_1.Reply],
        ['copy', 'Copy text', lucide_react_native_1.Copy],
        ['translate', 'Translate', lucide_react_native_1.Languages],
        ['save', 'Save message', lucide_react_native_1.BookmarkPlus],
        ['report', 'Report', lucide_react_native_1.Flag],
    ];
    return (<react_native_1.Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <react_native_1.Pressable style={las.overlay} onPress={onClose}/>
      <react_native_1.View style={las.sheet}>
        <react_native_1.View style={las.handle}/>
        {text.length > 0 && (<react_native_1.Text style={las.preview} numberOfLines={2}>{text}</react_native_1.Text>)}
        {actions.map(function (_a) {
            var key = _a[0], label = _a[1], Icon = _a[2];
            return (<react_native_1.Pressable key={key} style={las.row} onPress={function () { return __awaiter(_this, void 0, void 0, function () {
                    return __generator(this, function (_a) {
                        switch (_a.label) {
                            case 0:
                                onClose();
                                if (!(key === 'copy')) return [3 /*break*/, 2];
                                return [4 /*yield*/, Clipboard.setStringAsync(text)];
                            case 1:
                                _a.sent();
                                react_native_1.Alert.alert('Copied', 'Message copied to clipboard.');
                                return [3 /*break*/, 3];
                            case 2:
                                if (key === 'report') {
                                    react_native_1.Alert.alert('Report message', 'Are you sure you want to report this message?', [
                                        { text: 'Cancel', style: 'cancel' },
                                        { text: 'Report', style: 'destructive', onPress: function () { } },
                                    ]);
                                }
                                else {
                                    react_native_1.Alert.alert(label, 'This feature is coming soon.');
                                }
                                _a.label = 3;
                            case 3: return [2 /*return*/];
                        }
                    });
                }); }}>
            <Icon size={18} color={tokens_1.color.ink}/>
            <react_native_1.Text style={las.rowLabel}>{label}</react_native_1.Text>
          </react_native_1.Pressable>);
        })}
        {mine && (<react_native_1.Pressable style={las.row} onPress={function () {
                onClose();
                react_native_1.Alert.alert('Delete message', 'Remove this message for you? Others will still see it.', [
                    { text: 'Cancel', style: 'cancel' },
                    {
                        text: 'Delete',
                        style: 'destructive',
                        onPress: function () { return onDeleteForMe(message.id); },
                    },
                ]);
            }}>
            <lucide_react_native_1.Trash2 size={18} color="#EF4444"/>
            <react_native_1.Text style={[las.rowLabel, { color: '#EF4444' }]}>Delete for me</react_native_1.Text>
          </react_native_1.Pressable>)}
      </react_native_1.View>
    </react_native_1.Modal>);
}
var las = react_native_1.StyleSheet.create({
    overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
    sheet: {
        backgroundColor: tokens_1.color.paperRaised,
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        paddingHorizontal: tokens_1.space.lg,
        paddingBottom: 34,
        paddingTop: tokens_1.space.sm,
    },
    handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: tokens_1.color.haze, alignSelf: 'center', marginBottom: tokens_1.space.md },
    preview: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 12, marginBottom: tokens_1.space.sm, fontStyle: 'italic' }),
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.md,
        paddingVertical: 14,
        borderTopWidth: react_native_1.StyleSheet.hairlineWidth,
        borderTopColor: tokens_1.color.haze,
    },
    rowLabel: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink }),
});
function GroupMessageBubble(_a) {
    var _b, _c, _d, _e;
    var item = _a.item, mine = _a.mine, onLongPress = _a.onLongPress, receiptState = _a.receiptState, autoTranslate = _a.autoTranslate, defaultShowOriginal = _a.defaultShowOriginal, deliveryStatus = _a.deliveryStatus, onRetry = _a.onRetry;
    var _f = (0, react_1.useState)(defaultShowOriginal || !autoTranslate), showOriginal = _f[0], setShowOriginal = _f[1];
    if (item.deleted) {
        return (<react_native_1.Pressable style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleOther]} onLongPress={onLongPress} delayLongPress={300}>
        <react_native_1.Text style={[styles.bubbleText, { fontStyle: 'italic', color: mine ? tokens_1.color.onInk + 'AA' : tokens_1.color.mute }]}>
          This message was deleted.
        </react_native_1.Text>
      </react_native_1.Pressable>);
    }
    // Choose which body to display based on translation settings
    var bodyToShow;
    if (mine || !autoTranslate || showOriginal) {
        bodyToShow = (_c = (_b = item.originalBody) !== null && _b !== void 0 ? _b : item.body) !== null && _c !== void 0 ? _c : '';
    }
    else {
        bodyToShow = (_e = (_d = item.displayBody) !== null && _d !== void 0 ? _d : item.body) !== null && _e !== void 0 ? _e : '';
    }
    var isTranslated = !mine && item.translated && autoTranslate && !showOriginal;
    var isPending = !mine && item.translationStatus === 'pending';
    var isTranslationFailed = !mine && item.translationStatus === 'failed' && autoTranslate;
    var showLabel = !mine && (isPending ||
        (isTranslated && !!item.translationLabel) ||
        !!item.canShowOriginal);
    return (<react_native_1.View>
      {!mine && item.senderName ? (<react_native_1.Text style={styles.senderName}>{item.senderName}</react_native_1.Text>) : null}
      <react_native_1.Pressable style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleOther]} onLongPress={onLongPress} delayLongPress={300}>
        <react_native_1.Text style={[styles.bubbleText, mine && styles.bubbleTextMine]}>{bodyToShow}</react_native_1.Text>
        <react_native_1.Text style={[styles.bubbleTime, mine && styles.bubbleTimeMine]}>
          {formatTime(item.createdAt)}
          {item.editedAt ? '  ·  edited' : ''}
        </react_native_1.Text>

        {/* Translation label + original/translated toggle */}
        {showLabel && (<react_native_1.View style={styles.translationRow}>
            {isPending ? (<react_native_1.Text style={styles.transLabel}>Translating…</react_native_1.Text>) : isTranslated && item.translationLabel ? (<react_native_1.Text style={styles.transLabel}>{item.translationLabel}</react_native_1.Text>) : null}
            {item.canShowOriginal && autoTranslate && (<react_native_1.Pressable onPress={function () { return setShowOriginal(function (v) { return !v; }); }} hitSlop={8}>
                <react_native_1.Text style={styles.transToggle}>
                  {showOriginal ? 'Show translation' : 'Show original'}
                </react_native_1.Text>
              </react_native_1.Pressable>)}
          </react_native_1.View>)}

        {/* Translation unavailable */}
        {isTranslationFailed && (<react_native_1.Text style={styles.transUnavailable}>Translation unavailable.</react_native_1.Text>)}
      </react_native_1.Pressable>
      {/* Delivery status — sending / sent / failed (tap-to-retry) */}
      {mine && deliveryStatus === 'sending' && (<react_native_1.View style={styles.deliveryRow}>
          <lucide_react_native_1.Clock size={11} color={tokens_1.color.mute}/>
          <react_native_1.Text style={styles.deliverySending}>Sending…</react_native_1.Text>
        </react_native_1.View>)}
      {mine && deliveryStatus === 'sent' && !receiptState && (<react_native_1.View style={styles.deliveryRow}>
          <lucide_react_native_1.Check size={11} color={tokens_1.color.signal}/>
          <react_native_1.Text style={styles.deliverySent}>Sent</react_native_1.Text>
        </react_native_1.View>)}
      {mine && deliveryStatus === 'failed' && (<react_native_1.Pressable style={styles.deliveryRow} onPress={onRetry} hitSlop={8}>
          <lucide_react_native_1.AlertCircle size={11} color="#EF4444"/>
          <react_native_1.Text style={styles.deliveryFailed}>Tap to retry</react_native_1.Text>
        </react_native_1.Pressable>)}

      {/* Read receipt — shown on the last confirmed own message only */}
      {mine && receiptState && deliveryStatus !== 'sending' && deliveryStatus !== 'failed' && (<react_native_1.View style={styles.receiptRow}>
          {receiptState === 'read' ? (<>
              <lucide_react_native_1.CheckCheck size={11} color={tokens_1.color.signal}/>
              <react_native_1.Text style={styles.receiptSent}>Read</react_native_1.Text>
            </>) : receiptState === 'delivered' ? (<>
              <lucide_react_native_1.CheckCheck size={11} color={tokens_1.color.mute}/>
              <react_native_1.Text style={[styles.receiptSent, { color: tokens_1.color.mute }]}>Delivered</react_native_1.Text>
            </>) : (<>
              <lucide_react_native_1.Check size={11} color={tokens_1.color.signal}/>
              <react_native_1.Text style={styles.receiptSent}>Sent</react_native_1.Text>
            </>)}
        </react_native_1.View>)}
    </react_native_1.View>);
}
function GroupChatScreen(_a) {
    var _this = this;
    var _b, _c;
    var type = _a.type, id = _a.id, title = _a.title, memberLabel = _a.memberLabel;
    var insets = (0, react_native_safe_area_context_1.useSafeAreaInsets)();
    var userId = (0, SessionContext_1.useSession)().userId;
    var _d = (0, useGroupChat_1.useGroupChat)(type, id), state = _d.state, thread = _d.thread, messages = _d.messages, sending = _d.sending, errorMessage = _d.errorMessage, reload = _d.reload, send = _d.send, retrySend = _d.retrySend, notifyTyping = _d.notifyTyping, typingUserIds = _d.typingUserIds;
    var _e = (0, react_1.useState)(''), input = _e[0], setInput = _e[1];
    var _f = (0, react_1.useState)(false), sendFailed = _f[0], setSendFailed = _f[1];
    var _g = (0, react_1.useState)(undefined), lastSentText = _g[0], setLastSentText = _g[1];
    var _h = (0, react_1.useState)(null), actionMsg = _h[0], setActionMsg = _h[1];
    var _j = (0, react_1.useState)(false), actionMsgMine = _j[0], setActionMsgMine = _j[1];
    // Per-thread translation settings (AsyncStorage-persisted)
    var _k = (0, react_1.useState)(true), autoTranslate = _k[0], setAutoTranslate = _k[1];
    var _l = (0, react_1.useState)(false), defaultShowOriginal = _l[0], setDefaultShowOriginal = _l[1];
    var _m = (0, react_1.useState)(false), showTranslationSheet = _m[0], setShowTranslationSheet = _m[1];
    var _o = (0, react_1.useState)(false), showMembersSheet = _o[0], setShowMembersSheet = _o[1];
    var _p = (0, react_1.useState)([]), memberPreview = _p[0], setMemberPreview = _p[1];
    var _q = (0, react_1.useState)(null), memberCount = _q[0], setMemberCount = _q[1];
    var listRef = (0, react_1.useRef)(null);
    var displayTitle = (_c = (_b = thread === null || thread === void 0 ? void 0 : thread.title) !== null && _b !== void 0 ? _b : title) !== null && _c !== void 0 ? _c : (type === 'trip' ? 'Trip Chat' : 'Circle Chat');
    var isNoAccess = state === 'no_access' || (thread === null || thread === void 0 ? void 0 : thread.memberAccess) === 'removed';
    (0, react_1.useEffect)(function () {
        var _a;
        if (messages.length > 0) {
            (_a = listRef.current) === null || _a === void 0 ? void 0 : _a.scrollToEnd({ animated: true });
        }
    }, [messages.length]);
    // Load per-thread translation prefs from AsyncStorage
    (0, react_1.useEffect)(function () {
        async_storage_1.default.getItem("thread_translation:".concat(id))
            .then(function (raw) {
            if (!raw)
                return;
            try {
                var parsed = JSON.parse(raw);
                if (typeof parsed.autoTranslate === 'boolean')
                    setAutoTranslate(parsed.autoTranslate);
                if (typeof parsed.showOriginal === 'boolean')
                    setDefaultShowOriginal(parsed.showOriginal);
            }
            catch ( /* ignore corrupt entries */_a) { /* ignore corrupt entries */ }
        })
            .catch(function () { });
    }, [id]);
    function saveTranslationPrefs(at, so) {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, async_storage_1.default.setItem("thread_translation:".concat(id), JSON.stringify({ autoTranslate: at, showOriginal: so }))];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        });
    }
    // Load a small member preview (count + avatar stack) for the header chip.
    // Re-runs after the sheet closes so a fresh invite is reflected immediately.
    (0, react_1.useEffect)(function () {
        if (state !== 'active' || showMembersSheet)
            return;
        var cancelled = false;
        (function () { return __awaiter(_this, void 0, void 0, function () {
            var res, _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        if (!(type === 'trip')) return [3 /*break*/, 2];
                        return [4 /*yield*/, (0, friends_1.getTripMembers)(id)];
                    case 1:
                        _a = _b.sent();
                        return [3 /*break*/, 4];
                    case 2: return [4 /*yield*/, (0, friends_1.getCircleMembers)(id)];
                    case 3:
                        _a = _b.sent();
                        _b.label = 4;
                    case 4:
                        res = _a;
                        if (cancelled || !res.ok || !res.data)
                            return [2 /*return*/];
                        // Backend excludes the caller, so add 1 for the current user.
                        setMemberPreview(res.data.members.slice(0, 3));
                        setMemberCount(res.data.members.length + 1);
                        return [2 /*return*/];
                }
            });
        }); })();
        return function () { cancelled = true; };
    }, [type, id, state, showMembersSheet]);
    var listItems = (0, react_1.useMemo)(function () {
        var items = [];
        var lastDay = '';
        for (var _i = 0, messages_1 = messages; _i < messages_1.length; _i++) {
            var m = messages_1[_i];
            var day = m.createdAt.slice(0, 10);
            if (day !== lastDay) {
                lastDay = day;
                items.push({ _t: 'day', label: formatDayLabel(day), key: "day-".concat(day) });
            }
            items.push({ _t: 'msg', data: m });
        }
        return items;
    }, [messages]);
    var lastOwnMsgId = (0, react_1.useMemo)(function () {
        for (var i = messages.length - 1; i >= 0; i--) {
            if (messages[i].senderId === userId)
                return messages[i].id;
        }
        return null;
    }, [messages, userId]);
    // Compute receipt state: 'sent' while fresh, 'delivered' once confirmed (>3 s)
    var receiptState = (0, react_1.useMemo)(function () {
        if (!lastOwnMsgId)
            return null;
        var lastMsg = messages.find(function (m) { return m.id === lastOwnMsgId; });
        if (!lastMsg)
            return null;
        var ageSecs = (Date.now() - new Date(lastMsg.createdAt).getTime()) / 1000;
        return ageSecs > 3 ? 'delivered' : 'sent';
    }, [lastOwnMsgId, messages]);
    var handleDeleteForMe = (0, react_1.useCallback)(function (msgId) { return __awaiter(_this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, messaging_1.deleteMessage)(msgId)];
                case 1:
                    _a.sent();
                    reload();
                    return [2 /*return*/];
            }
        });
    }); }, [reload]);
    function handleSend() {
        return __awaiter(this, void 0, void 0, function () {
            var text, res;
            var _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        text = input.trim();
                        if (!text || sending || isNoAccess)
                            return [2 /*return*/];
                        notifyTyping(false);
                        setInput('');
                        setLastSentText(text);
                        setSendFailed(false);
                        return [4 /*yield*/, send(text)];
                    case 1:
                        res = _b.sent();
                        if (!(res === null || res === void 0 ? void 0 : res.ok))
                            setSendFailed(true);
                        (_a = listRef.current) === null || _a === void 0 ? void 0 : _a.scrollToEnd({ animated: true });
                        return [2 /*return*/];
                }
            });
        });
    }
    var Header = (<react_native_1.View style={[styles.header, { paddingTop: insets.top + 8 }]}>
      <react_native_1.Pressable style={styles.backBtn} onPress={function () { return expo_router_1.router.back(); }} hitSlop={8}>
        <lucide_react_native_1.ArrowLeft size={20} color={tokens_1.color.ink}/>
      </react_native_1.Pressable>
      <react_native_1.View style={[styles.headerIconBadge, type === 'circle' && { backgroundColor: tokens_1.color.ink }]}>
        {type === 'trip'
            ? <lucide_react_native_1.Globe size={14} color={tokens_1.color.onInk}/>
            : <lucide_react_native_1.Users size={14} color={tokens_1.color.onInk}/>}
      </react_native_1.View>
      <react_native_1.Pressable style={styles.headerMeta} onPress={function () { return setShowMembersSheet(true); }} hitSlop={6}>
        <react_native_1.Text style={styles.headerName} numberOfLines={1}>{displayTitle}</react_native_1.Text>
        <react_native_1.View style={styles.headerTagRow}>
          {memberPreview.length > 0 && (<react_native_1.View style={styles.avatarStack}>
              {memberPreview.map(function (m, i) {
                var _a, _b, _c, _d;
                return (m.avatarUrl ? (<react_native_1.Image key={m.id} source={{ uri: m.avatarUrl }} style={[styles.stackAvatar, i > 0 && styles.stackAvatarOverlap]}/>) : (<react_native_1.View key={m.id} style={[styles.stackAvatar, styles.stackAvatarFallback, i > 0 && styles.stackAvatarOverlap]}>
                    <react_native_1.Text style={styles.stackAvatarInitial}>
                      {((_d = (_b = (_a = m.name) === null || _a === void 0 ? void 0 : _a[0]) !== null && _b !== void 0 ? _b : (_c = m.handle) === null || _c === void 0 ? void 0 : _c[0]) !== null && _d !== void 0 ? _d : '?').toUpperCase()}
                    </react_native_1.Text>
                  </react_native_1.View>));
            })}
            </react_native_1.View>)}
          {memberCount === null && <lucide_react_native_1.Users size={9} color={tokens_1.color.signal}/>}
          <react_native_1.Text style={styles.headerMembersChip}>
            {memberCount !== null
            ? "".concat(memberCount, " ").concat(memberCount === 1 ? 'member' : 'members')
            : (memberLabel !== null && memberLabel !== void 0 ? memberLabel : 'Members')}
          </react_native_1.Text>
        </react_native_1.View>
      </react_native_1.Pressable>
      <react_native_1.View style={styles.headerActions}>
        <react_native_1.Pressable hitSlop={8} style={styles.headerIconBtn} onPress={function () { return react_native_1.Alert.alert('Thread info', 'Members, shared media, and settings — coming soon.'); }}>
          <lucide_react_native_1.Info size={18} color={tokens_1.color.mute}/>
        </react_native_1.Pressable>
        <react_native_1.Pressable hitSlop={8} style={styles.headerIconBtn} onPress={function () { return react_native_1.Alert.alert('Search messages', 'Message search coming soon.'); }}>
          <lucide_react_native_1.Search size={18} color={tokens_1.color.mute}/>
        </react_native_1.Pressable>
        <react_native_1.Pressable hitSlop={8} style={styles.headerIconBtn} onPress={function () { return setShowTranslationSheet(true); }}>
          <lucide_react_native_1.Languages size={18} color={autoTranslate ? tokens_1.color.signal : tokens_1.color.mute}/>
        </react_native_1.Pressable>
        <react_native_1.Pressable hitSlop={8} style={styles.headerIconBtn} onPress={function () { return react_native_1.Alert.alert('Mute thread', 'Mute controls coming soon.'); }}>
          <lucide_react_native_1.VolumeX size={18} color={tokens_1.color.mute}/>
        </react_native_1.Pressable>
      </react_native_1.View>
    </react_native_1.View>);
    if (state === 'loading') {
        return (<react_native_1.View style={styles.screen}>
        {Header}
        <react_native_1.View style={styles.center}>
          <react_native_1.ActivityIndicator color={tokens_1.color.signal}/>
        </react_native_1.View>
      </react_native_1.View>);
    }
    if (state === 'pending_invite') {
        return (<react_native_1.View style={styles.screen}>
        {Header}
        <react_native_1.View style={styles.center}>
          <react_native_1.Text style={styles.stateIcon}>✉️</react_native_1.Text>
          <react_native_1.Text style={styles.stateTitle}>Invite Pending</react_native_1.Text>
          <react_native_1.Text style={styles.stateNote}>Accept the invite to join this chat.</react_native_1.Text>
        </react_native_1.View>
      </react_native_1.View>);
    }
    if (state === 'no_access') {
        return (<react_native_1.View style={styles.screen}>
        {Header}
        <react_native_1.View style={styles.center}>
          <react_native_1.Text style={styles.stateIcon}>🔒</react_native_1.Text>
          <react_native_1.Text style={styles.stateTitle}>No longer a member</react_native_1.Text>
          <react_native_1.Text style={styles.stateNote}>You no longer have access to this chat.</react_native_1.Text>
        </react_native_1.View>
      </react_native_1.View>);
    }
    if (state === 'error') {
        return (<react_native_1.View style={styles.screen}>
        {Header}
        <react_native_1.View style={styles.center}>
          <react_native_1.Text style={styles.stateNote}>{errorMessage !== null && errorMessage !== void 0 ? errorMessage : "Couldn't load chat. Try again."}</react_native_1.Text>
          <react_native_1.Pressable style={styles.retryBtn} onPress={reload}>
            <react_native_1.Text style={styles.retryText}>Try again</react_native_1.Text>
          </react_native_1.Pressable>
        </react_native_1.View>
      </react_native_1.View>);
    }
    return (<react_native_1.KeyboardAvoidingView style={styles.screen} behavior={react_native_1.Platform.OS === 'ios' ? 'padding' : 'height'}>
      {Header}

      {/* Quick-action bar — context-sensitive shortcuts */}
      <react_native_1.View style={styles.quickBar}>
        {type === 'trip' ? (<>
            <react_native_1.Pressable style={styles.quickBtn} onPress={function () { return react_native_1.Alert.alert('View Trip', 'Trip overview — coming soon.'); }}>
              <lucide_react_native_1.Globe size={12} color={tokens_1.color.signal}/>
              <react_native_1.Text style={styles.quickBtnText}>View Trip</react_native_1.Text>
            </react_native_1.Pressable>
            <react_native_1.Pressable style={styles.quickBtn} onPress={function () { return react_native_1.Alert.alert('Add Plan', 'Add a plan item — coming soon.'); }}>
              <lucide_react_native_1.CalendarClock size={12} color={tokens_1.color.signal}/>
              <react_native_1.Text style={styles.quickBtnText}>Add Plan</react_native_1.Text>
            </react_native_1.Pressable>
          </>) : (<>
            <react_native_1.Pressable style={styles.quickBtn} onPress={function () { return react_native_1.Alert.alert('View Circle', 'Circle overview — coming soon.'); }}>
              <lucide_react_native_1.Users size={12} color={tokens_1.color.signal}/>
              <react_native_1.Text style={styles.quickBtnText}>View Circle</react_native_1.Text>
            </react_native_1.Pressable>
            <react_native_1.Pressable style={styles.quickBtn} onPress={function () { return react_native_1.Alert.alert('Share Discovery', 'Share a place from Discovery — coming soon.'); }}>
              <lucide_react_native_1.Compass size={12} color={tokens_1.color.signal}/>
              <react_native_1.Text style={styles.quickBtnText}>Share Discovery</react_native_1.Text>
            </react_native_1.Pressable>
          </>)}
      </react_native_1.View>

      <react_native_1.FlatList ref={listRef} data={listItems} keyExtractor={function (item) { return item._t === 'day' ? item.key : item.data.id; }} contentContainerStyle={styles.list} ListEmptyComponent={<react_native_1.View style={styles.center}>
            <react_native_1.Text style={styles.emptyIcon}>💬</react_native_1.Text>
            <react_native_1.Text style={styles.stateTitle}>Start the conversation</react_native_1.Text>
            <react_native_1.Text style={styles.stateNote}>
              {type === 'trip'
                ? 'Start the trip conversation.'
                : 'Say something to your circle.'}
            </react_native_1.Text>
          </react_native_1.View>} renderItem={function (_a) {
            var _b, _c, _d, _e;
            var item = _a.item;
            if (item._t === 'day') {
                return <DayDivider label={item.label}/>;
            }
            var m = item.data;
            var mine = m.senderId === userId;
            // System-event messages render as centred pill labels
            if (m.msgType === 'system') {
                return <TelegraphSystemNotice_1.TelegraphSystemNotice text={(_b = m.body) !== null && _b !== void 0 ? _b : ''}/>;
            }
            return (<react_native_1.View style={[styles.bubbleRow, mine && styles.bubbleRowMine]}>
              {!mine && (<react_native_1.View style={[styles.avatar, styles.avatarSmall]}>
                  {m.senderAvatarUrl ? (<react_native_1.Image source={{ uri: m.senderAvatarUrl }} style={styles.avatarSmall}/>) : (<react_native_1.Text style={styles.avatarInitial}>
                      {((_d = (_c = m.senderName) === null || _c === void 0 ? void 0 : _c[0]) !== null && _d !== void 0 ? _d : '?').toUpperCase()}
                    </react_native_1.Text>)}
                </react_native_1.View>)}
              <GroupMessageBubble item={m} mine={mine} onLongPress={function () {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                    setActionMsg(m);
                    setActionMsgMine(mine);
                }} receiptState={m.id === lastOwnMsgId ? receiptState : null} autoTranslate={autoTranslate} defaultShowOriginal={defaultShowOriginal} deliveryStatus={mine ? ((_e = m.deliveryStatus) !== null && _e !== void 0 ? _e : null) : null} onRetry={mine && m.clientId ? function () { return retrySend(m.clientId); } : undefined}/>
            </react_native_1.View>);
        }} onLayout={function () { var _a; return (_a = listRef.current) === null || _a === void 0 ? void 0 : _a.scrollToEnd({ animated: false }); }} ItemSeparatorComponent={function () { return <react_native_1.View style={{ height: tokens_1.space.sm }}/>; }}/>

      {/* Typing indicator */}
      {typingUserIds.length > 0 && (<react_native_1.View style={styles.typingRow}>
          <react_native_1.Text style={styles.typingText}>
            {typingUserIds.length === 1
                ? 'Someone is typing…'
                : "".concat(typingUserIds.length, " people are typing\u2026")}
          </react_native_1.Text>
        </react_native_1.View>)}

      {/* Failed-send banner — sits above the composer, offers retry */}
      {sendFailed && lastSentText && (<react_native_1.View style={styles.failedBanner}>
          <lucide_react_native_1.AlertCircle size={14} color="#EF4444"/>
          <react_native_1.Text style={styles.failedBannerText} numberOfLines={1}>
            Failed to send: "{lastSentText}"
          </react_native_1.Text>
          <react_native_1.Pressable style={styles.failedRetryBtn} onPress={function () {
                var text = lastSentText;
                setSendFailed(false);
                setInput(text);
            }}>
            <lucide_react_native_1.RefreshCw size={12} color="#EF4444"/>
            <react_native_1.Text style={styles.failedRetryText}>Retry</react_native_1.Text>
          </react_native_1.Pressable>
        </react_native_1.View>)}

      <react_native_1.View style={[styles.compose, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        {isNoAccess ? (<react_native_1.View style={styles.noAccessBar}>
            <react_native_1.Text style={styles.noAccessText}>You no longer have access to this chat.</react_native_1.Text>
          </react_native_1.View>) : (<>
            <react_native_1.Pressable style={styles.composeIconBtn} onPress={function () { return react_native_1.Alert.alert('Attach', 'File attachments coming soon.'); }} hitSlop={6}>
              <lucide_react_native_1.Paperclip size={18} color={tokens_1.color.mute}/>
            </react_native_1.Pressable>
            <react_native_1.Pressable style={styles.composeIconBtn} onPress={function () { return react_native_1.Alert.alert('Share Discovery', 'Share a place from Discovery — coming soon.'); }} hitSlop={6}>
              <lucide_react_native_1.Compass size={18} color={tokens_1.color.mute}/>
            </react_native_1.Pressable>
            <react_native_1.Pressable style={styles.composeIconBtn} onPress={function () { return react_native_1.Alert.alert('AI Suggestions', 'Compass AI suggestions — coming soon.'); }} hitSlop={6}>
              <lucide_react_native_1.Bot size={18} color={tokens_1.color.mute}/>
            </react_native_1.Pressable>
            <react_native_1.TextInput style={styles.inputField} placeholder="Write a Telegraph…" placeholderTextColor={tokens_1.color.faint} value={input} onChangeText={function (text) { setInput(text); notifyTyping(text.trim().length > 0); }} onBlur={function () { return notifyTyping(false); }} onSubmitEditing={handleSend} returnKeyType="send" editable={!sending} multiline/>
            <react_native_1.Pressable style={[
                styles.sendBtn,
                (input.trim() && !sending) ? styles.sendBtnActive : styles.sendBtnDisabled,
            ]} onPress={handleSend} disabled={!input.trim() || sending}>
              {sending ? (<react_native_1.ActivityIndicator size="small" color={tokens_1.color.onInk}/>) : (<lucide_react_native_1.Send size={16} color={input.trim() ? tokens_1.color.onInk : tokens_1.color.faint}/>)}
            </react_native_1.Pressable>
          </>)}
      </react_native_1.View>

      <LongPressActionSheet message={actionMsg} mine={actionMsgMine} onClose={function () { return setActionMsg(null); }} onDeleteForMe={handleDeleteForMe}/>

      {/* Per-thread translation settings */}
      <TranslationSettingsSheet_1.TranslationSettingsSheet visible={showTranslationSheet} autoTranslate={autoTranslate} showOriginalFirst={defaultShowOriginal} onChangeAutoTranslate={function (v) {
            setAutoTranslate(v);
            saveTranslationPrefs(v, defaultShowOriginal);
        }} onChangeShowOriginalFirst={function (v) {
            setDefaultShowOriginal(v);
            saveTranslationPrefs(autoTranslate, v);
        }} onClose={function () { return setShowTranslationSheet(false); }}/>

      {/* Members list + invite */}
      {showMembersSheet && (<TripMembersSheet_1.TripMembersSheet type={type} id={id} onDismiss={function () { return setShowMembersSheet(false); }}/>)}
    </react_native_1.KeyboardAvoidingView>);
}
var styles = react_native_1.StyleSheet.create({
    screen: { flex: 1, backgroundColor: tokens_1.color.paper },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: tokens_1.space.xl },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.sm,
        paddingHorizontal: tokens_1.space.lg,
        paddingBottom: tokens_1.space.md,
        borderBottomWidth: 1,
        borderBottomColor: tokens_1.color.haze,
        backgroundColor: tokens_1.color.paperRaised,
    },
    backBtn: { padding: 4, flexShrink: 0 },
    headerIconBadge: {
        width: 26,
        height: 26,
        borderRadius: 8,
        backgroundColor: tokens_1.color.signal,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
    },
    headerMeta: { flex: 1, minWidth: 0 },
    headerName: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontWeight: '700' }),
    headerTagRow: { flexDirection: 'row', alignItems: 'center', marginTop: 2, gap: 3 },
    headerTag: __assign(__assign({}, tokens_1.type.stamp), { fontFamily: 'Courier', color: tokens_1.color.mute, fontSize: 10, letterSpacing: 0.4 }),
    headerMembersChip: __assign(__assign({}, tokens_1.type.stamp), { fontFamily: 'Courier', color: tokens_1.color.signal, fontSize: 10, letterSpacing: 0.4 }),
    avatarStack: { flexDirection: 'row', alignItems: 'center', marginRight: 2 },
    stackAvatar: { width: 16, height: 16, borderRadius: 8, borderWidth: 1, borderColor: tokens_1.color.paperRaised },
    stackAvatarOverlap: { marginLeft: -6 },
    stackAvatarFallback: { backgroundColor: tokens_1.color.haze, alignItems: 'center', justifyContent: 'center' },
    stackAvatarInitial: { fontSize: 8, fontWeight: '700', color: tokens_1.color.ink },
    headerActions: { flexDirection: 'row', alignItems: 'center', gap: 2, flexShrink: 0 },
    headerIconBtn: { padding: 5 },
    stateIcon: { fontSize: 36, marginBottom: tokens_1.space.md },
    stateTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, textAlign: 'center', marginBottom: tokens_1.space.sm }),
    stateNote: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute, textAlign: 'center', lineHeight: 20 }),
    retryBtn: {
        marginTop: tokens_1.space.lg,
        paddingHorizontal: tokens_1.space.xl,
        paddingVertical: tokens_1.space.md,
        backgroundColor: tokens_1.color.signal,
        borderRadius: tokens_1.radius.pill,
    },
    retryText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.onInk }),
    emptyIcon: { fontSize: 32, marginBottom: tokens_1.space.md },
    list: { paddingHorizontal: tokens_1.space.lg, paddingVertical: tokens_1.space.md, flexGrow: 1 },
    bubbleRow: { flexDirection: 'row', alignItems: 'flex-end', gap: tokens_1.space.sm, maxWidth: '86%' },
    bubbleRowMine: { alignSelf: 'flex-end', flexDirection: 'row-reverse' },
    avatar: { width: 28, height: 28, borderRadius: 14, backgroundColor: tokens_1.color.haze, overflow: 'hidden', flexShrink: 0 },
    avatarSmall: { width: 28, height: 28, borderRadius: 14 },
    avatarInitial: { fontSize: 12, color: tokens_1.color.ink, textAlign: 'center', lineHeight: 28 },
    bubble: {
        borderRadius: tokens_1.radius.lg,
        paddingHorizontal: tokens_1.space.md,
        paddingTop: tokens_1.space.sm,
        paddingBottom: 6,
        flexShrink: 1,
        maxWidth: '100%',
    },
    bubbleOther: {
        backgroundColor: tokens_1.color.paperRaised,
        borderWidth: 1,
        borderColor: tokens_1.color.haze,
        borderBottomLeftRadius: 4,
    },
    bubbleMine: { backgroundColor: tokens_1.color.signal, borderBottomRightRadius: 4 },
    senderName: __assign(__assign({}, tokens_1.type.stamp), { fontFamily: 'Courier', color: tokens_1.color.mute, fontSize: 10, marginBottom: 2, letterSpacing: 0.2 }),
    bubbleText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, lineHeight: 20, flexShrink: 1, flexWrap: 'wrap' }),
    bubbleTextMine: { color: tokens_1.color.onInk },
    bubbleTime: __assign(__assign({}, tokens_1.type.stamp), { fontFamily: 'Courier', color: tokens_1.color.faint, fontSize: 10, marginTop: 2, textAlign: 'right' }),
    bubbleTimeMine: { color: tokens_1.color.onInk + '88' },
    receiptRow: { flexDirection: 'row', alignItems: 'center', gap: 3, alignSelf: 'flex-end', marginTop: 2, paddingRight: 2 },
    receiptSent: { fontSize: 10, color: tokens_1.color.signal, fontFamily: 'Courier' },
    deliveryRow: { flexDirection: 'row', alignItems: 'center', gap: 3, alignSelf: 'flex-end', marginTop: 2, paddingRight: 2 },
    deliverySending: { fontSize: 10, color: tokens_1.color.mute, fontFamily: 'Courier' },
    deliverySent: { fontSize: 10, color: tokens_1.color.signal, fontFamily: 'Courier' },
    deliveryFailed: { fontSize: 10, color: '#EF4444', fontFamily: 'Courier', fontWeight: '600' },
    typingRow: { paddingHorizontal: tokens_1.space.lg, paddingVertical: 5, backgroundColor: tokens_1.color.paper },
    typingText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11, fontStyle: 'italic' }),
    translationRow: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 6,
        marginTop: 4,
    },
    transLabel: {
        fontSize: 10,
        color: tokens_1.color.mute,
        fontFamily: 'Courier',
        letterSpacing: 0.2,
        flexShrink: 1,
    },
    transToggle: {
        fontSize: 10,
        color: tokens_1.color.signal,
        fontFamily: 'Courier',
        textDecorationLine: 'underline',
    },
    transUnavailable: {
        fontSize: 10,
        color: tokens_1.color.mute,
        fontFamily: 'Courier',
        fontStyle: 'italic',
        letterSpacing: 0.2,
        marginTop: 4,
    },
    compose: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        gap: tokens_1.space.sm,
        paddingHorizontal: tokens_1.space.md,
        paddingTop: tokens_1.space.sm,
        borderTopWidth: 1,
        borderTopColor: tokens_1.color.haze,
        backgroundColor: tokens_1.color.paperRaised,
    },
    composeIconBtn: { width: 32, height: 38, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
    inputField: __assign(__assign({ flex: 1, minHeight: 38, maxHeight: 110, backgroundColor: tokens_1.color.paper, borderRadius: tokens_1.radius.lg, borderWidth: 1, borderColor: tokens_1.color.haze, paddingHorizontal: tokens_1.space.md, paddingVertical: 9 }, tokens_1.type.body), { color: tokens_1.color.ink }),
    sendBtn: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
    sendBtnActive: { backgroundColor: tokens_1.color.signal },
    sendBtnDisabled: { backgroundColor: tokens_1.color.haze },
    noAccessBar: { flex: 1, paddingVertical: tokens_1.space.md, alignItems: 'center' },
    noAccessText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, textAlign: 'center' }),
    quickBar: {
        flexDirection: 'row',
        gap: tokens_1.space.sm,
        paddingHorizontal: tokens_1.space.lg,
        paddingVertical: 8,
        borderBottomWidth: react_native_1.StyleSheet.hairlineWidth,
        borderBottomColor: tokens_1.color.haze,
        backgroundColor: tokens_1.color.paperRaised,
    },
    quickBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: tokens_1.radius.pill,
        borderWidth: 1,
        borderColor: tokens_1.color.signal + '40',
        backgroundColor: tokens_1.color.signal + '0D',
    },
    quickBtnText: __assign(__assign({}, tokens_1.type.stamp), { color: tokens_1.color.signal, fontSize: 11, fontWeight: '600' }),
    failedBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: tokens_1.space.lg,
        paddingVertical: 7,
        backgroundColor: '#FEF2F2',
        borderTopWidth: react_native_1.StyleSheet.hairlineWidth,
        borderTopColor: '#FECACA',
    },
    failedBannerText: __assign(__assign({}, tokens_1.type.small), { color: '#EF4444', flex: 1, fontSize: 11 }),
    failedRetryBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 3,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: tokens_1.radius.pill,
        borderWidth: 1,
        borderColor: '#FECACA',
    },
    failedRetryText: __assign(__assign({}, tokens_1.type.stamp), { color: '#EF4444', fontSize: 10, fontWeight: '600' }),
});
