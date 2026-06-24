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
exports.default = AvailabilityScreen;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var lucide_react_native_1 = require("lucide-react-native");
var ScreenHeader_1 = require("../src/components/ScreenHeader");
var AvailabilityStore_1 = require("../src/context/AvailabilityStore");
var availability_1 = require("../src/lib/availability");
var tokens_1 = require("../src/theme/tokens");
var DAYS = [
    { key: 'mon', label: 'Mon' }, { key: 'tue', label: 'Tue' }, { key: 'wed', label: 'Wed' },
    { key: 'thu', label: 'Thu' }, { key: 'fri', label: 'Fri' }, { key: 'sat', label: 'Sat' }, { key: 'sun', label: 'Sun' },
];
var BLOCKS = [
    { key: 'morning', label: 'Morning', time: '08:00–12:00' },
    { key: 'afternoon', label: 'Afternoon', time: '12:00–17:00' },
    { key: 'evening', label: 'Evening', time: '17:00–22:00' },
    { key: 'late', label: 'Late', time: '22:00–02:00' },
];
var PRESETS = [
    { label: 'Weeknights', build: function () { return Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri'].map(function (d) { return [d, ['evening']]; })); } },
    { label: 'Weekends', build: function () { return ({ sat: ['morning', 'afternoon', 'evening', 'late'], sun: ['morning', 'afternoon', 'evening'] }); } },
    { label: 'Evenings', build: function () { return Object.fromEntries(DAYS.map(function (d) { return [d.key, ['evening']]; })); } },
    { label: 'Late nights', build: function () { return Object.fromEntries(['fri', 'sat'].map(function (d) { return [d, ['evening', 'late']]; })); } },
    { label: 'Flexible', build: function () { return Object.fromEntries(DAYS.map(function (d) { return [d.key, ['morning', 'afternoon', 'evening', 'late']]; })); } },
];
var QUICK_PILLS = [
    { key: 'free_now', label: 'Free now', emoji: '🟢' },
    { key: 'free_tonight', label: 'Free tonight', emoji: '🌙' },
    { key: 'open_to_plans', label: 'Open to plans', emoji: '✨' },
    { key: 'busy', label: 'Busy', emoji: '🔴' },
];
function summarize(days) {
    var active = DAYS.filter(function (d) { var _a, _b; return ((_b = (_a = days[d.key]) === null || _a === void 0 ? void 0 : _a.length) !== null && _b !== void 0 ? _b : 0) > 0; });
    if (active.length === 0)
        return 'No weekly availability set yet.';
    var labels = active.map(function (d) { return d.label; }).join('/');
    var eveningish = active.every(function (d) { var _a; return ((_a = days[d.key]) !== null && _a !== void 0 ? _a : []).every(function (b) { return b === 'evening' || b === 'late'; }); });
    return "Usually free ".concat(labels).concat(eveningish ? ' evenings' : '', ".");
}
function AvailabilityScreen() {
    var _a, _b;
    var _c = (0, AvailabilityStore_1.useAvailabilityStore)(), availability = _c.availability, toggleBlock = _c.toggleBlock, applyWeekly = _c.applyWeekly, clearWeekly = _c.clearWeekly, setOpenToMeet = _c.setOpenToMeet, removeTripWindow = _c.removeTripWindow, save = _c.save, saving = _c.saving, saveError = _c.saveError, quickStatus = _c.quickStatus, setQuickStatus = _c.setQuickStatus;
    var days = (_b = (_a = availability.weekly) === null || _a === void 0 ? void 0 : _a.days) !== null && _b !== void 0 ? _b : {};
    var _d = (0, react_1.useState)(false), saved = _d[0], setSaved = _d[1];
    var _e = (0, react_1.useState)(null), settingQuick = _e[0], setSettingQuick = _e[1];
    var status = (0, availability_1.resolveStatus)(availability, new Date().toISOString(), 'cebu');
    function onSave() {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, save()];
                    case 1:
                        _a.sent();
                        if (!saveError) {
                            setSaved(true);
                            setTimeout(function () { return setSaved(false); }, 1800);
                        }
                        return [2 /*return*/];
                }
            });
        });
    }
    function onQuickPill(key) {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        setSettingQuick(key);
                        return [4 /*yield*/, setQuickStatus(key)];
                    case 1:
                        _a.sent();
                        setSettingQuick(null);
                        return [2 /*return*/];
                }
            });
        });
    }
    return (<react_native_1.View style={{ flex: 1, backgroundColor: tokens_1.color.paper }}>
      <ScreenHeader_1.ScreenHeader title="Availability" back/>
      <react_native_1.ScrollView contentContainerStyle={{ padding: tokens_1.space.lg, gap: tokens_1.space.xl, paddingBottom: tokens_1.space.xxxl }} showsVerticalScrollIndicator={false}>

        {/* Current status */}
        <react_native_1.View style={s.statusCard}>
          <react_native_1.View style={s.statusIcon}><lucide_react_native_1.CalendarClock size={20} color={tokens_1.color.deep}/></react_native_1.View>
          <react_native_1.View style={{ flex: 1 }}>
            <react_native_1.Text style={s.statusLabel}>Current status</react_native_1.Text>
            <react_native_1.Text style={s.statusValue}>{availability_1.STATUS_LABEL[status]}</react_native_1.Text>
          </react_native_1.View>
          <react_native_1.Pressable style={[s.toggle, availability.openToMeet && s.toggleOn]} onPress={function () { return setOpenToMeet(!availability.openToMeet); }}>
            <react_native_1.View style={[s.knob, availability.openToMeet && s.knobOn]}/>
          </react_native_1.Pressable>
        </react_native_1.View>
        <react_native_1.Text style={s.toggleHint}>{availability.openToMeet ? 'Open to meet — shown on your Passport.' : 'Turn on "Open to meet" to let travelers know you\'re around.'}</react_native_1.Text>

        {/* Quick status pills */}
        <react_native_1.View>
          <react_native_1.View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: tokens_1.space.sm }}>
            <lucide_react_native_1.Zap size={13} color={tokens_1.color.signal} fill={tokens_1.color.signal}/>
            <react_native_1.Text style={s.h2}>Quick status</react_native_1.Text>
          </react_native_1.View>
          <react_native_1.Text style={s.sub}>Tap to set a status that expires automatically.</react_native_1.Text>
          <react_native_1.View style={s.quickRow}>
            {QUICK_PILLS.map(function (p) {
            var isActive = quickStatus === p.key;
            var isLoading = settingQuick === p.key;
            return (<react_native_1.Pressable key={p.key} style={[s.quickPill, isActive && s.quickPillActive]} onPress={function () { return onQuickPill(p.key); }} disabled={settingQuick !== null}>
                  {isLoading
                    ? <react_native_1.ActivityIndicator size="small" color={isActive ? tokens_1.color.onInk : tokens_1.color.signal}/>
                    : <react_native_1.Text style={s.quickPillEmoji}>{p.emoji}</react_native_1.Text>}
                  <react_native_1.Text style={[s.quickPillText, isActive && s.quickPillTextActive]}>{p.label}</react_native_1.Text>
                </react_native_1.Pressable>);
        })}
          </react_native_1.View>
        </react_native_1.View>

        {/* Weekly rhythm */}
        <react_native_1.View>
          <react_native_1.Text style={s.h2}>Weekly rhythm</react_native_1.Text>
          <react_native_1.Text style={s.sub}>Tap to mark when you're usually free. Approximate — not exact scheduling.</react_native_1.Text>

          <react_native_1.ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.presets}>
            {PRESETS.map(function (p) { return (<react_native_1.Pressable key={p.label} style={s.preset} onPress={function () { return applyWeekly(p.build()); }}>
                <react_native_1.Text style={s.presetText}>{p.label}</react_native_1.Text>
              </react_native_1.Pressable>); })}
            <react_native_1.Pressable style={[s.preset, s.presetClear]} onPress={clearWeekly}>
              <react_native_1.Text style={[s.presetText, { color: tokens_1.color.signal }]}>Clear</react_native_1.Text>
            </react_native_1.Pressable>
          </react_native_1.ScrollView>

          <react_native_1.View style={s.grid}>
            <react_native_1.View style={s.gridHeadRow}>
              <react_native_1.View style={s.dayCell}/>
              {BLOCKS.map(function (b) { return <react_native_1.Text key={b.key} style={s.colHead}>{b.label}</react_native_1.Text>; })}
            </react_native_1.View>
            {DAYS.map(function (d) { return (<react_native_1.View key={d.key} style={s.gridRow}>
                <react_native_1.Text style={s.dayLabel}>{d.label}</react_native_1.Text>
                {BLOCKS.map(function (b) {
                var _a;
                var on = ((_a = days[d.key]) !== null && _a !== void 0 ? _a : []).includes(b.key);
                return (<react_native_1.Pressable key={b.key} style={[s.cell, on && s.cellOn]} onPress={function () { return toggleBlock(d.key, b.key); }}>
                      {on ? <lucide_react_native_1.Check size={14} color={tokens_1.color.onInk}/> : null}
                    </react_native_1.Pressable>);
            })}
              </react_native_1.View>); })}
          </react_native_1.View>

          <react_native_1.View style={s.summaryRow}>
            <lucide_react_native_1.Sparkles size={13} color={tokens_1.color.deep}/>
            <react_native_1.Text style={s.summary}>{summarize(days)}</react_native_1.Text>
          </react_native_1.View>
          <react_native_1.Text style={s.blockLegend}>{BLOCKS.map(function (b) { return "".concat(b.label, " ").concat(b.time); }).join('   ·   ')}</react_native_1.Text>
        </react_native_1.View>

        {/* Trip windows */}
        <react_native_1.View>
          <react_native_1.View style={s.tripHead}>
            <react_native_1.Text style={s.h2}>Trip windows</react_native_1.Text>
            <react_native_1.View style={{ flex: 1 }}/>
            <react_native_1.Pressable style={s.addTrip} onPress={function () { return expo_router_1.router.push('/trip/new'); }}>
              <lucide_react_native_1.Plus size={14} color={tokens_1.color.signal}/><react_native_1.Text style={s.addTripText}>Add</react_native_1.Text>
            </react_native_1.Pressable>
          </react_native_1.View>
          <react_native_1.Text style={s.sub}>Availability tied to a trip's city + dates — overrides your weekly rhythm while you're there.</react_native_1.Text>

          {availability.trips.length === 0 ? (<react_native_1.View style={s.tripEmpty}>
              <react_native_1.Text style={s.tripEmptyText}>No trip windows yet. Add one when you're planning a trip — e.g. "Cebu, Jun 20–27, evenings."</react_native_1.Text>
            </react_native_1.View>) : (<react_native_1.View style={{ gap: tokens_1.space.sm }}>
              {availability.trips.map(function (w) { return (<react_native_1.View key={w.id} style={s.tripCard}>
                  <react_native_1.View style={s.tripIcon}><lucide_react_native_1.MapPin size={16} color={tokens_1.color.deep}/></react_native_1.View>
                  <react_native_1.View style={{ flex: 1 }}>
                    <react_native_1.Text style={s.tripCity}>{w.citySlug}</react_native_1.Text>
                    <react_native_1.Text style={s.tripMeta}>{w.startDate.slice(0, 10)} – {w.endDate.slice(0, 10)} · {w.blocks.join(', ') || 'flexible'}</react_native_1.Text>
                  </react_native_1.View>
                  <react_native_1.Pressable hitSlop={tokens_1.layout.hitSlop} onPress={function () { return removeTripWindow(w.id); }}><lucide_react_native_1.Trash2 size={17} color={tokens_1.color.mute}/></react_native_1.Pressable>
                </react_native_1.View>); })}
            </react_native_1.View>)}
        </react_native_1.View>

        {/* Save */}
        {saveError ? <react_native_1.Text style={s.errorText}>{saveError}</react_native_1.Text> : null}
        <react_native_1.View style={s.saveRow}>
          <react_native_1.Pressable style={s.cancel} onPress={function () { return expo_router_1.router.back(); }}><react_native_1.Text style={s.cancelText}>Cancel</react_native_1.Text></react_native_1.Pressable>
          <react_native_1.Pressable style={[s.save, saving && { opacity: 0.6 }]} onPress={onSave} disabled={saving}>
            {saving
            ? <react_native_1.ActivityIndicator size="small" color={tokens_1.color.onInk}/>
            : saved ? <lucide_react_native_1.Check size={16} color={tokens_1.color.onInk}/> : null}
            <react_native_1.Text style={s.saveText}>{saved ? 'Saved!' : 'Save'}</react_native_1.Text>
          </react_native_1.Pressable>
        </react_native_1.View>
      </react_native_1.ScrollView>
    </react_native_1.View>);
}
var s = react_native_1.StyleSheet.create({
    statusCard: __assign({ flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.md, backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, padding: tokens_1.space.md }, tokens_1.shadow.card),
    statusIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#E2EDF0', alignItems: 'center', justifyContent: 'center' },
    statusLabel: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
    statusValue: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 16 }),
    toggle: { width: 48, height: 28, borderRadius: 14, backgroundColor: tokens_1.color.haze, padding: 3, justifyContent: 'center' },
    toggleOn: { backgroundColor: tokens_1.color.signal },
    knob: { width: 22, height: 22, borderRadius: 11, backgroundColor: tokens_1.color.paperRaised },
    knobOn: { alignSelf: 'flex-end' },
    toggleHint: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, marginTop: -tokens_1.space.md }),
    h2: __assign(__assign({}, tokens_1.type.title), { color: tokens_1.color.ink, fontSize: 18 }),
    sub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, marginTop: 2, marginBottom: tokens_1.space.md }),
    quickRow: { flexDirection: 'row', flexWrap: 'wrap', gap: tokens_1.space.sm },
    quickPill: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: tokens_1.space.md, paddingVertical: tokens_1.space.sm + 2, borderRadius: tokens_1.radius.pill, borderWidth: 1, borderColor: tokens_1.color.haze, backgroundColor: tokens_1.color.paperRaised, minHeight: 40 },
    quickPillActive: { backgroundColor: tokens_1.color.signal, borderColor: tokens_1.color.signal },
    quickPillEmoji: { fontSize: 14 },
    quickPillText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', color: tokens_1.color.ink }),
    quickPillTextActive: { color: tokens_1.color.onInk },
    presets: { gap: tokens_1.space.sm, paddingBottom: tokens_1.space.md },
    preset: { paddingHorizontal: tokens_1.space.md, paddingVertical: tokens_1.space.sm, borderRadius: tokens_1.radius.pill, borderWidth: 1, borderColor: tokens_1.color.haze, backgroundColor: tokens_1.color.paperRaised },
    presetClear: { borderColor: tokens_1.color.signal },
    presetText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', color: tokens_1.color.ink }),
    grid: { backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, padding: tokens_1.space.sm, gap: 4 },
    gridHeadRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    colHead: __assign(__assign({ flex: 1, textAlign: 'center' }, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 10, fontWeight: '700' }),
    gridRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    dayCell: { width: 38 },
    dayLabel: __assign(__assign({ width: 38 }, tokens_1.type.small), { color: tokens_1.color.ink, fontWeight: '700', fontSize: 12 }),
    cell: { flex: 1, height: 38, borderRadius: tokens_1.radius.sm, backgroundColor: tokens_1.color.paper, borderWidth: 1, borderColor: tokens_1.color.haze, alignItems: 'center', justifyContent: 'center' },
    cellOn: { backgroundColor: tokens_1.color.signal, borderColor: tokens_1.color.signal },
    summaryRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: tokens_1.space.md },
    summary: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 13 }),
    blockLegend: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.faint, fontSize: 10, marginTop: 4 }),
    tripHead: { flexDirection: 'row', alignItems: 'center' },
    addTrip: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: tokens_1.space.md, paddingVertical: 6, borderRadius: tokens_1.radius.sm, borderWidth: 1, borderColor: tokens_1.color.haze },
    addTripText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', color: tokens_1.color.signal }),
    tripEmpty: { backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, borderStyle: 'dashed', padding: tokens_1.space.lg },
    tripEmptyText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    tripCard: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.md, backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, padding: tokens_1.space.md },
    tripIcon: { width: 34, height: 34, borderRadius: 17, backgroundColor: '#E2EDF0', alignItems: 'center', justifyContent: 'center' },
    tripCity: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, textTransform: 'capitalize' }),
    tripMeta: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
    errorText: __assign(__assign({}, tokens_1.type.small), { color: '#DC2626', textAlign: 'center' }),
    saveRow: { flexDirection: 'row', gap: tokens_1.space.md },
    cancel: { flex: 1, borderWidth: 1, borderColor: tokens_1.color.haze, borderRadius: tokens_1.radius.md, paddingVertical: tokens_1.space.md, alignItems: 'center' },
    cancelText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink }),
    save: { flex: 2, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: tokens_1.color.signal, borderRadius: tokens_1.radius.md, paddingVertical: tokens_1.space.md },
    saveText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.onInk }),
});
