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
exports.GeofenceSettingsSheet = GeofenceSettingsSheet;
/**
 * GeofenceSettingsSheet — host geofence configuration for plan meetups.
 * Only renders when plan_geofence_enabled feature flag is on.
 * Gated: shows nothing until featureEnabled=true from the API.
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../../theme/tokens");
var geofence_1 = require("../../services/geofence");
// ── Option maps ───────────────────────────────────────────────────────────────
var PREVIEW_OPTIONS = [
    { value: 'city_only', label: 'City only', desc: 'Guests see the city name only' },
    { value: 'neighborhood', label: 'Neighborhood', desc: 'Guests see the neighborhood area' },
    { value: 'venue_tagged', label: 'Venue tagged', desc: 'Guests see the venue name (no address)' },
];
var EXACT_VIS_OPTIONS = [
    { value: 'exact_after_acceptance', label: 'Reveal after acceptance', desc: 'Accepted guests see the full location immediately' },
    { value: 'exact_private_host_reveal', label: "I'll reveal it manually", desc: 'You reveal the exact location when ready' },
];
var RADIUS_PRESETS = [50, 100, 150, 250, 500];
// ── Main component ────────────────────────────────────────────────────────────
function GeofenceSettingsSheet(_a) {
    var _this = this;
    var _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
    var tripId = _a.tripId, isOwner = _a.isOwner, featureEnabled = _a.featureEnabled, existing = _a.existing, onClose = _a.onClose, onSaved = _a.onSaved;
    var _o = (0, react_1.useState)(String(existing ? '0' : '')), lat = _o[0], setLat = _o[1];
    var _p = (0, react_1.useState)(String(existing ? '0' : '')), lng = _p[0], setLng = _p[1];
    var _q = (0, react_1.useState)((_b = existing === null || existing === void 0 ? void 0 : existing.locationName) !== null && _b !== void 0 ? _b : ''), locationName = _q[0], setLocationName = _q[1];
    var _r = (0, react_1.useState)((_c = existing === null || existing === void 0 ? void 0 : existing.city) !== null && _c !== void 0 ? _c : ''), city = _r[0], setCity = _r[1];
    var _s = (0, react_1.useState)((_d = existing === null || existing === void 0 ? void 0 : existing.neighborhood) !== null && _d !== void 0 ? _d : ''), neighborhood = _s[0], setNeighborhood = _s[1];
    var _t = (0, react_1.useState)((_e = existing === null || existing === void 0 ? void 0 : existing.venueName) !== null && _e !== void 0 ? _e : ''), venueName = _t[0], setVenueName = _t[1];
    var _u = (0, react_1.useState)((_f = existing === null || existing === void 0 ? void 0 : existing.publicPreviewLevel) !== null && _f !== void 0 ? _f : 'neighborhood'), publicPreviewLevel = _u[0], setPublicPreviewLevel = _u[1];
    var _v = (0, react_1.useState)((_g = existing === null || existing === void 0 ? void 0 : existing.exactVisibility) !== null && _g !== void 0 ? _g : 'exact_after_acceptance'), exactVisibility = _v[0], setExactVisibility = _v[1];
    var _w = (0, react_1.useState)((_h = existing === null || existing === void 0 ? void 0 : existing.checkInRequired) !== null && _h !== void 0 ? _h : false), checkInRequired = _w[0], setCheckInRequired = _w[1];
    var _x = (0, react_1.useState)((_j = existing === null || existing === void 0 ? void 0 : existing.checkInRadiusM) !== null && _j !== void 0 ? _j : 150), radiusM = _x[0], setRadiusM = _x[1];
    var _y = (0, react_1.useState)((_k = existing === null || existing === void 0 ? void 0 : existing.arrivalStatusVisible) !== null && _k !== void 0 ? _k : true), arrivalStatusVisible = _y[0], setArrivalStatusVisible = _y[1];
    var _z = (0, react_1.useState)((_l = existing === null || existing === void 0 ? void 0 : existing.noShowAffectsReliability) !== null && _l !== void 0 ? _l : false), noShowAffectsReliability = _z[0], setNoShowAffectsReliability = _z[1];
    var _0 = (0, react_1.useState)((_m = existing === null || existing === void 0 ? void 0 : existing.hostEnabled) !== null && _m !== void 0 ? _m : true), hostEnabled = _0[0], setHostEnabled = _0[1];
    var _1 = (0, react_1.useState)(false), revealing = _1[0], setRevealing = _1[1];
    var _2 = (0, react_1.useState)(false), saving = _2[0], setSaving = _2[1];
    var _3 = (0, react_1.useState)(''), err = _3[0], setErr = _3[1];
    if (!featureEnabled || !isOwner)
        return null;
    var handleSave = function () { return __awaiter(_this, void 0, void 0, function () {
        var latN, lngN, e_1;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    latN = parseFloat(lat);
                    lngN = parseFloat(lng);
                    if (isNaN(latN) || isNaN(lngN)) {
                        setErr('Enter valid coordinates (lat/lng) for the meetup location.');
                        return [2 /*return*/];
                    }
                    setSaving(true);
                    setErr('');
                    _b.label = 1;
                case 1:
                    _b.trys.push([1, 3, 4, 5]);
                    return [4 /*yield*/, (0, geofence_1.setGeofence)(tripId, {
                            lat: latN,
                            lng: lngN,
                            locationName: locationName.trim() || null,
                            city: city.trim() || null,
                            neighborhood: neighborhood.trim() || null,
                            venueName: venueName.trim() || null,
                            publicPreviewLevel: publicPreviewLevel,
                            exactVisibility: exactVisibility,
                            checkInRequired: checkInRequired,
                            checkInRadiusM: radiusM,
                            arrivalStatusVisible: arrivalStatusVisible,
                            noShowAffectsReliability: noShowAffectsReliability,
                            hostEnabled: hostEnabled,
                        })];
                case 2:
                    _b.sent();
                    onSaved();
                    onClose();
                    return [3 /*break*/, 5];
                case 3:
                    e_1 = _b.sent();
                    setErr((_a = e_1.message) !== null && _a !== void 0 ? _a : 'Could not save geofence settings');
                    return [3 /*break*/, 5];
                case 4:
                    setSaving(false);
                    return [7 /*endfinally*/];
                case 5: return [2 /*return*/];
            }
        });
    }); };
    var handleReveal = function () {
        react_native_1.Alert.alert('Reveal exact location?', 'Accepted members will immediately see the exact meetup details.', [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Reveal now',
                onPress: function () { return __awaiter(_this, void 0, void 0, function () {
                    var e_2;
                    var _a;
                    return __generator(this, function (_b) {
                        switch (_b.label) {
                            case 0:
                                setRevealing(true);
                                _b.label = 1;
                            case 1:
                                _b.trys.push([1, 3, 4, 5]);
                                return [4 /*yield*/, (0, geofence_1.revealExactLocation)(tripId)];
                            case 2:
                                _b.sent();
                                react_native_1.Alert.alert('Location revealed', 'Accepted members can now see the exact meetup details.');
                                onSaved();
                                return [3 /*break*/, 5];
                            case 3:
                                e_2 = _b.sent();
                                react_native_1.Alert.alert('Error', (_a = e_2.message) !== null && _a !== void 0 ? _a : 'Could not reveal location');
                                return [3 /*break*/, 5];
                            case 4:
                                setRevealing(false);
                                return [7 /*endfinally*/];
                            case 5: return [2 /*return*/];
                        }
                    });
                }); },
            },
        ]);
    };
    return (<react_native_1.Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <react_native_1.KeyboardAvoidingView behavior={react_native_1.Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <react_native_1.Pressable style={s.overlay} onPress={onClose}/>
        <react_native_1.View style={s.sheet}>
          <react_native_1.View style={s.handle}/>

          <react_native_1.View style={s.header}>
            <lucide_react_native_1.Shield size={18} color={tokens_1.color.deep}/>
            <react_native_1.Text style={s.headerTitle}>Meetup Location Settings</react_native_1.Text>
            <react_native_1.Pressable onPress={onClose} hitSlop={8} style={{ marginLeft: 'auto' }}>
              <lucide_react_native_1.X size={20} color={tokens_1.color.mute}/>
            </react_native_1.Pressable>
          </react_native_1.View>

          <react_native_1.ScrollView contentContainerStyle={s.body} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">

            {/* Enable/disable toggle */}
            <react_native_1.View style={s.row}>
              <react_native_1.Text style={s.label}>Enable geofence for this trip</react_native_1.Text>
              <react_native_1.Switch value={hostEnabled} onValueChange={setHostEnabled} trackColor={{ true: tokens_1.color.deep }}/>
            </react_native_1.View>

            {hostEnabled && (<>
                {/* Exact meetup coordinates (private — never shown to guests) */}
                <react_native_1.View style={s.section}>
                  <react_native_1.View style={s.sectionHeader}>
                    <lucide_react_native_1.MapPin size={14} color={tokens_1.color.deep}/>
                    <react_native_1.Text style={s.sectionTitle}>Meetup coordinates</react_native_1.Text>
                    <react_native_1.Text style={s.badge}>Private</react_native_1.Text>
                  </react_native_1.View>
                  <react_native_1.Text style={s.sectionDesc}>These stay server-side only. Guests never see raw GPS coordinates.</react_native_1.Text>

                  <react_native_1.Text style={s.fieldLabel}>Latitude</react_native_1.Text>
                  <react_native_1.TextInput style={s.input} value={lat} onChangeText={setLat} keyboardType="decimal-pad" placeholder="e.g. 48.8566" placeholderTextColor={tokens_1.color.faint}/>

                  <react_native_1.Text style={s.fieldLabel}>Longitude</react_native_1.Text>
                  <react_native_1.TextInput style={s.input} value={lng} onChangeText={setLng} keyboardType="decimal-pad" placeholder="e.g. 2.3522" placeholderTextColor={tokens_1.color.faint}/>

                  <react_native_1.Text style={s.fieldLabel}>Venue / location name <react_native_1.Text style={s.opt}>(shown to accepted members)</react_native_1.Text></react_native_1.Text>
                  <react_native_1.TextInput style={s.input} value={locationName} onChangeText={setLocationName} placeholder="e.g. Le Labo Rooftop" placeholderTextColor={tokens_1.color.faint}/>
                </react_native_1.View>

                {/* Public location labels */}
                <react_native_1.View style={s.section}>
                  <react_native_1.View style={s.sectionHeader}>
                    <lucide_react_native_1.Eye size={14} color={tokens_1.color.deep}/>
                    <react_native_1.Text style={s.sectionTitle}>What non-accepted guests see</react_native_1.Text>
                  </react_native_1.View>
                  <react_native_1.Text style={s.fieldLabel}>City (for public preview)</react_native_1.Text>
                  <react_native_1.TextInput style={s.input} value={city} onChangeText={setCity} placeholder="e.g. Paris" placeholderTextColor={tokens_1.color.faint}/>
                  <react_native_1.Text style={s.fieldLabel}>Neighborhood <react_native_1.Text style={s.opt}>(optional)</react_native_1.Text></react_native_1.Text>
                  <react_native_1.TextInput style={s.input} value={neighborhood} onChangeText={setNeighborhood} placeholder="e.g. Le Marais" placeholderTextColor={tokens_1.color.faint}/>
                  <react_native_1.Text style={s.fieldLabel}>Venue tag <react_native_1.Text style={s.opt}>(optional)</react_native_1.Text></react_native_1.Text>
                  <react_native_1.TextInput style={s.input} value={venueName} onChangeText={setVenueName} placeholder="e.g. Rooftop bar" placeholderTextColor={tokens_1.color.faint}/>

                  <react_native_1.Text style={[s.fieldLabel, { marginTop: tokens_1.space.md }]}>Preview level for non-accepted guests</react_native_1.Text>
                  {PREVIEW_OPTIONS.map(function (opt) { return (<react_native_1.Pressable key={opt.value} style={[s.optionRow, publicPreviewLevel === opt.value && s.optionRowActive]} onPress={function () { return setPublicPreviewLevel(opt.value); }}>
                      <react_native_1.View style={s.radioOuter}>
                        {publicPreviewLevel === opt.value && <react_native_1.View style={s.radioInner}/>}
                      </react_native_1.View>
                      <react_native_1.View style={{ flex: 1 }}>
                        <react_native_1.Text style={[s.optionLabel, publicPreviewLevel === opt.value && s.optionLabelActive]}>{opt.label}</react_native_1.Text>
                        <react_native_1.Text style={s.optionDesc}>{opt.desc}</react_native_1.Text>
                      </react_native_1.View>
                    </react_native_1.Pressable>); })}
                </react_native_1.View>

                {/* Exact location visibility */}
                <react_native_1.View style={s.section}>
                  <react_native_1.View style={s.sectionHeader}>
                    <lucide_react_native_1.Eye size={14} color={tokens_1.color.deep}/>
                    <react_native_1.Text style={s.sectionTitle}>Exact location visibility for accepted guests</react_native_1.Text>
                  </react_native_1.View>
                  {EXACT_VIS_OPTIONS.map(function (opt) { return (<react_native_1.Pressable key={opt.value} style={[s.optionRow, exactVisibility === opt.value && s.optionRowActive]} onPress={function () { return setExactVisibility(opt.value); }}>
                      <react_native_1.View style={s.radioOuter}>
                        {exactVisibility === opt.value && <react_native_1.View style={s.radioInner}/>}
                      </react_native_1.View>
                      <react_native_1.View style={{ flex: 1 }}>
                        <react_native_1.Text style={[s.optionLabel, exactVisibility === opt.value && s.optionLabelActive]}>{opt.label}</react_native_1.Text>
                        <react_native_1.Text style={s.optionDesc}>{opt.desc}</react_native_1.Text>
                      </react_native_1.View>
                    </react_native_1.Pressable>); })}

                  {exactVisibility === 'exact_private_host_reveal' && (existing === null || existing === void 0 ? void 0 : existing.id) && !(existing === null || existing === void 0 ? void 0 : existing.hostRevealed) && (<react_native_1.Pressable style={[s.revealBtn, revealing && { opacity: 0.5 }]} onPress={handleReveal} disabled={revealing}>
                      <react_native_1.Text style={s.revealBtnText}>{revealing ? 'Revealing…' : 'Reveal exact location now'}</react_native_1.Text>
                    </react_native_1.Pressable>)}
                  {(existing === null || existing === void 0 ? void 0 : existing.hostRevealed) && (<react_native_1.Text style={s.revealedLabel}>✓ Exact location has been revealed to accepted members.</react_native_1.Text>)}
                </react_native_1.View>

                {/* Check-in settings */}
                <react_native_1.View style={s.section}>
                  <react_native_1.View style={s.sectionHeader}>
                    <lucide_react_native_1.Clock size={14} color={tokens_1.color.deep}/>
                    <react_native_1.Text style={s.sectionTitle}>Check-in settings</react_native_1.Text>
                  </react_native_1.View>

                  <react_native_1.View style={s.row}>
                    <react_native_1.View style={{ flex: 1 }}>
                      <react_native_1.Text style={s.optionLabel}>Require check-in</react_native_1.Text>
                      <react_native_1.Text style={s.optionDesc}>Members must check in to confirm attendance</react_native_1.Text>
                    </react_native_1.View>
                    <react_native_1.Switch value={checkInRequired} onValueChange={setCheckInRequired} trackColor={{ true: tokens_1.color.deep }}/>
                  </react_native_1.View>

                  {checkInRequired && (<>
                      <react_native_1.Text style={[s.fieldLabel, { marginTop: tokens_1.space.md }]}>Check-in radius</react_native_1.Text>
                      <react_native_1.View style={s.presetRow}>
                        {RADIUS_PRESETS.map(function (r) { return (<react_native_1.Pressable key={r} style={[s.presetChip, radiusM === r && s.presetChipActive]} onPress={function () { return setRadiusM(r); }}>
                            <react_native_1.Text style={[s.presetText, radiusM === r && s.presetTextActive]}>{r}m</react_native_1.Text>
                          </react_native_1.Pressable>); })}
                      </react_native_1.View>
                      <react_native_1.Text style={s.optionDesc}>Members must be within {radiusM}m of the meetup to check in.</react_native_1.Text>
                    </>)}
                </react_native_1.View>

                {/* Attendance visibility */}
                <react_native_1.View style={s.section}>
                  <react_native_1.View style={s.sectionHeader}>
                    <lucide_react_native_1.Users size={14} color={tokens_1.color.deep}/>
                    <react_native_1.Text style={s.sectionTitle}>Attendance visibility</react_native_1.Text>
                  </react_native_1.View>

                  <react_native_1.View style={s.row}>
                    <react_native_1.View style={{ flex: 1 }}>
                      <react_native_1.Text style={s.optionLabel}>Show arrival status to attendees</react_native_1.Text>
                      <react_native_1.Text style={s.optionDesc}>Attendees see each other's status (Arrived, On the way, etc.) — no map pins</react_native_1.Text>
                    </react_native_1.View>
                    <react_native_1.Switch value={arrivalStatusVisible} onValueChange={setArrivalStatusVisible} trackColor={{ true: tokens_1.color.deep }}/>
                  </react_native_1.View>

                  <react_native_1.View style={[s.row, { marginTop: tokens_1.space.md }]}>
                    <react_native_1.View style={{ flex: 1 }}>
                      <react_native_1.Text style={s.optionLabel}>Record late / no-show</react_native_1.Text>
                      <react_native_1.Text style={s.optionDesc}>No-shows are recorded for future reliability features (never auto-penalised now)</react_native_1.Text>
                    </react_native_1.View>
                    <react_native_1.Switch value={noShowAffectsReliability} onValueChange={setNoShowAffectsReliability} trackColor={{ true: tokens_1.color.deep }}/>
                  </react_native_1.View>
                </react_native_1.View>
              </>)}

            {err ? <react_native_1.Text style={s.errText}>{err}</react_native_1.Text> : null}

            <react_native_1.Pressable style={[s.saveBtn, saving && { opacity: 0.5 }]} onPress={handleSave} disabled={saving}>
              <react_native_1.Text style={s.saveBtnText}>{saving ? 'Saving…' : 'Save Geofence Settings'}</react_native_1.Text>
            </react_native_1.Pressable>
          </react_native_1.ScrollView>
        </react_native_1.View>
      </react_native_1.KeyboardAvoidingView>
    </react_native_1.Modal>);
}
// ── Styles ────────────────────────────────────────────────────────────────────
var s = react_native_1.StyleSheet.create({
    overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
    sheet: { backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '93%' },
    handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: tokens_1.color.haze, alignSelf: 'center', marginTop: 10, marginBottom: 4 },
    header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: tokens_1.space.lg, paddingVertical: tokens_1.space.md, borderBottomWidth: 1, borderBottomColor: tokens_1.color.haze },
    headerTitle: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, fontWeight: '700', fontSize: 16 }),
    body: { paddingHorizontal: tokens_1.space.lg, paddingBottom: 48, gap: 4 },
    section: { backgroundColor: '#F8F7F4', borderRadius: tokens_1.radius.md, padding: tokens_1.space.md, gap: 8, marginTop: tokens_1.space.md },
    sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    sectionTitle: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, fontWeight: '700' }),
    sectionDesc: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    badge: __assign(__assign({ backgroundColor: '#E3F1EA', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }, tokens_1.type.small), { color: tokens_1.color.success, fontWeight: '700', marginLeft: 'auto' }),
    row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    label: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, fontWeight: '600', flex: 1 }),
    fieldLabel: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontWeight: '600' }),
    opt: { fontWeight: '400', color: tokens_1.color.faint },
    input: __assign(__assign({ backgroundColor: '#fff', borderWidth: 1, borderColor: tokens_1.color.haze, borderRadius: tokens_1.radius.sm, padding: 10 }, tokens_1.type.body), { color: tokens_1.color.ink }),
    optionRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, padding: 10, borderRadius: tokens_1.radius.sm, backgroundColor: '#fff', borderWidth: 1, borderColor: tokens_1.color.haze },
    optionRowActive: { borderColor: tokens_1.color.deep, backgroundColor: '#EFF5F7' },
    radioOuter: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: tokens_1.color.mute, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
    radioInner: { width: 8, height: 8, borderRadius: 4, backgroundColor: tokens_1.color.deep },
    optionLabel: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, fontWeight: '600' }),
    optionLabelActive: { color: tokens_1.color.deep },
    optionDesc: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    presetRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 2 },
    presetChip: { borderRadius: 20, paddingHorizontal: 14, paddingVertical: 7, backgroundColor: tokens_1.color.haze },
    presetChipActive: { backgroundColor: tokens_1.color.deep },
    presetText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontWeight: '600' }),
    presetTextActive: { color: '#fff' },
    revealBtn: { backgroundColor: tokens_1.color.signal, borderRadius: tokens_1.radius.sm, padding: 11, alignItems: 'center', marginTop: 8 },
    revealBtnText: __assign(__assign({}, tokens_1.type.body), { color: '#fff', fontWeight: '700' }),
    revealedLabel: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.success, fontWeight: '600' }),
    errText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, marginTop: 4 }),
    saveBtn: { backgroundColor: tokens_1.color.deep, borderRadius: tokens_1.radius.md, padding: 14, alignItems: 'center', marginTop: tokens_1.space.lg },
    saveBtnText: __assign(__assign({}, tokens_1.type.body), { color: '#fff', fontWeight: '700' }),
});
