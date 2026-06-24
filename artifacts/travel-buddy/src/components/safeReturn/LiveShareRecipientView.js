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
exports.LiveShareRecipientView = LiveShareRecipientView;
/**
 * LiveShareRecipientView — trusted contact's view
 * Shows approximate area and expiration countdown.
 * Exact GPS is never shown here.
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../../theme/tokens");
function useCountdownSec(secondsRemaining) {
    var _a = (0, react_1.useState)(secondsRemaining !== null && secondsRemaining !== void 0 ? secondsRemaining : 0), secs = _a[0], setSecs = _a[1];
    (0, react_1.useEffect)(function () {
        if (secondsRemaining === null)
            return;
        setSecs(secondsRemaining);
        var id = setInterval(function () { return setSecs(function (s) { return Math.max(0, s - 1); }); }, 1000);
        return function () { return clearInterval(id); };
    }, [secondsRemaining]);
    return secs;
}
function formatCountdown(secs) {
    if (secs <= 0)
        return 'Expired';
    var m = Math.floor(secs / 60);
    var s = secs % 60;
    return m > 0 ? "".concat(m, "m ").concat(String(s).padStart(2, '0'), "s") : "".concat(s, "s");
}
function fetchRecipientView(shareId) {
    return __awaiter(this, void 0, void 0, function () {
        var supabase, sessionData, token, base, res, data, _a;
        var _b, _c, _d;
        return __generator(this, function (_e) {
            switch (_e.label) {
                case 0:
                    _e.trys.push([0, 5, , 6]);
                    return [4 /*yield*/, Promise.resolve().then(function () { return require('../../lib/supabase'); })];
                case 1:
                    supabase = (_e.sent()).supabase;
                    return [4 /*yield*/, supabase.auth.getSession()];
                case 2:
                    sessionData = (_e.sent()).data;
                    token = (_c = (_b = sessionData.session) === null || _b === void 0 ? void 0 : _b.access_token) !== null && _c !== void 0 ? _c : '';
                    base = ((_d = process.env.EXPO_PUBLIC_API_BASE_URL) !== null && _d !== void 0 ? _d : '').replace(/\/$/, '');
                    return [4 /*yield*/, fetch("".concat(base, "/api/safe-return/live-share/").concat(shareId), {
                            headers: { Authorization: "Bearer ".concat(token), 'Content-Type': 'application/json' },
                        })];
                case 3:
                    res = _e.sent();
                    return [4 /*yield*/, res.json()];
                case 4:
                    data = _e.sent();
                    if (!(data === null || data === void 0 ? void 0 : data.ok))
                        return [2 /*return*/, null];
                    return [2 /*return*/, data.share];
                case 5:
                    _a = _e.sent();
                    return [2 /*return*/, null];
                case 6: return [2 /*return*/];
            }
        });
    });
}
function LiveShareRecipientView(_a) {
    var _b;
    var shareId = _a.shareId, onMessage = _a.onMessage;
    var _c = (0, react_1.useState)(null), data = _c[0], setData = _c[1];
    var _d = (0, react_1.useState)(true), loading = _d[0], setLoading = _d[1];
    var _e = (0, react_1.useState)(null), error = _e[0], setError = _e[1];
    var secs = useCountdownSec((_b = data === null || data === void 0 ? void 0 : data.secondsRemaining) !== null && _b !== void 0 ? _b : null);
    (0, react_1.useEffect)(function () {
        setLoading(true);
        fetchRecipientView(shareId).then(function (d) {
            setLoading(false);
            if (!d) {
                setError('This share is unavailable or has expired.');
                return;
            }
            setData(d);
        });
    }, [shareId]);
    if (loading) {
        return (<react_native_1.View style={styles.center}>
        <react_native_1.ActivityIndicator color={tokens_1.color.deep}/>
        <react_native_1.Text style={styles.loadingText}>Loading share details…</react_native_1.Text>
      </react_native_1.View>);
    }
    if (error || !data) {
        return (<react_native_1.View style={styles.center}>
        <react_native_1.Text style={styles.errorText}>{error !== null && error !== void 0 ? error : 'Unable to load share.'}</react_native_1.Text>
      </react_native_1.View>);
    }
    var expired = data.status !== 'active' || secs <= 0;
    return (<react_native_1.ScrollView contentContainerStyle={styles.root}>
      <react_native_1.View style={[styles.card, expired && styles.cardExpired]}>
        <react_native_1.View style={styles.iconRow}>
          <lucide_react_native_1.MapPin size={28} color={expired ? tokens_1.color.mute : tokens_1.color.deep}/>
        </react_native_1.View>

        <react_native_1.Text style={styles.userName}>{data.sharingUserName}</react_native_1.Text>
        <react_native_1.Text style={styles.label}>is sharing their approximate location</react_native_1.Text>

        <react_native_1.View style={styles.areaBox}>
          <lucide_react_native_1.MapPin size={14} color={tokens_1.color.mute}/>
          <react_native_1.Text style={styles.areaText}>{data.approximateArea}</react_native_1.Text>
        </react_native_1.View>

        {expired ? (<react_native_1.Text style={styles.expiredText}>This share has ended.</react_native_1.Text>) : (<react_native_1.View style={styles.countdownRow}>
            <lucide_react_native_1.Clock size={14} color={tokens_1.color.deep}/>
            <react_native_1.Text style={styles.countdown}>Ends in {formatCountdown(secs)}</react_native_1.Text>
          </react_native_1.View>)}

        {!expired && onMessage && (<react_native_1.Pressable style={styles.messageBtn} onPress={function () { return onMessage(data.sharingUserName); }}>
            <lucide_react_native_1.MessageCircle size={16} color="#fff"/>
            <react_native_1.Text style={styles.messageBtnText}>Message {data.sharingUserName}</react_native_1.Text>
          </react_native_1.Pressable>)}

        <react_native_1.Text style={styles.privacyNote}>
          Only approximate area is shared. Exact GPS is never visible.
        </react_native_1.Text>
      </react_native_1.View>
    </react_native_1.ScrollView>);
}
var styles = react_native_1.StyleSheet.create({
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: tokens_1.space.xl },
    loadingText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, marginTop: tokens_1.space.md }),
    errorText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute, textAlign: 'center' }),
    root: { padding: tokens_1.space.lg },
    card: {
        backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.lg,
        borderWidth: 1, borderColor: tokens_1.color.haze, padding: tokens_1.space.xl, alignItems: 'center', gap: tokens_1.space.md,
    },
    cardExpired: { opacity: 0.7 },
    iconRow: { marginBottom: tokens_1.space.sm },
    userName: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 18 }),
    label: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 13 }),
    areaBox: {
        flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm,
        backgroundColor: '#EAF2F4', borderRadius: tokens_1.radius.pill,
        paddingHorizontal: tokens_1.space.lg, paddingVertical: tokens_1.space.sm,
    },
    areaText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.deep, fontSize: 14 }),
    expiredText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontStyle: 'italic' }),
    countdownRow: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm },
    countdown: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.deep, fontSize: 14 }),
    messageBtn: {
        flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm,
        backgroundColor: tokens_1.color.deep, borderRadius: tokens_1.radius.md, paddingHorizontal: tokens_1.space.lg, paddingVertical: tokens_1.space.md,
    },
    messageBtnText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: '#fff', fontSize: 14 }),
    privacyNote: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11, textAlign: 'center', lineHeight: 16 }),
});
