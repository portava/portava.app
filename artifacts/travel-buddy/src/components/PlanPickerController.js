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
exports.PlanPickerControllerProvider = PlanPickerControllerProvider;
exports.usePlanPicker = usePlanPicker;
/**
 * PlanPickerController — global "Add to Trip Plan" flow.
 *
 * Two-step sheet:
 *   Step 1 — Pick a trip (only trips where the user has plan-edit permission)
 *   Step 2 — Optional day / time selector → Confirm
 *
 * Usage: call `usePlanPicker().open(source)` from any card.
 * Track whether a source was already added with `usePlanPicker().isAdded(sourceId)`.
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var react_native_safe_area_context_1 = require("react-native-safe-area-context");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../theme/tokens");
var tripPlan_1 = require("../services/tripPlan");
var SessionContext_1 = require("../context/SessionContext");
var DateTimePickerField_1 = require("./DateTimePickerField");
var PlanPickerContext = (0, react_1.createContext)(null);
// ── Category mapping ──────────────────────────────────────────────────────────
function sourceToCategory(type) {
    if (type === 'meetup')
        return 'meeting_point';
    if (type === 'dining')
        return 'dining';
    if (type === 'transport')
        return 'transport';
    if (type === 'accommodation')
        return 'accommodation';
    return 'activity';
}
// ── Date helpers ──────────────────────────────────────────────────────────────
function dateToDayStr(d) {
    var y = d.getFullYear();
    var mo = String(d.getMonth() + 1).padStart(2, '0');
    var dy = String(d.getDate()).padStart(2, '0');
    return "".concat(y, "-").concat(mo, "-").concat(dy);
}
function dateToHHMM(d) {
    return "".concat(String(d.getHours()).padStart(2, '0'), ":").concat(String(d.getMinutes()).padStart(2, '0'));
}
function buildTimestamp(date, time) {
    if (!date || !time)
        return undefined;
    return "".concat(dateToDayStr(date), "T").concat(dateToHHMM(time), ":00");
}
function PlanPickerControllerProvider(_a) {
    var _this = this;
    var children = _a.children;
    var insets = (0, react_native_safe_area_context_1.useSafeAreaInsets)();
    var isAuthed = (0, SessionContext_1.useSession)().isAuthed;
    var _b = (0, react_1.useState)(false), sheetOpen = _b[0], setSheetOpen = _b[1];
    var _c = (0, react_1.useState)('pick_trip'), step = _c[0], setStep = _c[1];
    var _d = (0, react_1.useState)(null), source = _d[0], setSource = _d[1];
    var _e = (0, react_1.useState)([]), trips = _e[0], setTrips = _e[1];
    var _f = (0, react_1.useState)(false), loadingTrips = _f[0], setLoadingTrips = _f[1];
    var _g = (0, react_1.useState)(null), selectedTrip = _g[0], setSelectedTrip = _g[1];
    var _h = (0, react_1.useState)(null), dayDate = _h[0], setDayDate = _h[1];
    var _j = (0, react_1.useState)(null), startsAt = _j[0], setStartsAt = _j[1];
    var _k = (0, react_1.useState)(false), submitting = _k[0], setSubmitting = _k[1];
    var _l = (0, react_1.useState)(null), error = _l[0], setError = _l[1];
    // Per-source added tracking — persists across open() calls in this session
    var _m = (0, react_1.useState)(new Set()), addedSourceIds = _m[0], setAddedSourceIds = _m[1];
    // Toast
    var _o = (0, react_1.useState)(null), toast = _o[0], setToast = _o[1];
    var toastY = (0, react_1.useRef)(new react_native_1.Animated.Value(80)).current;
    var showToast = (0, react_1.useCallback)(function (msg) {
        setToast(msg);
        react_native_1.Animated.spring(toastY, { toValue: 0, useNativeDriver: true }).start();
        setTimeout(function () {
            react_native_1.Animated.timing(toastY, { toValue: 80, duration: 220, useNativeDriver: true }).start(function () { return setToast(null); });
        }, 2500);
    }, [toastY]);
    // Load editable trips when sheet opens
    (0, react_1.useEffect)(function () {
        if (!sheetOpen || !isAuthed)
            return;
        setLoadingTrips(true);
        (0, tripPlan_1.fetchPlanEditableTrips)()
            .then(setTrips)
            .catch(function () { return setTrips([]); })
            .finally(function () { return setLoadingTrips(false); });
    }, [sheetOpen, isAuthed]);
    var open = (0, react_1.useCallback)(function (src) {
        setSource(src);
        setSelectedTrip(null);
        // Pre-fill date + time from confirmedTime when provided (e.g. confirmed meetup)
        if (src.confirmedTime) {
            var dt = new Date(src.confirmedTime);
            setDayDate(dt);
            setStartsAt(dt);
        }
        else {
            setDayDate(null);
            setStartsAt(null);
        }
        setError(null);
        setStep('pick_trip');
        setSheetOpen(true);
    }, []);
    var close = (0, react_1.useCallback)(function () {
        setSheetOpen(false);
    }, []);
    var handlePickTrip = (0, react_1.useCallback)(function (trip) {
        setSelectedTrip(trip);
        // Preserve prefilled date/time when source carried a confirmedTime (e.g. confirmed meetup)
        if (!(source === null || source === void 0 ? void 0 : source.confirmedTime)) {
            setDayDate(null);
            setStartsAt(null);
        }
        setError(null);
        setStep('pick_time');
    }, [source]);
    var handleConfirm = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var placeErr_1, msg, e_1, msg;
        var _a, _b, _c, _d;
        return __generator(this, function (_e) {
            switch (_e.label) {
                case 0:
                    if (!source || !selectedTrip || submitting)
                        return [2 /*return*/];
                    setError(null);
                    setSubmitting(true);
                    _e.label = 1;
                case 1:
                    _e.trys.push([1, 10, 11, 12]);
                    if (!(source.type === 'meetup')) return [3 /*break*/, 3];
                    return [4 /*yield*/, (0, tripPlan_1.addMeetupToPlan)(source.id, selectedTrip.id)];
                case 2:
                    _e.sent();
                    return [3 /*break*/, 9];
                case 3:
                    _e.trys.push([3, 5, , 9]);
                    return [4 /*yield*/, (0, tripPlan_1.addPlaceToPlan)(source.id, selectedTrip.id, {
                            dayDate: dayDate ? dateToDayStr(dayDate) : undefined,
                            startsAt: buildTimestamp(dayDate, startsAt),
                        })];
                case 4:
                    _e.sent();
                    return [3 /*break*/, 9];
                case 5:
                    placeErr_1 = _e.sent();
                    msg = ((_a = placeErr_1.message) !== null && _a !== void 0 ? _a : '').toLowerCase();
                    if (!(msg.includes('404') || msg.includes('not found') || msg.includes('no place'))) return [3 /*break*/, 7];
                    return [4 /*yield*/, (0, tripPlan_1.createPlanItem)(selectedTrip.id, {
                            title: source.title,
                            category: sourceToCategory(source.type),
                            sourceType: 'place',
                            sourceId: source.id,
                            locationName: (_b = source.locationName) !== null && _b !== void 0 ? _b : source.city,
                            dayDate: dayDate ? dateToDayStr(dayDate) : undefined,
                            startsAt: buildTimestamp(dayDate, startsAt),
                        })];
                case 6:
                    _e.sent();
                    return [3 /*break*/, 8];
                case 7: throw placeErr_1;
                case 8: return [3 /*break*/, 9];
                case 9:
                    setAddedSourceIds(function (prev) {
                        var next = new Set(prev);
                        next.add(source.id);
                        return next;
                    });
                    close();
                    showToast("Added to \"".concat(selectedTrip.title, "\""));
                    return [3 /*break*/, 12];
                case 10:
                    e_1 = _e.sent();
                    msg = ((_c = e_1.message) !== null && _c !== void 0 ? _c : '').toLowerCase();
                    if (msg.includes('duplicate') || msg.includes('409') || msg.includes('already')) {
                        setAddedSourceIds(function (prev) {
                            var next = new Set(prev);
                            next.add(source.id);
                            return next;
                        });
                        close();
                        showToast("Already in \"".concat(selectedTrip.title, "\" \u2014 no duplicate added"));
                    }
                    else {
                        setError((_d = e_1.message) !== null && _d !== void 0 ? _d : 'Could not add item. Please try again.');
                    }
                    return [3 /*break*/, 12];
                case 11:
                    setSubmitting(false);
                    return [7 /*endfinally*/];
                case 12: return [2 /*return*/];
            }
        });
    }); }, [source, selectedTrip, dayDate, startsAt, submitting, close, showToast]);
    var contextValue = (0, react_1.useMemo)(function () { return ({
        open: open,
        isAdded: function (sourceId) { return addedSourceIds.has(sourceId); },
    }); }, [open, addedSourceIds]);
    return (<PlanPickerContext.Provider value={contextValue}>
      {children}

      <react_native_1.Modal visible={sheetOpen} transparent animationType="slide" onRequestClose={close}>
        <react_native_1.Pressable style={s.backdrop} onPress={close}/>
        <react_native_1.View style={[s.sheet, { paddingBottom: insets.bottom + tokens_1.space.lg }]}>
          <react_native_1.View style={s.grab}/>

          {/* Header */}
          <react_native_1.View style={s.head}>
            {step === 'pick_time' ? (<react_native_1.Pressable onPress={function () { return setStep('pick_trip'); }} hitSlop={tokens_1.layout.hitSlop} style={s.backBtn}>
                <lucide_react_native_1.ChevronLeft size={18} color={tokens_1.color.ink}/>
              </react_native_1.Pressable>) : null}
            <react_native_1.Text style={s.title}>Add to Trip Plan</react_native_1.Text>
            <react_native_1.View style={{ flex: 1 }}/>
            <react_native_1.Pressable onPress={close} hitSlop={tokens_1.layout.hitSlop} style={s.xBtn}>
              <lucide_react_native_1.X size={18} color={tokens_1.color.ink}/>
            </react_native_1.Pressable>
          </react_native_1.View>

          {/* Source preview */}
          {source && (<react_native_1.View style={s.preview}>
              <react_native_1.View style={s.previewIcon}><lucide_react_native_1.MapPin size={16} color={tokens_1.color.onInk}/></react_native_1.View>
              <react_native_1.View style={{ flex: 1 }}>
                <react_native_1.Text style={s.previewTitle} numberOfLines={1}>{source.title}</react_native_1.Text>
                <react_native_1.Text style={s.previewMeta} numberOfLines={1}>
                  {[source.category, source.city].filter(Boolean).join(' · ') || 'Place'}
                </react_native_1.Text>
              </react_native_1.View>
            </react_native_1.View>)}

          {error ? <react_native_1.Text style={s.error}>{error}</react_native_1.Text> : null}

          {!isAuthed ? (<react_native_1.View style={s.emptyWrap}>
              <react_native_1.Text style={s.emptyText}>Sign in to add items to a trip plan.</react_native_1.Text>
            </react_native_1.View>) : step === 'pick_trip' ? (
        /* ── Step 1: pick a trip ── */
        loadingTrips ? (<react_native_1.ActivityIndicator color={tokens_1.color.signal} style={{ marginVertical: tokens_1.space.xl }}/>) : trips.length === 0 ? (<react_native_1.View style={s.emptyWrap}>
                <react_native_1.Text style={s.emptyText}>
                  No trips with edit access yet. Create a trip or ask the trip owner to grant you edit permission.
                </react_native_1.Text>
              </react_native_1.View>) : (<react_native_1.ScrollView style={{ maxHeight: 320 }} contentContainerStyle={{ gap: tokens_1.space.sm }}>
                <react_native_1.Text style={s.pickerLabel}>Pick a trip</react_native_1.Text>
                {trips.map(function (trip) { return (<react_native_1.Pressable key={trip.id} style={function (_a) {
                var pressed = _a.pressed;
                return [s.tripRow, pressed && { opacity: tokens_1.layout.pressedOpacity }];
            }} onPress={function () { return handlePickTrip(trip); }}>
                    <react_native_1.View style={s.tripIcon}><lucide_react_native_1.MapPin size={14} color={tokens_1.color.deep}/></react_native_1.View>
                    <react_native_1.View style={{ flex: 1 }}>
                      <react_native_1.Text style={s.tripTitle} numberOfLines={1}>{trip.title}</react_native_1.Text>
                      {trip.destinationCity ? (<react_native_1.Text style={s.tripMeta} numberOfLines={1}>{trip.destinationCity}</react_native_1.Text>) : null}
                    </react_native_1.View>
                  </react_native_1.Pressable>); })}
              </react_native_1.ScrollView>)) : (
        /* ── Step 2: day / time + confirm ── */
        <react_native_1.ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: tokens_1.space.sm }}>
              {selectedTrip && (<react_native_1.View style={s.selectedTripChip}>
                  <lucide_react_native_1.MapPin size={12} color={tokens_1.color.signal}/>
                  <react_native_1.Text style={s.selectedTripText} numberOfLines={1}>{selectedTrip.title}</react_native_1.Text>
                </react_native_1.View>)}

              <react_native_1.Text style={s.fieldLabel}>
                Date <react_native_1.Text style={s.fieldOpt}>(optional)</react_native_1.Text>
              </react_native_1.Text>
              <DateTimePickerField_1.DatePickerField value={dayDate} onChange={setDayDate} onClear={function () { setDayDate(null); setStartsAt(null); }} placeholder="Select a date (optional)"/>

              <react_native_1.Text style={s.fieldLabel}>
                Time <react_native_1.Text style={s.fieldOpt}>(optional)</react_native_1.Text>
              </react_native_1.Text>
              <DateTimePickerField_1.DatePickerField mode="time" value={startsAt} onChange={setStartsAt} onClear={function () { return setStartsAt(null); }} placeholder="Pick a time"/>

              <react_native_1.Pressable style={[s.confirmBtn, submitting && s.confirmBtnDisabled]} onPress={handleConfirm} disabled={submitting}>
                {submitting
                ? <react_native_1.ActivityIndicator size="small" color={tokens_1.color.onInk}/>
                : <react_native_1.Text style={s.confirmBtnText}>Add to Plan</react_native_1.Text>}
              </react_native_1.Pressable>
            </react_native_1.ScrollView>)}
        </react_native_1.View>
      </react_native_1.Modal>

      {toast ? (<react_native_1.Animated.View style={[s.toast, { transform: [{ translateY: toastY }], bottom: insets.bottom + 84 }]} pointerEvents="none">
          <lucide_react_native_1.Check size={16} color={tokens_1.color.onInk}/>
          <react_native_1.Text style={s.toastText}>{toast}</react_native_1.Text>
        </react_native_1.Animated.View>) : null}
    </PlanPickerContext.Provider>);
}
function usePlanPicker() {
    var ctx = (0, react_1.useContext)(PlanPickerContext);
    return ctx !== null && ctx !== void 0 ? ctx : { open: function () { }, isAdded: function () { return false; } };
}
// ── Styles ────────────────────────────────────────────────────────────────────
var s = react_native_1.StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: 'rgba(17,17,15,0.4)' },
    sheet: __assign({ position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: tokens_1.color.paper, borderTopLeftRadius: tokens_1.radius.lg, borderTopRightRadius: tokens_1.radius.lg, padding: tokens_1.space.lg, gap: tokens_1.space.md }, tokens_1.shadow.float),
    grab: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: tokens_1.color.haze },
    head: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm },
    title: __assign(__assign({}, tokens_1.type.title), { color: tokens_1.color.ink, fontSize: 19 }),
    backBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: tokens_1.color.paperRaised, borderWidth: 1, borderColor: tokens_1.color.haze },
    xBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: tokens_1.color.paperRaised, borderWidth: 1, borderColor: tokens_1.color.haze },
    preview: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.md, backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, padding: tokens_1.space.sm },
    previewIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: tokens_1.color.deep, alignItems: 'center', justifyContent: 'center' },
    previewTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink }),
    previewMeta: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
    error: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, fontWeight: '600' }),
    pickerLabel: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', color: tokens_1.color.mute, letterSpacing: 0.5, textTransform: 'uppercase', fontSize: 10 }),
    tripRow: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.md, backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, padding: tokens_1.space.md },
    tripIcon: { width: 34, height: 34, borderRadius: 17, backgroundColor: '#E2EDF0', alignItems: 'center', justifyContent: 'center' },
    tripTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 14 }),
    tripMeta: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
    emptyWrap: { paddingVertical: tokens_1.space.xl, alignItems: 'center' },
    emptyText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute, textAlign: 'center' }),
    selectedTripChip: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start', backgroundColor: tokens_1.color.signal + '12', borderRadius: tokens_1.radius.pill, borderWidth: 1, borderColor: tokens_1.color.signal + '40', paddingHorizontal: tokens_1.space.md, paddingVertical: 5 },
    selectedTripText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, fontWeight: '700', fontSize: 12 }),
    fieldLabel: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', color: tokens_1.color.ink, marginTop: 2 }),
    fieldOpt: { fontWeight: '400', color: tokens_1.color.mute },
    confirmBtn: { marginTop: tokens_1.space.sm, backgroundColor: tokens_1.color.signal, borderRadius: tokens_1.radius.md, paddingVertical: 14, alignItems: 'center', justifyContent: 'center', minHeight: 48 },
    confirmBtnDisabled: { opacity: 0.6 },
    confirmBtnText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.onInk, fontSize: 15 }),
    toast: __assign({ position: 'absolute', alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: tokens_1.color.ink, paddingHorizontal: tokens_1.space.lg, paddingVertical: tokens_1.space.md, borderRadius: tokens_1.radius.pill }, tokens_1.shadow.float),
    toastText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.onInk }),
});
