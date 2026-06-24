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
exports.SafeReturnSetupSheet = SafeReturnSetupSheet;
/**
 * SafeReturnSetupSheet
 *
 * Bottom sheet / modal for configuring and starting a Safe Return session.
 * Shown when the user taps "Set up Safe Return" from a plan item or settings.
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../../theme/tokens");
var safeReturn_1 = require("../../services/safeReturn");
// ── Timer options ─────────────────────────────────────────────────────────────
var TIMER_OPTIONS = [
    { label: '15 minutes', minutes: 15 },
    { label: '30 minutes', minutes: 30 },
    { label: '1 hour', minutes: 60 },
    { label: '2 hours', minutes: 120 },
    { label: 'Until I confirm', minutes: null },
];
var ESCALATION_OPTIONS = [
    { level: 0, label: 'Notify me only', desc: 'Only you will be reminded. No alerts are sent to anyone else.' },
    { level: 1, label: 'Alert Trusted Circle', desc: 'Your selected contacts are notified if you miss the check-in.' },
    { level: 2, label: 'Alert + Share location', desc: 'Contacts are alerted and can see your approximate area.' },
    { level: 3, label: 'Full escalation', desc: 'Contacts alerted, trip host and crew notified, live area shared.' },
];
// ── Component ─────────────────────────────────────────────────────────────────
function SafeReturnSetupSheet(_a) {
    var visible = _a.visible, onClose = _a.onClose, onStarted = _a.onStarted, planItemId = _a.planItemId, tripId = _a.tripId, planEndsAt = _a.planEndsAt, suggestionReason = _a.suggestionReason;
    var _b = (0, react_1.useState)(30), timerMinutes = _b[0], setTimerMinutes = _b[1];
    var _c = (0, react_1.useState)(0), escalationLevel = _c[0], setEscalationLevel = _c[1];
    var _d = (0, react_1.useState)(false), trustedCircleEnabled = _d[0], setTrustedCircleEnabled = _d[1];
    var _e = (0, react_1.useState)(false), liveShareEnabled = _e[0], setLiveShareEnabled = _e[1];
    var _f = (0, react_1.useState)(false), notifyHostEnabled = _f[0], setNotifyHostEnabled = _f[1];
    var _g = (0, react_1.useState)(false), notifyTripCrewEnabled = _g[0], setNotifyTripCrewEnabled = _g[1];
    var _h = (0, react_1.useState)(''), emergencyNote = _h[0], setEmergencyNote = _h[1];
    var _j = (0, react_1.useState)([]), trustedContacts = _j[0], setTrustedContacts = _j[1];
    var _k = (0, react_1.useState)(new Set()), selectedContacts = _k[0], setSelectedContacts = _k[1];
    var _l = (0, react_1.useState)(false), contactsLoading = _l[0], setContactsLoading = _l[1];
    var _m = (0, react_1.useState)(false), showWhyExpanded = _m[0], setShowWhyExpanded = _m[1];
    var _o = (0, react_1.useState)(false), saving = _o[0], setSaving = _o[1];
    (0, react_1.useEffect)(function () {
        if (visible) {
            setContactsLoading(true);
            (0, safeReturn_1.getTrustedContacts)().then(function (c) {
                setTrustedContacts(c);
                setContactsLoading(false);
            });
        }
    }, [visible]);
    // Auto-enable TC when escalation >= 1
    (0, react_1.useEffect)(function () {
        if (escalationLevel >= 1)
            setTrustedCircleEnabled(true);
        if (escalationLevel >= 2)
            setLiveShareEnabled(true);
        if (escalationLevel >= 3) {
            setNotifyHostEnabled(true);
            setNotifyTripCrewEnabled(true);
        }
    }, [escalationLevel]);
    function toggleContact(userId) {
        setSelectedContacts(function (prev) {
            var next = new Set(prev);
            if (next.has(userId))
                next.delete(userId);
            else
                next.add(userId);
            return next;
        });
    }
    function handleStart() {
        return __awaiter(this, void 0, void 0, function () {
            var contacts, created, started;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        setSaving(true);
                        contacts = trustedContacts
                            .filter(function (c) { return selectedContacts.has(c.userId); })
                            .map(function (c) { return ({
                            contactUserId: c.userId,
                            contactName: c.displayName,
                            contactMethod: 'in_app',
                            canReceiveLiveLocation: liveShareEnabled,
                        }); });
                        return [4 /*yield*/, (0, safeReturn_1.createSession)({
                                timerMinutes: timerMinutes !== null && timerMinutes !== void 0 ? timerMinutes : undefined,
                                escalationLevel: escalationLevel,
                                trustedCircleEnabled: trustedCircleEnabled,
                                liveShareEnabled: liveShareEnabled,
                                notifyHostEnabled: notifyHostEnabled,
                                notifyTripCrewEnabled: notifyTripCrewEnabled,
                                emergencyNote: emergencyNote.trim() || undefined,
                                planItemId: planItemId,
                                tripId: tripId,
                                contacts: contacts,
                            })];
                    case 1:
                        created = _a.sent();
                        if (!created.ok || !created.session) {
                            setSaving(false);
                            react_native_1.Alert.alert('Error', 'Could not set up Safe Return. Please try again.');
                            return [2 /*return*/];
                        }
                        return [4 /*yield*/, (0, safeReturn_1.startSession)(created.session.id)];
                    case 2:
                        started = _a.sent();
                        setSaving(false);
                        if (started.ok && started.session) {
                            onStarted === null || onStarted === void 0 ? void 0 : onStarted(started.session.id);
                            onClose();
                        }
                        else {
                            react_native_1.Alert.alert('Error', 'Session created but could not be started.');
                        }
                        return [2 /*return*/];
                }
            });
        });
    }
    return (<react_native_1.Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <react_native_1.View style={styles.root}>
        {/* Header */}
        <react_native_1.View style={styles.header}>
          <react_native_1.View style={styles.headerLeft}>
            <lucide_react_native_1.Shield size={20} color={tokens_1.color.deep}/>
            <react_native_1.Text style={styles.title}>Safe Return</react_native_1.Text>
          </react_native_1.View>
          <react_native_1.Pressable onPress={onClose} hitSlop={12}>
            <lucide_react_native_1.X size={22} color={tokens_1.color.mute}/>
          </react_native_1.Pressable>
        </react_native_1.View>

        <react_native_1.ScrollView style={styles.body} contentContainerStyle={{ paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
          {/* Suggestion reason */}
          {suggestionReason ? (<react_native_1.View style={styles.reasonBanner}>
              <lucide_react_native_1.Info size={14} color={tokens_1.color.deep}/>
              <react_native_1.Text style={styles.reasonText}>{suggestionReason}</react_native_1.Text>
            </react_native_1.View>) : null}

          {/* Why Safe Return */}
          <react_native_1.Pressable style={styles.whyRow} onPress={function () { return setShowWhyExpanded(function (v) { return !v; }); }}>
            <react_native_1.Text style={styles.whyLabel}>Why Safe Return?</react_native_1.Text>
            {showWhyExpanded ? <lucide_react_native_1.ChevronUp size={16} color={tokens_1.color.mute}/> : <lucide_react_native_1.ChevronDown size={16} color={tokens_1.color.mute}/>}
          </react_native_1.Pressable>
          {showWhyExpanded && (<react_native_1.Text style={styles.whyBody}>
              Safe Return lets you set a timer for when you expect to be back. If you miss the check-in, we'll prompt you
              and — based on your settings — can quietly alert your trusted contacts. No emergency services are contacted
              automatically; all actions are your choice.
            </react_native_1.Text>)}

          {/* Timer picker */}
          <react_native_1.Text style={styles.sectionLabel}>Check-in timer</react_native_1.Text>
          <react_native_1.View style={styles.optionRow}>
            {TIMER_OPTIONS.map(function (opt) { return (<react_native_1.Pressable key={opt.label} style={[styles.chip, timerMinutes === opt.minutes && styles.chipActive]} onPress={function () { return setTimerMinutes(opt.minutes); }}>
                <react_native_1.Text style={[styles.chipText, timerMinutes === opt.minutes && styles.chipTextActive]}>
                  {opt.label}
                </react_native_1.Text>
              </react_native_1.Pressable>); })}
            {planEndsAt && new Date(planEndsAt) > new Date() ? (function () {
            var planEndMinutes = Math.max(5, Math.round((new Date(planEndsAt).getTime() - Date.now()) / 60000));
            return (<react_native_1.Pressable key="plan-ends" style={[styles.chip, timerMinutes === planEndMinutes && styles.chipActive]} onPress={function () { return setTimerMinutes(planEndMinutes); }}>
                  <react_native_1.Text style={[styles.chipText, timerMinutes === planEndMinutes && styles.chipTextActive]}>
                    Until plan ends
                  </react_native_1.Text>
                </react_native_1.Pressable>);
        })() : null}
          </react_native_1.View>

          {/* Escalation level */}
          <react_native_1.Text style={styles.sectionLabel}>If I miss the check-in…</react_native_1.Text>
          {ESCALATION_OPTIONS.map(function (opt) { return (<react_native_1.Pressable key={opt.level} style={[styles.escalationRow, escalationLevel === opt.level && styles.escalationRowActive]} onPress={function () { return setEscalationLevel(opt.level); }}>
              <react_native_1.View style={[styles.radio, escalationLevel === opt.level && styles.radioActive]}/>
              <react_native_1.View style={{ flex: 1 }}>
                <react_native_1.Text style={styles.escalationLabel}>{opt.label}</react_native_1.Text>
                <react_native_1.Text style={styles.escalationDesc}>{opt.desc}</react_native_1.Text>
              </react_native_1.View>
            </react_native_1.Pressable>); })}

          {/* Trusted contacts (shown when escalation >= 1) */}
          {escalationLevel >= 1 && (<>
              <react_native_1.Text style={styles.sectionLabel}>Trusted contacts to alert</react_native_1.Text>
              {contactsLoading
                ? <react_native_1.ActivityIndicator color={tokens_1.color.deep} style={{ marginVertical: tokens_1.space.md }}/>
                : trustedContacts.length === 0
                    ? <react_native_1.Text style={styles.emptyMsg}>No contacts found. Follow people to add them as trusted contacts.</react_native_1.Text>
                    : trustedContacts.map(function (c) {
                        var _a, _b;
                        return (<react_native_1.Pressable key={c.userId} style={[styles.contactRow, selectedContacts.has(c.userId) && styles.contactRowActive]} onPress={function () { return toggleContact(c.userId); }}>
                      <react_native_1.View style={[styles.checkBox, selectedContacts.has(c.userId) && styles.checkBoxActive]}>
                        {selectedContacts.has(c.userId) && <react_native_1.Text style={styles.checkMark}>✓</react_native_1.Text>}
                      </react_native_1.View>
                      <react_native_1.View>
                        <react_native_1.Text style={styles.contactName}>{(_b = (_a = c.displayName) !== null && _a !== void 0 ? _a : c.handle) !== null && _b !== void 0 ? _b : 'Traveler'}</react_native_1.Text>
                        {c.handle ? <react_native_1.Text style={styles.contactHandle}>@{c.handle}</react_native_1.Text> : null}
                      </react_native_1.View>
                    </react_native_1.Pressable>);
                    })}
            </>)}

          {/* Toggles */}
          <react_native_1.Text style={styles.sectionLabel}>Options</react_native_1.Text>

          {escalationLevel >= 2 && (<react_native_1.View style={styles.toggleRow}>
              <react_native_1.View style={{ flex: 1 }}>
                <react_native_1.Text style={styles.toggleLabel}>Share my approximate area</react_native_1.Text>
                <react_native_1.Text style={styles.toggleSub}>Contacts see city/district only, never exact GPS</react_native_1.Text>
              </react_native_1.View>
              <react_native_1.Switch value={liveShareEnabled} onValueChange={setLiveShareEnabled} trackColor={{ true: tokens_1.color.deep }}/>
            </react_native_1.View>)}

          {tripId && (<>
              <react_native_1.View style={styles.toggleRow}>
                <react_native_1.View style={{ flex: 1 }}>
                  <react_native_1.Text style={styles.toggleLabel}>Notify trip host</react_native_1.Text>
                  <react_native_1.Text style={styles.toggleSub}>Host gets a calm heads-up if you miss check-in</react_native_1.Text>
                </react_native_1.View>
                <react_native_1.Switch value={notifyHostEnabled} onValueChange={setNotifyHostEnabled} trackColor={{ true: tokens_1.color.deep }}/>
              </react_native_1.View>
              <react_native_1.View style={styles.toggleRow}>
                <react_native_1.View style={{ flex: 1 }}>
                  <react_native_1.Text style={styles.toggleLabel}>Notify trip crew</react_native_1.Text>
                  <react_native_1.Text style={styles.toggleSub}>Fellow trip members get a calm notification</react_native_1.Text>
                </react_native_1.View>
                <react_native_1.Switch value={notifyTripCrewEnabled} onValueChange={setNotifyTripCrewEnabled} trackColor={{ true: tokens_1.color.deep }}/>
              </react_native_1.View>
            </>)}

          {/* Emergency note */}
          <react_native_1.Text style={styles.sectionLabel}>Emergency note (optional)</react_native_1.Text>
          <react_native_1.TextInput style={styles.noteInput} value={emergencyNote} onChangeText={setEmergencyNote} placeholder="e.g. I'll be at the night market near Khao San Rd" placeholderTextColor={tokens_1.color.mute} multiline maxLength={500}/>

          {/* Privacy callout */}
          <react_native_1.View style={styles.privacyBox}>
            <react_native_1.Text style={styles.privacyText}>
              🔒 Only contacts you select are notified. Exact GPS is never shared.
              All actions (including emergency help) require your explicit tap — nothing is automatic.
            </react_native_1.Text>
          </react_native_1.View>

          {/* Start button */}
          <react_native_1.Pressable style={[styles.startBtn, saving && { opacity: 0.6 }]} onPress={handleStart} disabled={saving}>
            {saving
            ? <react_native_1.ActivityIndicator color="#fff"/>
            : <react_native_1.Text style={styles.startBtnText}>Start Safe Return</react_native_1.Text>}
          </react_native_1.Pressable>
        </react_native_1.ScrollView>
      </react_native_1.View>
    </react_native_1.Modal>);
}
// ── Styles ────────────────────────────────────────────────────────────────────
var styles = react_native_1.StyleSheet.create({
    root: { flex: 1, backgroundColor: tokens_1.color.paper },
    header: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        paddingHorizontal: tokens_1.space.lg, paddingVertical: tokens_1.space.md,
        borderBottomWidth: 1, borderBottomColor: tokens_1.color.haze,
        backgroundColor: tokens_1.color.paperRaised,
    },
    headerLeft: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm },
    title: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 17 }),
    body: { flex: 1, paddingHorizontal: tokens_1.space.lg },
    reasonBanner: {
        flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm,
        backgroundColor: '#EAF2F4', borderRadius: tokens_1.radius.md,
        padding: tokens_1.space.md, marginTop: tokens_1.space.lg,
    },
    reasonText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.deep, flex: 1, fontSize: 13 }),
    whyRow: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        paddingVertical: tokens_1.space.md, marginTop: tokens_1.space.sm,
    },
    whyLabel: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.deep, fontSize: 13 }),
    whyBody: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 12, lineHeight: 18, marginBottom: tokens_1.space.md }),
    sectionLabel: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 13, marginTop: tokens_1.space.lg, marginBottom: tokens_1.space.sm }),
    optionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: tokens_1.space.sm },
    chip: {
        paddingHorizontal: tokens_1.space.md, paddingVertical: 7, borderRadius: tokens_1.radius.pill,
        borderWidth: 1, borderColor: tokens_1.color.haze, backgroundColor: tokens_1.color.paperRaised,
    },
    chipActive: { backgroundColor: tokens_1.color.deep, borderColor: tokens_1.color.deep },
    chipText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.ink, fontSize: 12, fontWeight: '600' }),
    chipTextActive: { color: '#fff' },
    escalationRow: {
        flexDirection: 'row', alignItems: 'flex-start', gap: tokens_1.space.md,
        backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md,
        borderWidth: 1, borderColor: tokens_1.color.haze, padding: tokens_1.space.md, marginBottom: tokens_1.space.sm,
    },
    escalationRowActive: { borderColor: tokens_1.color.deep, backgroundColor: '#EAF2F4' },
    radio: {
        width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: tokens_1.color.haze, marginTop: 2,
    },
    radioActive: { borderColor: tokens_1.color.deep, backgroundColor: tokens_1.color.deep },
    escalationLabel: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 13 }),
    escalationDesc: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11, lineHeight: 16 }),
    contactRow: {
        flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.md,
        backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md,
        borderWidth: 1, borderColor: tokens_1.color.haze, padding: tokens_1.space.md, marginBottom: tokens_1.space.sm,
    },
    contactRowActive: { borderColor: tokens_1.color.deep },
    checkBox: {
        width: 20, height: 20, borderRadius: 4, borderWidth: 2, borderColor: tokens_1.color.haze,
        alignItems: 'center', justifyContent: 'center',
    },
    checkBoxActive: { backgroundColor: tokens_1.color.deep, borderColor: tokens_1.color.deep },
    checkMark: { color: '#fff', fontSize: 12, fontWeight: '700' },
    contactName: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 13 }),
    contactHandle: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
    emptyMsg: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 12 }),
    toggleRow: {
        flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.md,
        backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md,
        borderWidth: 1, borderColor: tokens_1.color.haze, padding: tokens_1.space.md, marginBottom: tokens_1.space.sm,
    },
    toggleLabel: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 13 }),
    toggleSub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
    noteInput: __assign(__assign({ backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, padding: tokens_1.space.md }, tokens_1.type.body), { color: tokens_1.color.ink, fontSize: 13, minHeight: 80, textAlignVertical: 'top' }),
    privacyBox: {
        backgroundColor: '#F0F7F4', borderRadius: tokens_1.radius.md, padding: tokens_1.space.md, marginTop: tokens_1.space.lg,
    },
    privacyText: __assign(__assign({}, tokens_1.type.small), { color: '#2D6A4F', fontSize: 12, lineHeight: 18 }),
    startBtn: {
        backgroundColor: tokens_1.color.deep, borderRadius: tokens_1.radius.md, padding: tokens_1.space.lg,
        alignItems: 'center', marginTop: tokens_1.space.xl,
    },
    startBtnText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: '#fff', fontSize: 15 }),
});
