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
exports.ThreadSafetySheet = ThreadSafetySheet;
/**
 * ThreadSafetySheet — safety and privacy controls accessible from the "…" overflow
 * in any Telegraph thread header.
 *
 * Controls:
 *  - Hide AI suggestions toggle (AsyncStorage per-thread)
 *  - Mute notifications toggle (API call)
 *  - Block user (DM only) — destructive
 *  - Report conversation — reason picker
 *  - Leave group (trip/circle only) — destructive
 *  - Delete for me (archive) — destructive
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../theme/tokens");
var REPORT_REASONS = [
    'Spam or advertising',
    'Harassment or bullying',
    'Inappropriate content',
    'Misinformation',
    'Threats or violence',
    'Other',
];
function ReportSheet(_a) {
    var onClose = _a.onClose, onReport = _a.onReport;
    var _b = (0, react_1.useState)(null), selected = _b[0], setSelected = _b[1];
    var _c = (0, react_1.useState)(false), sending = _c[0], setSending = _c[1];
    function handleSubmit() {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!selected)
                            return [2 /*return*/];
                        setSending(true);
                        if (!onReport) return [3 /*break*/, 2];
                        return [4 /*yield*/, onReport(selected).catch(function () { })];
                    case 1:
                        _a.sent();
                        _a.label = 2;
                    case 2:
                        setSending(false);
                        onClose();
                        react_native_1.Alert.alert('Report submitted', 'Thank you. Our team will review this conversation.');
                        return [2 /*return*/];
                }
            });
        });
    }
    return (<react_native_1.View style={rs.wrap}>
      <react_native_1.View style={rs.handle}/>
      <react_native_1.Text style={rs.title}>Report this conversation</react_native_1.Text>
      <react_native_1.Text style={rs.sub}>What's wrong with this conversation?</react_native_1.Text>

      {REPORT_REASONS.map(function (reason) { return (<react_native_1.Pressable key={reason} style={[rs.option, selected === reason && rs.optionSelected]} onPress={function () { return setSelected(reason); }}>
          <react_native_1.Text style={[rs.optionText, selected === reason && rs.optionTextSelected]}>{reason}</react_native_1.Text>
          {selected === reason && <react_native_1.Text style={rs.check}>✓</react_native_1.Text>}
        </react_native_1.Pressable>); })}

      <react_native_1.Pressable style={[rs.submitBtn, (!selected || sending) && rs.submitBtnDisabled]} onPress={handleSubmit} disabled={!selected || sending}>
        {sending ? (<react_native_1.ActivityIndicator size="small" color={tokens_1.color.onInk}/>) : (<react_native_1.Text style={rs.submitLabel}>Submit Report</react_native_1.Text>)}
      </react_native_1.Pressable>
      <react_native_1.Pressable style={rs.cancelBtn} onPress={onClose}>
        <react_native_1.Text style={rs.cancelLabel}>Cancel</react_native_1.Text>
      </react_native_1.Pressable>
    </react_native_1.View>);
}
function ThreadSafetySheet(_a) {
    var visible = _a.visible, onClose = _a.onClose, threadType = _a.threadType, otherUserId = _a.otherUserId, isMuted = _a.isMuted, onToggleMute = _a.onToggleMute, hideAiSuggestions = _a.hideAiSuggestions, onToggleHideAi = _a.onToggleHideAi, onBlock = _a.onBlock, onLeave = _a.onLeave, onDeleteForMe = _a.onDeleteForMe, onReport = _a.onReport;
    var _b = (0, react_1.useState)(false), mutingBusy = _b[0], setMutingBusy = _b[1];
    var _c = (0, react_1.useState)(false), showReport = _c[0], setShowReport = _c[1];
    function handleToggleMute() {
        return __awaiter(this, void 0, void 0, function () {
            var _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        setMutingBusy(true);
                        _b.label = 1;
                    case 1:
                        _b.trys.push([1, 3, , 4]);
                        return [4 /*yield*/, onToggleMute()];
                    case 2:
                        _b.sent();
                        return [3 /*break*/, 4];
                    case 3:
                        _a = _b.sent();
                        return [3 /*break*/, 4];
                    case 4:
                        setMutingBusy(false);
                        return [2 /*return*/];
                }
            });
        });
    }
    function handleBlock() {
        onClose();
        react_native_1.Alert.alert('Block user?', "They won't be able to message you or see your profile.", [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Block', style: 'destructive', onPress: onBlock },
        ]);
    }
    function handleLeave() {
        onClose();
        react_native_1.Alert.alert('Leave group?', 'You will no longer have access to this chat.', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Leave', style: 'destructive', onPress: onLeave },
        ]);
    }
    function handleDeleteForMe() {
        onClose();
        react_native_1.Alert.alert('Delete for me?', 'This conversation will be removed from your inbox. This only affects your view.', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Delete', style: 'destructive', onPress: onDeleteForMe },
        ]);
    }
    return (<react_native_1.Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <react_native_1.Pressable style={sh.overlay} onPress={onClose}/>
      <react_native_1.View style={sh.sheet}>
        {showReport ? (<ReportSheet onClose={function () { setShowReport(false); onClose(); }} onReport={onReport}/>) : (<>
            <react_native_1.View style={sh.handle}/>
            <react_native_1.View style={sh.headerRow}>
              <react_native_1.Text style={sh.title}>Chat settings</react_native_1.Text>
              <react_native_1.Pressable onPress={onClose} hitSlop={8}><lucide_react_native_1.X size={18} color={tokens_1.color.mute}/></react_native_1.Pressable>
            </react_native_1.View>

            {/* Hide AI suggestions toggle */}
            <react_native_1.View style={sh.toggleRow}>
              <react_native_1.View style={sh.toggleLeft}>
                <lucide_react_native_1.Bot size={18} color={tokens_1.color.ink}/>
                <react_native_1.View>
                  <react_native_1.Text style={sh.rowLabel}>Hide AI suggestions</react_native_1.Text>
                  <react_native_1.Text style={sh.rowSub}>Don't show Compass AI cards above composer</react_native_1.Text>
                </react_native_1.View>
              </react_native_1.View>
              <react_native_1.Switch value={hideAiSuggestions} onValueChange={onToggleHideAi} trackColor={{ false: tokens_1.color.haze, true: tokens_1.color.signal }} thumbColor={tokens_1.color.onInk}/>
            </react_native_1.View>

            {/* Mute notifications */}
            <react_native_1.View style={sh.toggleRow}>
              <react_native_1.View style={sh.toggleLeft}>
                {isMuted
                ? <lucide_react_native_1.Volume2 size={18} color={tokens_1.color.ink}/>
                : <lucide_react_native_1.VolumeX size={18} color={tokens_1.color.ink}/>}
                <react_native_1.View>
                  <react_native_1.Text style={sh.rowLabel}>{isMuted ? 'Unmute notifications' : 'Mute notifications'}</react_native_1.Text>
                  <react_native_1.Text style={sh.rowSub}>{isMuted ? 'Re-enable push alerts for this chat' : 'Silence push alerts for this chat'}</react_native_1.Text>
                </react_native_1.View>
              </react_native_1.View>
              {mutingBusy ? (<react_native_1.ActivityIndicator size="small" color={tokens_1.color.signal}/>) : (<react_native_1.Switch value={isMuted} onValueChange={handleToggleMute} trackColor={{ false: tokens_1.color.haze, true: tokens_1.color.signal }} thumbColor={tokens_1.color.onInk}/>)}
            </react_native_1.View>

            <react_native_1.View style={sh.divider}/>

            {/* Report */}
            <react_native_1.Pressable style={sh.row} onPress={function () { return setShowReport(true); }}>
              <lucide_react_native_1.Flag size={18} color={tokens_1.color.ink}/>
              <react_native_1.Text style={sh.rowLabel}>Report conversation</react_native_1.Text>
            </react_native_1.Pressable>

            {/* Block — DM only */}
            {threadType === 'direct' && otherUserId && (<react_native_1.Pressable style={sh.row} onPress={handleBlock}>
                <lucide_react_native_1.UserX size={18} color="#EF4444"/>
                <react_native_1.Text style={[sh.rowLabel, sh.destructive]}>Block user</react_native_1.Text>
              </react_native_1.Pressable>)}

            {/* Leave — group only */}
            {(threadType === 'trip' || threadType === 'circle') && onLeave && (<react_native_1.Pressable style={sh.row} onPress={handleLeave}>
                <lucide_react_native_1.LogOut size={18} color="#EF4444"/>
                <react_native_1.Text style={[sh.rowLabel, sh.destructive]}>Leave group</react_native_1.Text>
              </react_native_1.Pressable>)}

            {/* Delete for me */}
            {onDeleteForMe && (<react_native_1.Pressable style={sh.row} onPress={handleDeleteForMe}>
                <lucide_react_native_1.Trash2 size={18} color="#EF4444"/>
                <react_native_1.Text style={[sh.rowLabel, sh.destructive]}>Delete for me</react_native_1.Text>
              </react_native_1.Pressable>)}
          </>)}
      </react_native_1.View>
    </react_native_1.Modal>);
}
var sh = react_native_1.StyleSheet.create({
    overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
    sheet: {
        backgroundColor: tokens_1.color.paperRaised,
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        paddingHorizontal: tokens_1.space.lg,
        paddingBottom: 40,
        paddingTop: tokens_1.space.sm,
    },
    handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: tokens_1.color.haze, alignSelf: 'center', marginBottom: tokens_1.space.md },
    headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: tokens_1.space.md },
    title: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontWeight: '700', fontSize: 16 }),
    toggleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 12,
        borderTopWidth: react_native_1.StyleSheet.hairlineWidth,
        borderTopColor: tokens_1.color.haze,
    },
    toggleLeft: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.md, flex: 1, paddingRight: tokens_1.space.md },
    divider: { height: 8, marginHorizontal: -tokens_1.space.lg, backgroundColor: tokens_1.color.paper, marginVertical: tokens_1.space.sm },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.md,
        paddingVertical: 14,
        borderTopWidth: react_native_1.StyleSheet.hairlineWidth,
        borderTopColor: tokens_1.color.haze,
    },
    rowLabel: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink }),
    rowSub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11, marginTop: 1 }),
    destructive: { color: '#EF4444' },
});
var rs = react_native_1.StyleSheet.create({
    wrap: { gap: tokens_1.space.sm },
    handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: tokens_1.color.haze, alignSelf: 'center', marginBottom: tokens_1.space.md },
    title: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontWeight: '700', fontSize: 16, marginBottom: 2 }),
    sub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, marginBottom: tokens_1.space.md }),
    option: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 12,
        paddingHorizontal: tokens_1.space.sm,
        borderRadius: tokens_1.radius.md,
        borderWidth: 1,
        borderColor: tokens_1.color.haze,
        marginBottom: tokens_1.space.xs,
    },
    optionSelected: { borderColor: tokens_1.color.signal, backgroundColor: tokens_1.color.signal + '0A' },
    optionText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink }),
    optionTextSelected: { color: tokens_1.color.signal, fontWeight: '700' },
    check: { fontSize: 14, color: tokens_1.color.signal, fontWeight: '700' },
    submitBtn: {
        marginTop: tokens_1.space.md,
        backgroundColor: '#EF4444',
        borderRadius: tokens_1.radius.md,
        paddingVertical: 14,
        alignItems: 'center',
    },
    submitBtnDisabled: { opacity: 0.45 },
    submitLabel: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.onInk, fontWeight: '700' }),
    cancelBtn: { paddingVertical: 10, alignItems: 'center' },
    cancelLabel: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute }),
});
