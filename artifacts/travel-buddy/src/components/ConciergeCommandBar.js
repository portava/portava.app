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
exports.ConciergeCommandBar = void 0;
/**
 * ConciergeCommandBar — "Ask Telegraph" input + prompt chips + response cards.
 *
 * Appears on Trip Detail and Trip Plan pages.
 * Responses appear as AI cards. Add-to-Plan and Create-Meetup actions open
 * bottom-sheet confirmation dialogs before executing.
 * Auth token is obtained internally by the intelligence service.
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../theme/tokens");
var intelligence_1 = require("../services/intelligence");
var PROMPT_CHIPS = [
    'Plan tonight',
    'Fill free time',
    'Find food',
    'Find nightlife',
    'Create meetup',
    'Fix conflicts',
    'Add to plan',
    "What's missing?",
];
exports.ConciergeCommandBar = (0, react_1.forwardRef)(function ConciergeCommandBar(_a, ref) {
    var _b;
    var tripId = _a.tripId, destination = _a.destination, _c = _a.compact, _compact = _c === void 0 ? false : _c;
    var _d = (0, expo_router_1.useLocalSearchParams)(), telegraphPrompt = _d.telegraphPrompt, telegraphMeetupId = _d.telegraphMeetupId, telegraphMeetupTime = _d.telegraphMeetupTime, telegraphMeetupLocation = _d.telegraphMeetupLocation;
    var _e = (0, react_1.useState)(''), text = _e[0], setText = _e[1];
    var _f = (0, react_1.useState)(false), loading = _f[0], setLoading = _f[1];
    var _g = (0, react_1.useState)(null), response = _g[0], setResponse = _g[1];
    var _h = (0, react_1.useState)(null), error = _h[0], setError = _h[1];
    var _j = (0, react_1.useState)(true), expanded = _j[0], setExpanded = _j[1];
    var _k = (0, react_1.useState)(null), confirmAction = _k[0], setConfirmAction = _k[1];
    var _l = (0, react_1.useState)(false), confirming = _l[0], setConfirming = _l[1];
    var inputRef = (0, react_1.useRef)(null);
    var lastHandledPrompt = (0, react_1.useRef)(undefined);
    (0, react_1.useImperativeHandle)(ref, function () { return ({
        focus: function () { var _a; (_a = inputRef.current) === null || _a === void 0 ? void 0 : _a.focus(); },
    }); });
    // Pre-fill + auto-submit when navigated here with ?telegraphPrompt=...
    // Tracks the last-processed value so different chips can each trigger a submit.
    // (e.g. from DailyBriefCard quick-action "Fill free time" or "Find dinner nearby" tap)
    (0, react_1.useEffect)(function () {
        if (telegraphPrompt && telegraphPrompt !== lastHandledPrompt.current) {
            lastHandledPrompt.current = telegraphPrompt;
            var decoded = decodeURIComponent(telegraphPrompt);
            // Pass structured meetup context if present (forwarded from "Find dinner nearby" quick action)
            var meetupOpts = telegraphMeetupId
                ? {
                    meetupId: telegraphMeetupId,
                    meetupTime: telegraphMeetupTime,
                    meetupLocation: telegraphMeetupLocation,
                }
                : undefined;
            submit(decoded, meetupOpts);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [telegraphPrompt]);
    function submit(query, meetupOpts) {
        return __awaiter(this, void 0, void 0, function () {
            var res;
            var _a, _b;
            return __generator(this, function (_c) {
                switch (_c.label) {
                    case 0:
                        if (!query.trim() || loading)
                            return [2 /*return*/];
                        setLoading(true);
                        setError(null);
                        setResponse(null);
                        setText('');
                        (_a = inputRef.current) === null || _a === void 0 ? void 0 : _a.blur();
                        return [4 /*yield*/, (0, intelligence_1.sendConciergeCommand)(query.trim(), __assign({ tripId: tripId, destination: destination }, meetupOpts))];
                    case 1:
                        res = _c.sent();
                        setLoading(false);
                        if (!res.ok || !res.data) {
                            setError((_b = res.error) !== null && _b !== void 0 ? _b : 'Telegraph is unavailable. Please try again.');
                            return [2 /*return*/];
                        }
                        setResponse(res.data);
                        setExpanded(true);
                        return [2 /*return*/];
                }
            });
        });
    }
    function handleActionTap(action) {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!response)
                            return [2 /*return*/];
                        if (!action.requires_confirmation) return [3 /*break*/, 1];
                        setConfirmAction({ commandId: response.commandId, action: action });
                        return [3 /*break*/, 3];
                    case 1: return [4 /*yield*/, doConfirm(response.commandId, action)];
                    case 2:
                        _a.sent();
                        _a.label = 3;
                    case 3: return [2 /*return*/];
                }
            });
        });
    }
    function doConfirm(commandId, action) {
        return __awaiter(this, void 0, void 0, function () {
            var res;
            var _a, _b;
            return __generator(this, function (_c) {
                switch (_c.label) {
                    case 0:
                        setConfirming(true);
                        setConfirmAction(null);
                        return [4 /*yield*/, (0, intelligence_1.confirmCommandAction)(commandId, action.id)];
                    case 1:
                        res = _c.sent();
                        setConfirming(false);
                        if (res.ok) {
                            react_native_1.Alert.alert('Done', (_b = (_a = res.data) === null || _a === void 0 ? void 0 : _a.message) !== null && _b !== void 0 ? _b : "".concat(action.label, " confirmed."));
                        }
                        else {
                            react_native_1.Alert.alert('Error', 'Could not complete that action. You may not have permission.');
                        }
                        return [2 /*return*/];
                }
            });
        });
    }
    function handleDecline() {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!response)
                            return [2 /*return*/];
                        return [4 /*yield*/, (0, intelligence_1.declineCommandAction)(response.commandId)];
                    case 1:
                        _a.sent();
                        setConfirmAction(null);
                        return [2 /*return*/];
                }
            });
        });
    }
    return (<react_native_1.KeyboardAvoidingView behavior={react_native_1.Platform.OS === 'ios' ? 'padding' : undefined}>
      <react_native_1.View style={s.wrap}>
        {/* Header */}
        <react_native_1.View style={s.header}>
          <react_native_1.View style={s.icon}><lucide_react_native_1.Zap size={12} color={tokens_1.color.signal} fill={tokens_1.color.signal}/></react_native_1.View>
          <react_native_1.Text style={s.title}>Ask Telegraph</react_native_1.Text>
          {response && (<react_native_1.Pressable onPress={function () { return setExpanded(function (e) { return !e; }); }} hitSlop={8}>
              {expanded ? <lucide_react_native_1.ChevronUp size={15} color={tokens_1.color.mute}/> : <lucide_react_native_1.ChevronDown size={15} color={tokens_1.color.mute}/>}
            </react_native_1.Pressable>)}
        </react_native_1.View>

        {/* Input row */}
        <react_native_1.View style={s.inputRow}>
          <react_native_1.TextInput ref={inputRef} style={s.input} value={text} onChangeText={setText} placeholder="Plan tonight, find food, fill free time…" placeholderTextColor={tokens_1.color.faint} onSubmitEditing={function () { return submit(text); }} returnKeyType="send" maxLength={500} multiline={false}/>
          <react_native_1.Pressable style={[s.sendBtn, (!text.trim() || loading) && { opacity: 0.4 }]} onPress={function () { return submit(text); }} disabled={!text.trim() || loading} hitSlop={6}>
            {loading ? <react_native_1.ActivityIndicator size="small" color={tokens_1.color.onInk}/> : <lucide_react_native_1.Send size={14} color={tokens_1.color.onInk}/>}
          </react_native_1.Pressable>
        </react_native_1.View>

        {/* Prompt chips */}
        {!response && !loading && (<react_native_1.ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chipRow}>
            {PROMPT_CHIPS.map(function (chip) { return (<react_native_1.Pressable key={chip} style={s.chip} onPress={function () { return submit(chip); }}>
                <react_native_1.Text style={s.chipText}>{chip}</react_native_1.Text>
              </react_native_1.Pressable>); })}
          </react_native_1.ScrollView>)}

        {/* Error state */}
        {error && !loading && (<react_native_1.View style={s.errorBox}>
            <react_native_1.Text style={s.errorText}>{error}</react_native_1.Text>
            <react_native_1.Pressable onPress={function () { return setError(null); }}><react_native_1.Text style={s.retryText}>Dismiss</react_native_1.Text></react_native_1.Pressable>
          </react_native_1.View>)}

        {/* Loading */}
        {loading && (<react_native_1.View style={s.loadBox}>
            <react_native_1.ActivityIndicator size="small" color={tokens_1.color.signal}/>
            <react_native_1.Text style={s.loadText}>Telegraph is thinking…</react_native_1.Text>
          </react_native_1.View>)}

        {/* Response card */}
        {response && expanded && !loading && (<ResponseCard response={response} onActionTap={handleActionTap} onDismiss={function () { return setResponse(null); }} confirming={confirming}/>)}
      </react_native_1.View>

      {/* Confirmation bottom sheet */}
      <ConfirmationSheet visible={!!confirmAction} action={(_b = confirmAction === null || confirmAction === void 0 ? void 0 : confirmAction.action) !== null && _b !== void 0 ? _b : null} onConfirm={function () { return confirmAction && doConfirm(confirmAction.commandId, confirmAction.action); }} onDecline={handleDecline}/>
    </react_native_1.KeyboardAvoidingView>);
});
function ResponseCard(_a) {
    var response = _a.response, onActionTap = _a.onActionTap, onDismiss = _a.onDismiss, confirming = _a.confirming;
    return (<react_native_1.View style={rc.wrap}>
      <react_native_1.View style={rc.aiLabel}>
        <lucide_react_native_1.Sparkles size={10} color={tokens_1.color.signal}/>
        <react_native_1.Text style={rc.aiText}>Telegraph</react_native_1.Text>
      </react_native_1.View>
      <react_native_1.Text style={rc.summary}>{response.summary}</react_native_1.Text>

      {response.suggestions.length > 0 && (<react_native_1.View style={rc.sugList}>
          {response.suggestions.map(function (sg, i) { return (<react_native_1.View key={i} style={rc.sugRow}>
              <react_native_1.View style={rc.sugDot}/>
              <react_native_1.View style={{ flex: 1 }}>
                <react_native_1.Text style={rc.sugTitle} numberOfLines={1}>{sg.title}</react_native_1.Text>
                <react_native_1.Text style={rc.sugReason} numberOfLines={2}>{sg.reason}</react_native_1.Text>
                <react_native_1.Text style={rc.sugMeta}>{sg.estimatedTime} · {sg.priceLevel}</react_native_1.Text>
              </react_native_1.View>
            </react_native_1.View>); })}
        </react_native_1.View>)}

      {response.proposedActions.length > 0 && (<react_native_1.View style={rc.actionRow}>
          {response.proposedActions.map(function (a) { return (<react_native_1.Pressable key={a.id} style={[rc.actionBtn, confirming && { opacity: 0.5 }]} onPress={function () { return onActionTap(a); }} disabled={confirming}>
              {confirming ? <react_native_1.ActivityIndicator size="small" color={tokens_1.color.signal}/> : <react_native_1.Text style={rc.actionText}>{a.label}</react_native_1.Text>}
            </react_native_1.Pressable>); })}
        </react_native_1.View>)}

      <react_native_1.Pressable style={rc.dismiss} onPress={onDismiss} hitSlop={8}>
        <react_native_1.Text style={rc.dismissText}>Dismiss</react_native_1.Text>
      </react_native_1.Pressable>
    </react_native_1.View>);
}
function ConfirmationSheet(_a) {
    var visible = _a.visible, action = _a.action, onConfirm = _a.onConfirm, onDecline = _a.onDecline;
    if (!action)
        return null;
    return (<react_native_1.Modal visible={visible} transparent animationType="slide" onRequestClose={onDecline}>
      <react_native_1.Pressable style={cs.overlay} onPress={onDecline}>
        <react_native_1.View style={cs.sheet}>
          <react_native_1.View style={cs.handle}/>
          <react_native_1.Text style={cs.title}>Confirm action</react_native_1.Text>
          <react_native_1.Text style={cs.body}>{action.label}</react_native_1.Text>
          <react_native_1.Text style={cs.sub}>This will make changes to your trip plan. Review before confirming.</react_native_1.Text>
          <react_native_1.View style={cs.btnRow}>
            <react_native_1.Pressable style={cs.cancelBtn} onPress={onDecline}><react_native_1.Text style={cs.cancelText}>Cancel</react_native_1.Text></react_native_1.Pressable>
            <react_native_1.Pressable style={cs.confirmBtn} onPress={onConfirm}>
              <lucide_react_native_1.CheckCircle size={14} color={tokens_1.color.onInk}/>
              <react_native_1.Text style={cs.confirmText}>Confirm</react_native_1.Text>
            </react_native_1.Pressable>
          </react_native_1.View>
        </react_native_1.View>
      </react_native_1.Pressable>
    </react_native_1.Modal>);
}
var s = react_native_1.StyleSheet.create({
    wrap: { backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, marginHorizontal: tokens_1.space.lg, marginTop: tokens_1.space.xl, overflow: 'hidden' },
    header: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm, paddingHorizontal: tokens_1.space.lg, paddingTop: tokens_1.space.lg, paddingBottom: tokens_1.space.sm },
    icon: { width: 22, height: 22, borderRadius: 11, backgroundColor: '#FFF0EE', alignItems: 'center', justifyContent: 'center' },
    title: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 13, flex: 1 }),
    inputRow: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm, paddingHorizontal: tokens_1.space.lg, paddingBottom: tokens_1.space.sm },
    input: __assign(__assign({ flex: 1, backgroundColor: tokens_1.color.paper, borderRadius: tokens_1.radius.pill, borderWidth: 1, borderColor: tokens_1.color.haze, paddingHorizontal: tokens_1.space.md, paddingVertical: 9 }, tokens_1.type.body), { color: tokens_1.color.ink, fontSize: 13 }),
    sendBtn: { width: 34, height: 34, borderRadius: 17, backgroundColor: tokens_1.color.signal, alignItems: 'center', justifyContent: 'center' },
    chipRow: { paddingHorizontal: tokens_1.space.lg, gap: tokens_1.space.sm, paddingBottom: tokens_1.space.md },
    chip: { paddingHorizontal: tokens_1.space.md, paddingVertical: 6, borderRadius: tokens_1.radius.pill, backgroundColor: tokens_1.color.paper, borderWidth: 1, borderColor: tokens_1.color.haze },
    chipText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.ink, fontSize: 12, fontWeight: '600' }),
    errorBox: { margin: tokens_1.space.lg, backgroundColor: '#FFF0EE', borderRadius: tokens_1.radius.sm, padding: tokens_1.space.md, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    errorText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, flex: 1, fontSize: 12 }),
    retryText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, fontWeight: '700' }),
    loadBox: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm, padding: tokens_1.space.lg, paddingTop: 0 },
    loadText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 12 }),
});
var rc = react_native_1.StyleSheet.create({
    wrap: { margin: tokens_1.space.lg, marginTop: 0, backgroundColor: tokens_1.color.paper, borderRadius: tokens_1.radius.sm, borderWidth: 1, borderColor: tokens_1.color.haze, padding: tokens_1.space.md },
    aiLabel: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: tokens_1.space.sm },
    aiText: __assign(__assign({}, tokens_1.type.stamp), { fontFamily: 'Courier', color: tokens_1.color.signal, fontSize: 10, letterSpacing: 0.8, fontWeight: '700' }),
    summary: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, fontSize: 13, lineHeight: 19, marginBottom: tokens_1.space.md }),
    sugList: { gap: 0 },
    sugRow: { flexDirection: 'row', gap: tokens_1.space.sm, paddingVertical: 6, borderTopWidth: 1, borderTopColor: tokens_1.color.haze },
    sugDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: tokens_1.color.signal, marginTop: 6 },
    sugTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 13 }),
    sugReason: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11, lineHeight: 16 }),
    sugMeta: __assign(__assign({}, tokens_1.type.stamp), { fontFamily: 'Courier', color: tokens_1.color.faint, fontSize: 10 }),
    actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: tokens_1.space.sm, marginTop: tokens_1.space.md },
    actionBtn: { paddingHorizontal: tokens_1.space.md, paddingVertical: 7, borderRadius: tokens_1.radius.pill, borderWidth: 1.5, borderColor: tokens_1.color.signal, backgroundColor: '#FFF0EE', flexDirection: 'row', alignItems: 'center', gap: 4 },
    actionText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, fontWeight: '700', fontSize: 12 }),
    dismiss: { alignSelf: 'flex-end', marginTop: tokens_1.space.sm },
    dismissText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.faint, fontSize: 11 }),
});
var cs = react_native_1.StyleSheet.create({
    overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
    sheet: { backgroundColor: tokens_1.color.paperRaised, borderTopLeftRadius: tokens_1.radius.lg, borderTopRightRadius: tokens_1.radius.lg, padding: tokens_1.space.xl, paddingBottom: tokens_1.space.xxxl, gap: tokens_1.space.md },
    handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: tokens_1.color.haze, alignSelf: 'center', marginBottom: tokens_1.space.sm },
    title: __assign(__assign({}, tokens_1.type.title), { color: tokens_1.color.ink, fontSize: 18 }),
    body: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink }),
    sub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, lineHeight: 18 }),
    btnRow: { flexDirection: 'row', gap: tokens_1.space.md, marginTop: tokens_1.space.sm },
    cancelBtn: { flex: 1, paddingVertical: tokens_1.space.md, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, alignItems: 'center' },
    cancelText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, fontWeight: '600' }),
    confirmBtn: { flex: 1, paddingVertical: tokens_1.space.md, borderRadius: tokens_1.radius.md, backgroundColor: tokens_1.color.signal, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: tokens_1.space.sm },
    confirmText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.onInk, fontWeight: '700' }),
});
