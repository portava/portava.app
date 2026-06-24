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
exports.MissedCheckinPrompt = MissedCheckinPrompt;
/**
 * MissedCheckinPrompt
 *
 * Shown when the Safe Return timer expires without confirmation.
 * Calm, non-alarming language with escalation-level-aware options.
 *
 * Level 0: Show only to user — confirm or extend.
 * Level 1: Offer TC alert button.
 * Level 2: Offer TC alert + live location share.
 * Level 3: Open Emergency Help sheet.
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../../theme/tokens");
var safeReturn_1 = require("../../services/safeReturn");
var EmergencyHelpSheet_1 = require("./EmergencyHelpSheet");
function MissedCheckinPrompt(_a) {
    var visible = _a.visible, session = _a.session, onDismiss = _a.onDismiss, onSafe = _a.onSafe, onExtended = _a.onExtended, onShareLocation = _a.onShareLocation, onAlertContacts = _a.onAlertContacts;
    var _b = (0, react_1.useState)(null), loading = _b[0], setLoading = _b[1];
    var _c = (0, react_1.useState)(false), showEmergency = _c[0], setShowEmergency = _c[1];
    function handleSafe() {
        return __awaiter(this, void 0, void 0, function () {
            var r;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        setLoading('safe');
                        return [4 /*yield*/, (0, safeReturn_1.confirmSafe)(session.id)];
                    case 1:
                        r = _a.sent();
                        setLoading(null);
                        if (r.ok) {
                            onSafe === null || onSafe === void 0 ? void 0 : onSafe();
                            onDismiss();
                        }
                        return [2 /*return*/];
                }
            });
        });
    }
    function handleExtend() {
        return __awaiter(this, void 0, void 0, function () {
            var r;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        setLoading('extend');
                        return [4 /*yield*/, (0, safeReturn_1.extendTimer)(session.id, 15)];
                    case 1:
                        r = _a.sent();
                        setLoading(null);
                        if (r.ok && r.session) {
                            onExtended === null || onExtended === void 0 ? void 0 : onExtended(r.session);
                            onDismiss();
                        }
                        return [2 /*return*/];
                }
            });
        });
    }
    return (<>
      <react_native_1.Modal visible={visible} transparent animationType="fade" onRequestClose={onDismiss}>
        <react_native_1.View style={styles.overlay}>
          <react_native_1.View style={styles.sheet}>
            {/* Icon */}
            <react_native_1.View style={styles.iconWrap}>
              <lucide_react_native_1.AlertCircle size={36} color="#F5A623"/>
            </react_native_1.View>

            <react_native_1.Text style={styles.headline}>We couldn't confirm you're safe</react_native_1.Text>
            <react_native_1.Text style={styles.sub}>
              Your Safe Return timer has expired. Please let us know you're okay,
              or use one of the options below.
            </react_native_1.Text>

            {/* Level 0+ actions */}
            <react_native_1.Pressable style={[styles.btn, styles.btnPrimary, loading === 'safe' && styles.btnDisabled]} onPress={handleSafe} disabled={!!loading}>
              {loading === 'safe'
            ? <react_native_1.ActivityIndicator color="#fff"/>
            : <react_native_1.Text style={styles.btnPrimaryText}>✓  I'm Safe</react_native_1.Text>}
            </react_native_1.Pressable>

            <react_native_1.Pressable style={[styles.btn, styles.btnSecondary, loading === 'extend' && styles.btnDisabled]} onPress={handleExtend} disabled={!!loading}>
              {loading === 'extend'
            ? <react_native_1.ActivityIndicator color={tokens_1.color.ink}/>
            : <>
                    <lucide_react_native_1.Clock size={15} color={tokens_1.color.ink}/>
                    <react_native_1.Text style={styles.btnSecondaryText}>Extend 15 minutes</react_native_1.Text>
                  </>}
            </react_native_1.Pressable>

            {/* Level 1+: Alert Trusted Circle */}
            {session.escalationLevel >= 1 && session.trustedCircleEnabled && (<react_native_1.Pressable style={[styles.btn, styles.btnSecondary]} onPress={function () { onAlertContacts === null || onAlertContacts === void 0 ? void 0 : onAlertContacts(); onDismiss(); }}>
                <lucide_react_native_1.Shield size={15} color={tokens_1.color.ink}/>
                <react_native_1.Text style={styles.btnSecondaryText}>Alert my Trusted Circle</react_native_1.Text>
              </react_native_1.Pressable>)}

            {/* Level 2+: Share location */}
            {session.escalationLevel >= 2 && session.liveShareEnabled && (<react_native_1.Pressable style={[styles.btn, styles.btnSecondary]} onPress={function () { onShareLocation === null || onShareLocation === void 0 ? void 0 : onShareLocation(); onDismiss(); }}>
                <react_native_1.Text style={styles.btnSecondaryText}>Share my approximate location</react_native_1.Text>
              </react_native_1.Pressable>)}

            {/* Level 3+: Emergency help */}
            {session.escalationLevel >= 3 && (<react_native_1.Pressable style={[styles.btn, styles.btnEmergency]} onPress={function () { return setShowEmergency(true); }}>
                <react_native_1.Text style={styles.btnEmergencyText}>Emergency Help</react_native_1.Text>
              </react_native_1.Pressable>)}

            {/* Dismiss */}
            <react_native_1.Pressable style={styles.dismissLink} onPress={onDismiss}>
              <react_native_1.Text style={styles.dismissText}>Dismiss for now</react_native_1.Text>
            </react_native_1.Pressable>
          </react_native_1.View>
        </react_native_1.View>
      </react_native_1.Modal>

      <EmergencyHelpSheet_1.EmergencyHelpSheet visible={showEmergency} onClose={function () { return setShowEmergency(false); }}/>
    </>);
}
var styles = react_native_1.StyleSheet.create({
    overlay: {
        flex: 1, backgroundColor: 'rgba(0,0,0,0.5)',
        alignItems: 'center', justifyContent: 'flex-end',
    },
    sheet: {
        backgroundColor: tokens_1.color.paper, borderTopLeftRadius: tokens_1.radius.lg, borderTopRightRadius: tokens_1.radius.lg,
        padding: tokens_1.space.xl, width: '100%', gap: tokens_1.space.sm, paddingBottom: 40,
    },
    iconWrap: { alignItems: 'center', marginBottom: tokens_1.space.sm },
    headline: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 18, textAlign: 'center' }),
    sub: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute, fontSize: 14, textAlign: 'center', lineHeight: 20 }),
    btn: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
        gap: tokens_1.space.sm, borderRadius: tokens_1.radius.md, padding: tokens_1.space.lg, marginTop: tokens_1.space.sm,
    },
    btnPrimary: { backgroundColor: tokens_1.color.success },
    btnPrimaryText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: '#fff', fontSize: 16 }),
    btnSecondary: {
        backgroundColor: tokens_1.color.paperRaised, borderWidth: 1, borderColor: tokens_1.color.haze,
    },
    btnSecondaryText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 14 }),
    btnEmergency: { backgroundColor: '#FFF0EE', borderWidth: 1, borderColor: tokens_1.color.signal },
    btnEmergencyText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.signal, fontSize: 14 }),
    btnDisabled: { opacity: 0.5 },
    dismissLink: { alignItems: 'center', paddingVertical: tokens_1.space.md },
    dismissText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 12 }),
});
