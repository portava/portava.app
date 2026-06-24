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
exports.ActiveSafeReturnCard = ActiveSafeReturnCard;
/**
 * ActiveSafeReturnCard
 *
 * Persistent banner showing the active Safe Return session countdown,
 * status, and action buttons. Render on the plan detail screen.
 * Tapping it expands to a full-screen modal.
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../../theme/tokens");
var safeReturn_1 = require("../../services/safeReturn");
var EmergencyHelpSheet_1 = require("./EmergencyHelpSheet");
// ── Countdown hook ────────────────────────────────────────────────────────────
function useCountdown(timerEndAt) {
    var _a = (0, react_1.useState)(''), display = _a[0], setDisplay = _a[1];
    (0, react_1.useEffect)(function () {
        function tick() {
            if (!timerEndAt) {
                setDisplay('');
                return;
            }
            var ms = new Date(timerEndAt).getTime() - Date.now();
            if (ms <= 0) {
                setDisplay('Expired');
                return;
            }
            var totalSec = Math.floor(ms / 1000);
            var h = Math.floor(totalSec / 3600);
            var m = Math.floor((totalSec % 3600) / 60);
            var s = totalSec % 60;
            if (h > 0)
                setDisplay("".concat(h, "h ").concat(String(m).padStart(2, '0'), "m"));
            else
                setDisplay("".concat(String(m).padStart(2, '0'), ":").concat(String(s).padStart(2, '0')));
        }
        tick();
        var id = setInterval(tick, 1000);
        return function () { return clearInterval(id); };
    }, [timerEndAt]);
    return display;
}
// ── Status helpers ────────────────────────────────────────────────────────────
var STATUS_COLOR = {
    pending: '#F5A623',
    active: tokens_1.color.deep,
    missed: tokens_1.color.signal,
    safe: tokens_1.color.success,
    cancelled: tokens_1.color.mute,
};
var STATUS_LABEL = {
    pending: 'Setting up',
    active: 'Active',
    missed: 'Check-in missed',
    safe: 'Safe ✓',
    cancelled: 'Cancelled',
};
// ── Component ─────────────────────────────────────────────────────────────────
function ActiveSafeReturnCard(_a) {
    var _this = this;
    var _b, _c;
    var session = _a.session, onSessionEnded = _a.onSessionEnded, onSessionUpdated = _a.onSessionUpdated, _d = _a.compact, compact = _d === void 0 ? false : _d;
    var router = (0, expo_router_1.useRouter)();
    var _e = (0, react_1.useState)(false), expanded = _e[0], setExpanded = _e[1];
    var _f = (0, react_1.useState)(false), showEmergency = _f[0], setShowEmergency = _f[1];
    var _g = (0, react_1.useState)(false), loading = _g[0], setLoading = _g[1];
    var _h = (0, react_1.useState)(false), shareLoading = _h[0], setShareLoading = _h[1];
    var countdown = useCountdown(session.timerEndAt);
    var handleConfirmSafe = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    setLoading(true);
                    return [4 /*yield*/, (0, safeReturn_1.confirmSafe)(session.id)];
                case 1:
                    r = _a.sent();
                    setLoading(false);
                    if (r.ok) {
                        setExpanded(false);
                        onSessionEnded === null || onSessionEnded === void 0 ? void 0 : onSessionEnded();
                    }
                    else {
                        react_native_1.Alert.alert('Error', 'Could not confirm. Please try again.');
                    }
                    return [2 /*return*/];
            }
        });
    }); }, [session.id, onSessionEnded]);
    var handleExtend = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    setLoading(true);
                    return [4 /*yield*/, (0, safeReturn_1.extendTimer)(session.id, 15)];
                case 1:
                    r = _a.sent();
                    setLoading(false);
                    if (r.ok && r.session) {
                        onSessionUpdated === null || onSessionUpdated === void 0 ? void 0 : onSessionUpdated(r.session);
                    }
                    else {
                        react_native_1.Alert.alert('Error', 'Could not extend timer.');
                    }
                    return [2 /*return*/];
            }
        });
    }); }, [session.id, onSessionUpdated]);
    var handleShareLocation = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var contacts, eligible, contact, r;
        var _this = this;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (!session.liveShareEnabled) {
                        react_native_1.Alert.alert('Not configured', 'Enable "Share my approximate area" in Safe Return settings to use this feature.');
                        return [2 /*return*/];
                    }
                    setShareLoading(true);
                    return [4 /*yield*/, (0, safeReturn_1.getSessionContacts)(session.id)];
                case 1:
                    contacts = _b.sent();
                    eligible = contacts.filter(function (c) { return c.canReceiveLiveLocation; });
                    setShareLoading(false);
                    if (eligible.length === 0) {
                        react_native_1.Alert.alert('No contacts', 'No contacts in this session have location sharing enabled.');
                        return [2 /*return*/];
                    }
                    if (!(eligible.length === 1)) return [3 /*break*/, 3];
                    contact = eligible[0];
                    return [4 /*yield*/, (0, safeReturn_1.startLiveShare)(session.id, { recipientContactId: contact.id })];
                case 2:
                    r = _b.sent();
                    if (r.ok) {
                        react_native_1.Alert.alert('Sharing started', "Your approximate area is now visible to ".concat((_a = contact.contactName) !== null && _a !== void 0 ? _a : 'your contact', " for 1 hour."));
                    }
                    else {
                        react_native_1.Alert.alert('Error', 'Could not start location share. Please try again.');
                    }
                    return [2 /*return*/];
                case 3:
                    // Multiple contacts — let user pick
                    react_native_1.Alert.alert('Share with…', 'Choose a contact to share your approximate area with.', __spreadArray(__spreadArray([], eligible.map(function (c) {
                        var _a;
                        return ({
                            text: (_a = c.contactName) !== null && _a !== void 0 ? _a : 'Contact',
                            onPress: function () { return __awaiter(_this, void 0, void 0, function () {
                                var r;
                                return __generator(this, function (_a) {
                                    switch (_a.label) {
                                        case 0: return [4 /*yield*/, (0, safeReturn_1.startLiveShare)(session.id, { recipientContactId: c.id })];
                                        case 1:
                                            r = _a.sent();
                                            if (!r.ok)
                                                react_native_1.Alert.alert('Error', 'Could not start location share.');
                                            return [2 /*return*/];
                                    }
                                });
                            }); },
                        });
                    }), true), [
                        { text: 'Cancel', style: 'cancel' },
                    ], false));
                    return [2 /*return*/];
            }
        });
    }); }, [session.id, session.liveShareEnabled]);
    var handleMessageCircle = (0, react_1.useCallback)(function () {
        router.push('/messages');
    }, [router]);
    var handleCancel = (0, react_1.useCallback)(function () {
        react_native_1.Alert.alert('Cancel Safe Return?', 'Your trusted contacts will not be notified and the session will end.', [
            { text: 'Keep active', style: 'cancel' },
            {
                text: 'Cancel session', style: 'destructive',
                onPress: function () { return __awaiter(_this, void 0, void 0, function () {
                    var r;
                    return __generator(this, function (_a) {
                        switch (_a.label) {
                            case 0:
                                setLoading(true);
                                return [4 /*yield*/, (0, safeReturn_1.cancelSession)(session.id)];
                            case 1:
                                r = _a.sent();
                                setLoading(false);
                                if (r.ok) {
                                    setExpanded(false);
                                    onSessionEnded === null || onSessionEnded === void 0 ? void 0 : onSessionEnded();
                                }
                                return [2 /*return*/];
                        }
                    });
                }); },
            },
        ]);
    }, [session.id, onSessionEnded]);
    var statusColor = (_b = STATUS_COLOR[session.status]) !== null && _b !== void 0 ? _b : tokens_1.color.mute;
    var statusLabel = (_c = STATUS_LABEL[session.status]) !== null && _c !== void 0 ? _c : session.status;
    // ── Compact banner ────────────────────────────────────────────────────────
    if (compact) {
        return (<>
        <react_native_1.Pressable style={[styles.banner, { borderLeftColor: statusColor }]} onPress={function () { return setExpanded(true); }}>
          <lucide_react_native_1.Shield size={16} color={statusColor}/>
          <react_native_1.View style={{ flex: 1 }}>
            <react_native_1.Text style={[styles.bannerStatus, { color: statusColor }]}>{statusLabel}</react_native_1.Text>
            {countdown ? <react_native_1.Text style={styles.bannerCountdown}>{countdown} remaining</react_native_1.Text> : null}
          </react_native_1.View>
          <lucide_react_native_1.ChevronRight size={16} color={tokens_1.color.mute}/>
        </react_native_1.Pressable>
        {expanded && (<SafeReturnModal session={session} countdown={countdown} statusLabel={statusLabel} statusColor={statusColor} loading={loading} shareLoading={shareLoading} onClose={function () { return setExpanded(false); }} onConfirmSafe={handleConfirmSafe} onExtend={handleExtend} onCancel={handleCancel} onEmergency={function () { return setShowEmergency(true); }} onShareLocation={handleShareLocation} onMessageCircle={handleMessageCircle}/>)}
        <EmergencyHelpSheet_1.EmergencyHelpSheet visible={showEmergency} onClose={function () { return setShowEmergency(false); }}/>
      </>);
    }
    // ── Full card ─────────────────────────────────────────────────────────────
    return (<>
      <react_native_1.View style={[styles.card, { borderColor: statusColor }]}>
        <react_native_1.View style={styles.cardHeader}>
          <lucide_react_native_1.Shield size={18} color={statusColor}/>
          <react_native_1.Text style={[styles.cardStatus, { color: statusColor }]}>{statusLabel}</react_native_1.Text>
          {countdown ? (<react_native_1.View style={styles.countdownBadge}>
              <lucide_react_native_1.Clock size={12} color={tokens_1.color.mute}/>
              <react_native_1.Text style={styles.countdownText}>{countdown}</react_native_1.Text>
            </react_native_1.View>) : null}
        </react_native_1.View>

        <react_native_1.View style={styles.actions}>
          <react_native_1.Pressable style={styles.primaryBtn} onPress={handleConfirmSafe} disabled={loading}>
            {loading ? <react_native_1.ActivityIndicator color="#fff" size="small"/> : (<>
                <lucide_react_native_1.CheckCircle size={16} color="#fff"/>
                <react_native_1.Text style={styles.primaryBtnText}>I'm Safe</react_native_1.Text>
              </>)}
          </react_native_1.Pressable>
          <react_native_1.Pressable style={styles.secondaryBtn} onPress={handleExtend} disabled={loading}>
            <react_native_1.Text style={styles.secondaryBtnText}>+15 min</react_native_1.Text>
          </react_native_1.Pressable>
          <react_native_1.Pressable style={styles.emergencyBtn} onPress={function () { return setShowEmergency(true); }}>
            <lucide_react_native_1.PhoneCall size={14} color={tokens_1.color.signal}/>
          </react_native_1.Pressable>
        </react_native_1.View>

        {/* Quick-action row */}
        <react_native_1.View style={styles.quickActions}>
          <react_native_1.Pressable style={styles.quickBtn} onPress={handleShareLocation} disabled={shareLoading}>
            {shareLoading
            ? <react_native_1.ActivityIndicator size="small" color={tokens_1.color.deep}/>
            : <>
                  <lucide_react_native_1.Share2 size={13} color={tokens_1.color.deep}/>
                  <react_native_1.Text style={styles.quickBtnText}>Share Location</react_native_1.Text>
                </>}
          </react_native_1.Pressable>
          <react_native_1.Pressable style={styles.quickBtn} onPress={handleMessageCircle}>
            <lucide_react_native_1.MessageCircle size={13} color={tokens_1.color.deep}/>
            <react_native_1.Text style={styles.quickBtnText}>Message Circle</react_native_1.Text>
          </react_native_1.Pressable>
        </react_native_1.View>

        <react_native_1.Pressable style={styles.cancelLink} onPress={handleCancel}>
          <react_native_1.Text style={styles.cancelLinkText}>Cancel Safe Return</react_native_1.Text>
        </react_native_1.Pressable>
      </react_native_1.View>
      <EmergencyHelpSheet_1.EmergencyHelpSheet visible={showEmergency} onClose={function () { return setShowEmergency(false); }}/>
    </>);
}
// ── Full-screen expand modal ──────────────────────────────────────────────────
function SafeReturnModal(_a) {
    var session = _a.session, countdown = _a.countdown, statusLabel = _a.statusLabel, statusColor = _a.statusColor, loading = _a.loading, shareLoading = _a.shareLoading, onClose = _a.onClose, onConfirmSafe = _a.onConfirmSafe, onExtend = _a.onExtend, onCancel = _a.onCancel, onEmergency = _a.onEmergency, onShareLocation = _a.onShareLocation, onMessageCircle = _a.onMessageCircle;
    return (<react_native_1.Modal animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <react_native_1.View style={styles.modalRoot}>
        <react_native_1.View style={styles.modalHeader}>
          <lucide_react_native_1.Shield size={20} color={statusColor}/>
          <react_native_1.Text style={styles.modalTitle}>Safe Return</react_native_1.Text>
          <react_native_1.Pressable onPress={onClose} hitSlop={12}><lucide_react_native_1.X size={22} color={tokens_1.color.mute}/></react_native_1.Pressable>
        </react_native_1.View>
        <react_native_1.ScrollView contentContainerStyle={styles.modalBody}>
          <react_native_1.View style={[styles.statusBox, { borderColor: statusColor }]}>
            <react_native_1.Text style={[styles.statusBoxLabel, { color: statusColor }]}>{statusLabel}</react_native_1.Text>
            {countdown ? <react_native_1.Text style={styles.statusBoxCountdown}>{countdown}</react_native_1.Text> : null}
          </react_native_1.View>

          <react_native_1.View style={styles.infoRow}>
            <lucide_react_native_1.MapPin size={14} color={tokens_1.color.mute}/>
            <react_native_1.Text style={styles.infoText}>
              {session.trustedCircleEnabled ? 'Trusted contacts will be alerted if you miss check-in' : 'Only you will be notified'}
            </react_native_1.Text>
          </react_native_1.View>
          {session.liveShareEnabled && (<react_native_1.View style={styles.infoRow}>
              <lucide_react_native_1.MapPin size={14} color={tokens_1.color.deep}/>
              <react_native_1.Text style={styles.infoText}>Approximate area sharing enabled</react_native_1.Text>
            </react_native_1.View>)}

          <react_native_1.Pressable style={styles.modalPrimaryBtn} onPress={onConfirmSafe} disabled={loading}>
            {loading ? <react_native_1.ActivityIndicator color="#fff"/> : (<>
                <lucide_react_native_1.CheckCircle size={18} color="#fff"/>
                <react_native_1.Text style={styles.modalPrimaryBtnText}>I'm Safe</react_native_1.Text>
              </>)}
          </react_native_1.Pressable>
          <react_native_1.Pressable style={styles.modalSecondaryBtn} onPress={onExtend} disabled={loading}>
            <react_native_1.Text style={styles.modalSecondaryBtnText}>Extend 15 minutes</react_native_1.Text>
          </react_native_1.Pressable>
          <react_native_1.Pressable style={[styles.modalSecondaryBtn, styles.modalActionBtn]} onPress={onShareLocation} disabled={shareLoading}>
            {shareLoading
            ? <react_native_1.ActivityIndicator size="small" color={tokens_1.color.deep}/>
            : <>
                  <lucide_react_native_1.Share2 size={16} color={tokens_1.color.deep}/>
                  <react_native_1.Text style={[styles.modalSecondaryBtnText, { color: tokens_1.color.deep }]}>Share Location Now</react_native_1.Text>
                </>}
          </react_native_1.Pressable>
          <react_native_1.Pressable style={[styles.modalSecondaryBtn, styles.modalActionBtn]} onPress={onMessageCircle}>
            <lucide_react_native_1.MessageCircle size={16} color={tokens_1.color.deep}/>
            <react_native_1.Text style={[styles.modalSecondaryBtnText, { color: tokens_1.color.deep }]}>Message Trusted Circle</react_native_1.Text>
          </react_native_1.Pressable>
          <react_native_1.Pressable style={styles.modalSecondaryBtn} onPress={onEmergency}>
            <react_native_1.Text style={[styles.modalSecondaryBtnText, { color: tokens_1.color.signal }]}>Emergency Help</react_native_1.Text>
          </react_native_1.Pressable>
          <react_native_1.Pressable style={styles.modalCancelLink} onPress={onCancel}>
            <react_native_1.Text style={styles.cancelLinkText}>Cancel Safe Return</react_native_1.Text>
          </react_native_1.Pressable>
        </react_native_1.ScrollView>
      </react_native_1.View>
    </react_native_1.Modal>);
}
// ── Styles ────────────────────────────────────────────────────────────────────
var styles = react_native_1.StyleSheet.create({
    banner: {
        flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm,
        backgroundColor: tokens_1.color.paperRaised, borderLeftWidth: 3, borderRadius: tokens_1.radius.md,
        paddingHorizontal: tokens_1.space.md, paddingVertical: tokens_1.space.sm,
        marginVertical: tokens_1.space.sm,
    },
    bannerStatus: __assign(__assign({}, tokens_1.type.bodyStrong), { fontSize: 13 }),
    bannerCountdown: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
    card: {
        backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md,
        borderWidth: 1, padding: tokens_1.space.md, marginVertical: tokens_1.space.sm,
    },
    cardHeader: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm, marginBottom: tokens_1.space.md },
    cardStatus: __assign(__assign({}, tokens_1.type.bodyStrong), { fontSize: 14, flex: 1 }),
    countdownBadge: {
        flexDirection: 'row', alignItems: 'center', gap: 4,
        backgroundColor: tokens_1.color.haze, borderRadius: tokens_1.radius.pill, paddingHorizontal: tokens_1.space.sm, paddingVertical: 3,
    },
    countdownText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 12 }),
    actions: { flexDirection: 'row', gap: tokens_1.space.sm, marginBottom: tokens_1.space.sm },
    primaryBtn: {
        flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
        gap: tokens_1.space.sm, backgroundColor: tokens_1.color.deep, borderRadius: tokens_1.radius.md, padding: tokens_1.space.md,
    },
    primaryBtnText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: '#fff', fontSize: 14 }),
    secondaryBtn: {
        borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze,
        backgroundColor: tokens_1.color.paperRaised, padding: tokens_1.space.md, alignItems: 'center', justifyContent: 'center',
    },
    secondaryBtnText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 13 }),
    emergencyBtn: {
        borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.signal,
        backgroundColor: '#FFF0EE', padding: tokens_1.space.md, alignItems: 'center', justifyContent: 'center',
        width: 44,
    },
    cancelLink: { alignItems: 'center', paddingVertical: tokens_1.space.sm },
    cancelLinkText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 12 }),
    modalRoot: { flex: 1, backgroundColor: tokens_1.color.paper },
    modalHeader: {
        flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm,
        justifyContent: 'space-between', padding: tokens_1.space.lg,
        borderBottomWidth: 1, borderBottomColor: tokens_1.color.haze, backgroundColor: tokens_1.color.paperRaised,
    },
    modalTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 17, flex: 1 }),
    modalBody: { padding: tokens_1.space.lg, gap: tokens_1.space.md },
    statusBox: {
        borderWidth: 2, borderRadius: tokens_1.radius.lg, padding: tokens_1.space.xl, alignItems: 'center',
        backgroundColor: tokens_1.color.paperRaised,
    },
    statusBoxLabel: __assign(__assign({}, tokens_1.type.bodyStrong), { fontSize: 16 }),
    statusBoxCountdown: __assign(__assign({}, tokens_1.type.stamp), { fontSize: 32, color: tokens_1.color.ink, marginTop: tokens_1.space.sm }),
    infoRow: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm },
    infoText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 12, flex: 1 }),
    modalPrimaryBtn: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
        gap: tokens_1.space.sm, backgroundColor: tokens_1.color.deep, borderRadius: tokens_1.radius.md, padding: tokens_1.space.lg,
    },
    modalPrimaryBtnText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: '#fff', fontSize: 16 }),
    modalSecondaryBtn: {
        borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze,
        backgroundColor: tokens_1.color.paperRaised, padding: tokens_1.space.md, alignItems: 'center',
    },
    modalSecondaryBtnText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 14 }),
    modalCancelLink: { alignItems: 'center', paddingVertical: tokens_1.space.md },
    modalActionBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: tokens_1.space.sm },
    quickActions: { flexDirection: 'row', gap: tokens_1.space.sm, marginBottom: tokens_1.space.xs },
    quickBtn: {
        flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
        gap: 4, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze,
        backgroundColor: tokens_1.color.paperRaised, paddingVertical: tokens_1.space.sm,
    },
    quickBtnText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.deep, fontSize: 12 }),
});
