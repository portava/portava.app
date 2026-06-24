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
exports.PlanCheckInView = PlanCheckInView;
/**
 * PlanCheckInView — check-in UI for accepted members at a geofenced meetup.
 * Shows location label, check-in button, distance/nearby text, and arrival status.
 * Never displays exact GPS coordinates.
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var Location = require("expo-location");
var tokens_1 = require("../../theme/tokens");
var geofence_1 = require("../../services/geofence");
// ── Status display ─────────────────────────────────────────────────────────────
var STATUS_CONFIG = {
    not_checked_in: { label: 'Not checked in', color: tokens_1.color.mute, bg: tokens_1.color.haze },
    on_the_way: { label: 'On the way', color: '#B07000', bg: '#FFF8E7' },
    nearby: { label: 'Nearby', color: tokens_1.color.deep, bg: '#E2EDF0' },
    arrived: { label: 'Arrived ✓', color: tokens_1.color.success, bg: '#E3F1EA' },
    late: { label: 'Arrived (late)', color: '#B07000', bg: '#FFF8E7' },
    no_show: { label: 'No-show', color: tokens_1.color.signal, bg: '#FDEAEA' },
    left: { label: 'Left', color: tokens_1.color.mute, bg: tokens_1.color.haze },
};
// ── Component ─────────────────────────────────────────────────────────────────
function PlanCheckInView(_a) {
    var _this = this;
    var _b, _c, _d, _e, _f;
    var tripId = _a.tripId, geofence = _a.geofence, isAcceptedMember = _a.isAcceptedMember, onStatusChange = _a.onStatusChange;
    var _g = (0, react_1.useState)(false), loading = _g[0], setLoading = _g[1];
    var _h = (0, react_1.useState)((_b = geofence.myCheckInStatus) !== null && _b !== void 0 ? _b : 'not_checked_in'), localStatus = _h[0], setLocalStatus = _h[1];
    var hasCheckedIn = localStatus === 'arrived' || localStatus === 'late';
    var handleCheckIn = function () { return __awaiter(_this, void 0, void 0, function () {
        var permStatus, loc, result, newStatus, e_1;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    setLoading(true);
                    _b.label = 1;
                case 1:
                    _b.trys.push([1, 5, 6, 7]);
                    return [4 /*yield*/, Location.requestForegroundPermissionsAsync()];
                case 2:
                    permStatus = (_b.sent()).status;
                    if (permStatus !== 'granted') {
                        react_native_1.Alert.alert('Location access needed', 'Please allow location access so we can verify you are at the meetup.');
                        return [2 /*return*/];
                    }
                    return [4 /*yield*/, Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High })];
                case 3:
                    loc = _b.sent();
                    return [4 /*yield*/, (0, geofence_1.checkIn)(tripId, loc.coords.latitude, loc.coords.longitude)];
                case 4:
                    result = _b.sent();
                    if (result.ok && result.status) {
                        newStatus = result.status;
                        setLocalStatus(newStatus);
                        onStatusChange === null || onStatusChange === void 0 ? void 0 : onStatusChange(newStatus);
                        react_native_1.Alert.alert('Checked in!', result.message);
                    }
                    else {
                        react_native_1.Alert.alert(result.reason === 'outside_radius' ? 'Not close enough' :
                            result.reason === 'window_not_open' ? 'Too early' :
                                result.reason === 'window_closed' ? 'Check-in closed' :
                                    result.reason === 'suspicious_gps' ? 'Location issue' : 'Check-in failed', result.message);
                    }
                    return [3 /*break*/, 7];
                case 5:
                    e_1 = _b.sent();
                    react_native_1.Alert.alert('Error', (_a = e_1.message) !== null && _a !== void 0 ? _a : 'Check-in failed');
                    return [3 /*break*/, 7];
                case 6:
                    setLoading(false);
                    return [7 /*endfinally*/];
                case 7: return [2 /*return*/];
            }
        });
    }); };
    // Non-members see only the public preview card
    if (!isAcceptedMember) {
        return <PublicPreviewCard geofence={geofence}/>;
    }
    var cfg = (_c = STATUS_CONFIG[localStatus]) !== null && _c !== void 0 ? _c : STATUS_CONFIG.not_checked_in;
    // Window info
    var now = new Date();
    var windowOpen = !geofence.checkInWindowStart || new Date(geofence.checkInWindowStart) <= now;
    var windowClosed = geofence.checkInWindowEnd && new Date(geofence.checkInWindowEnd) < now;
    var canCheckIn = geofence.checkInRequired && !hasCheckedIn && windowOpen && !windowClosed;
    return (<react_native_1.View style={s.wrap}>
      {/* Location label */}
      {geofence.exactLocationRevealed ? (<react_native_1.View style={s.locationCard}>
          <lucide_react_native_1.MapPin size={16} color={tokens_1.color.deep}/>
          <react_native_1.View style={{ flex: 1 }}>
            <react_native_1.Text style={s.locationLabel}>Meetup location</react_native_1.Text>
            <react_native_1.Text style={s.locationValue}>{(_e = (_d = geofence.locationLabel) !== null && _d !== void 0 ? _d : geofence.locationName) !== null && _e !== void 0 ? _e : 'Location shared'}</react_native_1.Text>
            {geofence.city && <react_native_1.Text style={s.locationSub}>{geofence.neighborhood ? "".concat(geofence.neighborhood, ", ") : ''}{geofence.city}</react_native_1.Text>}
          </react_native_1.View>
        </react_native_1.View>) : (<react_native_1.View style={s.hiddenCard}>
          <lucide_react_native_1.Info size={15} color={tokens_1.color.mute}/>
          <react_native_1.Text style={s.hiddenText}>{(_f = geofence.locationLabel) !== null && _f !== void 0 ? _f : 'Exact meetup revealed after acceptance'}</react_native_1.Text>
        </react_native_1.View>)}

      {/* My arrival status */}
      <react_native_1.View style={s.statusRow}>
        <react_native_1.Text style={s.statusHeading}>Your status</react_native_1.Text>
        <react_native_1.View style={[s.statusChip, { backgroundColor: cfg.bg }]}>
          <react_native_1.Text style={[s.statusText, { color: cfg.color }]}>{cfg.label}</react_native_1.Text>
        </react_native_1.View>
      </react_native_1.View>

      {/* Check-in window info */}
      {geofence.checkInRequired && (<react_native_1.View style={s.windowRow}>
          <lucide_react_native_1.Clock size={13} color={tokens_1.color.mute}/>
          {windowClosed ? (<react_native_1.Text style={s.windowText}>Check-in window has closed</react_native_1.Text>) : !windowOpen ? (<react_native_1.Text style={s.windowText}>
              Check-in opens {geofence.checkInWindowStart ? new Date(geofence.checkInWindowStart).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'soon'}
            </react_native_1.Text>) : geofence.checkInWindowEnd ? (<react_native_1.Text style={s.windowText}>
              Check-in closes at {new Date(geofence.checkInWindowEnd).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </react_native_1.Text>) : (<react_native_1.Text style={s.windowText}>Check-in is open</react_native_1.Text>)}
        </react_native_1.View>)}

      {/* Check-in button */}
      {geofence.checkInRequired && !hasCheckedIn && (<react_native_1.Pressable style={[s.checkInBtn, (!canCheckIn || loading) && s.checkInBtnDim]} onPress={canCheckIn ? handleCheckIn : undefined} disabled={!canCheckIn || loading}>
          {loading ? (<react_native_1.ActivityIndicator color="#fff" size="small"/>) : (<>
              <lucide_react_native_1.Navigation size={16} color="#fff"/>
              <react_native_1.Text style={s.checkInBtnText}>
                {windowClosed ? 'Check-in closed' : !windowOpen ? 'Check-in not open yet' : 'Check in now'}
              </react_native_1.Text>
            </>)}
        </react_native_1.Pressable>)}

      {hasCheckedIn && (<react_native_1.View style={s.arrivedRow}>
          <lucide_react_native_1.CheckCircle2 size={18} color={tokens_1.color.success}/>
          <react_native_1.Text style={s.arrivedText}>You're checked in! See you there.</react_native_1.Text>
        </react_native_1.View>)}

      {/* Peer arrival status (if host allows it) */}
      {geofence.arrivalStatusVisible && (<react_native_1.Text style={s.peerNote}>Arrival statuses are visible to all accepted members (no map pins).</react_native_1.Text>)}
    </react_native_1.View>);
}
// ── Public preview card ───────────────────────────────────────────────────────
function PublicPreviewCard(_a) {
    var _b, _c, _d, _e, _f, _g;
    var geofence = _a.geofence;
    var previewText = geofence.publicPreviewLevel === 'city_only' ? (_b = geofence.city) !== null && _b !== void 0 ? _b : 'City not disclosed' :
        geofence.publicPreviewLevel === 'venue_tagged' ? ((_e = (_d = (_c = geofence.venueName) !== null && _c !== void 0 ? _c : geofence.neighborhood) !== null && _d !== void 0 ? _d : geofence.city) !== null && _e !== void 0 ? _e : 'General area') :
            geofence.neighborhood ? "".concat(geofence.neighborhood).concat(geofence.city ? ", ".concat(geofence.city) : '') :
                (_f = geofence.city) !== null && _f !== void 0 ? _f : 'General area';
    return (<react_native_1.View style={s.publicCard}>
      <lucide_react_native_1.MapPin size={16} color={tokens_1.color.mute}/>
      <react_native_1.View style={{ flex: 1 }}>
        <react_native_1.Text style={s.publicLabel}>{previewText}</react_native_1.Text>
        <react_native_1.Text style={s.publicSub}>{(_g = geofence.exactRevealLabel) !== null && _g !== void 0 ? _g : 'Exact meetup revealed after acceptance'}</react_native_1.Text>
      </react_native_1.View>
    </react_native_1.View>);
}
// ── Styles ────────────────────────────────────────────────────────────────────
var s = react_native_1.StyleSheet.create({
    wrap: { gap: 10, padding: tokens_1.space.md, backgroundColor: '#F8F7F4', borderRadius: tokens_1.radius.md },
    locationCard: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, backgroundColor: '#E2EDF0', borderRadius: tokens_1.radius.sm, padding: 12 },
    locationLabel: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.deep, fontWeight: '700' }),
    locationValue: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, fontWeight: '600', marginTop: 2 }),
    locationSub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, marginTop: 1 }),
    hiddenCard: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: tokens_1.color.haze, borderRadius: tokens_1.radius.sm, padding: 12 },
    hiddenText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, flex: 1, lineHeight: 18 }),
    statusRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    statusHeading: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontWeight: '600' }),
    statusChip: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 },
    statusText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700' }),
    windowRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    windowText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    checkInBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: tokens_1.color.deep, borderRadius: tokens_1.radius.md, padding: 13 },
    checkInBtnDim: { opacity: 0.5 },
    checkInBtnText: __assign(__assign({}, tokens_1.type.body), { color: '#fff', fontWeight: '700' }),
    arrivedRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    arrivedText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.success, fontWeight: '600' }),
    peerNote: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.faint, lineHeight: 16 }),
    publicCard: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, backgroundColor: tokens_1.color.haze, borderRadius: tokens_1.radius.sm, padding: 12 },
    publicLabel: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, fontWeight: '600' }),
    publicSub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, marginTop: 2 }),
});
