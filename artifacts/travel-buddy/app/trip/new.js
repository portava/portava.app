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
exports.default = NewTrip;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var lucide_react_native_1 = require("lucide-react-native");
var ScreenHeader_1 = require("../../src/components/ScreenHeader");
var SessionContext_1 = require("../../src/context/SessionContext");
var trips_1 = require("../../src/services/trips");
var GlobalCalendarPicker_1 = require("../../src/components/selectors/GlobalCalendarPicker");
var GlobalPlacePicker_1 = require("../../src/components/selectors/GlobalPlacePicker");
var tokens_1 = require("../../src/theme/tokens");
var formatters_1 = require("../../src/lib/dateTime/formatters");
function NewTrip() {
    var _a = (0, SessionContext_1.useSession)(), configured = _a.configured, isAuthed = _a.isAuthed;
    var live = configured && isAuthed;
    var _b = (0, react_1.useState)(''), title = _b[0], setTitle = _b[1];
    var _c = (0, react_1.useState)(null), place = _c[0], setPlace = _c[1];
    var _d = (0, react_1.useState)(null), startDate = _d[0], setStartDate = _d[1];
    var _e = (0, react_1.useState)(null), endDate = _e[0], setEndDate = _e[1];
    var _f = (0, react_1.useState)(false), busy = _f[0], setBusy = _f[1];
    var _g = (0, react_1.useState)(null), error = _g[0], setError = _g[1];
    var _h = (0, react_1.useState)(false), calOpen = _h[0], setCalOpen = _h[1];
    var _j = (0, react_1.useState)(false), placeOpen = _j[0], setPlaceOpen = _j[1];
    function create() {
        return __awaiter(this, void 0, void 0, function () {
            var trip, e_1;
            var _a, _b, _c;
            return __generator(this, function (_d) {
                switch (_d.label) {
                    case 0:
                        setError(null);
                        if (!title.trim()) {
                            setError('Add a trip name.');
                            return [2 /*return*/];
                        }
                        if (!place) {
                            setError('Add a destination.');
                            return [2 /*return*/];
                        }
                        if (!live) {
                            expo_router_1.router.replace('/trip/t_1');
                            return [2 /*return*/];
                        }
                        setBusy(true);
                        _d.label = 1;
                    case 1:
                        _d.trys.push([1, 3, 4, 5]);
                        return [4 /*yield*/, (0, trips_1.createTrip)({
                                title: title.trim(),
                                destinationCity: (_a = place.city) !== null && _a !== void 0 ? _a : place.name,
                                destinationCountry: (_b = place.country) !== null && _b !== void 0 ? _b : undefined,
                                startDate: startDate !== null && startDate !== void 0 ? startDate : undefined,
                                endDate: endDate !== null && endDate !== void 0 ? endDate : undefined,
                                status: 'planning',
                                visibility: 'private',
                            })];
                    case 2:
                        trip = _d.sent();
                        if (!trip) {
                            setError('Could not create the trip. Try again.');
                            return [2 /*return*/];
                        }
                        expo_router_1.router.replace("/trip/".concat(trip.id));
                        return [3 /*break*/, 5];
                    case 3:
                        e_1 = _d.sent();
                        setError((_c = e_1 === null || e_1 === void 0 ? void 0 : e_1.message) !== null && _c !== void 0 ? _c : 'Something went wrong.');
                        return [3 /*break*/, 5];
                    case 4:
                        setBusy(false);
                        return [7 /*endfinally*/];
                    case 5: return [2 /*return*/];
                }
            });
        });
    }
    var startD = startDate ? (0, formatters_1.fromISODate)(startDate) : null;
    var endD = endDate ? (0, formatters_1.fromISODate)(endDate) : null;
    return (<react_native_1.View style={{ flex: 1, backgroundColor: tokens_1.color.paper }}>
      <ScreenHeader_1.ScreenHeader title="New trip" back/>

      <react_native_1.ScrollView contentContainerStyle={{ padding: tokens_1.space.lg, gap: tokens_1.space.lg }} keyboardShouldPersistTaps="handled">
        {/* Trip name */}
        <Field label="Trip name" placeholder="Visayas, June" value={title} onChange={setTitle}/>

        {/* Destination */}
        <react_native_1.View>
          <react_native_1.Text style={styles.label}>Destination</react_native_1.Text>
          <react_native_1.Pressable style={styles.pickerField} onPress={function () { return setPlaceOpen(true); }}>
            <lucide_react_native_1.MapPin size={15} color={place ? tokens_1.color.signal : tokens_1.color.faint}/>
            <react_native_1.Text style={[styles.pickerText, !place && styles.pickerPlaceholder]} numberOfLines={1}>
              {place ? place.displayName : 'Choose a city…'}
            </react_native_1.Text>
            {place && (<react_native_1.Pressable hitSlop={8} onPress={function () { return setPlace(null); }}>
                <lucide_react_native_1.X size={14} color={tokens_1.color.mute}/>
              </react_native_1.Pressable>)}
          </react_native_1.Pressable>
        </react_native_1.View>

        {/* Dates */}
        <react_native_1.View>
          <react_native_1.Text style={styles.label}>Trip Dates (optional)</react_native_1.Text>
          <react_native_1.Pressable style={styles.pickerField} onPress={function () { return setCalOpen(true); }}>
            <lucide_react_native_1.CalendarDays size={15} color={(startDate || endDate) ? tokens_1.color.signal : tokens_1.color.faint}/>
            <react_native_1.Text style={[styles.pickerText, !(startDate || endDate) && styles.pickerPlaceholder]}>
              {startD && endD
            ? "".concat((0, formatters_1.formatDisplayDate)(startD), " \u2013 ").concat((0, formatters_1.formatDisplayDate)(endD))
            : startD
                ? "From ".concat((0, formatters_1.formatDisplayDate)(startD))
                : 'Add start & end dates'}
            </react_native_1.Text>
            {(startDate || endDate) && (<react_native_1.Pressable hitSlop={8} onPress={function () { setStartDate(null); setEndDate(null); }}>
                <lucide_react_native_1.X size={14} color={tokens_1.color.mute}/>
              </react_native_1.Pressable>)}
          </react_native_1.Pressable>
        </react_native_1.View>

        {error ? <react_native_1.Text style={styles.error}>{error}</react_native_1.Text> : null}
        {!live ? <react_native_1.Text style={styles.hint}>Sign in to save trips to your account.</react_native_1.Text> : null}

        <react_native_1.Pressable style={[styles.create, busy && { opacity: 0.7 }]} onPress={create} disabled={busy}>
          {busy ? <react_native_1.ActivityIndicator color={tokens_1.color.onInk}/> : <react_native_1.Text style={styles.createText}>Create trip</react_native_1.Text>}
        </react_native_1.Pressable>
      </react_native_1.ScrollView>

      {/* Calendar picker — range mode */}
      <GlobalCalendarPicker_1.GlobalCalendarPicker mode="range" visible={calOpen} value={{ start: startDate, end: endDate }} allowPast onConfirm={function (_a) {
            var start = _a.start, end = _a.end;
            setStartDate(start);
            setEndDate(end);
            setCalOpen(false);
        }} onCancel={function () { return setCalOpen(false); }} title="Trip Dates"/>

      {/* Place picker */}
      <GlobalPlacePicker_1.GlobalPlacePicker visible={placeOpen} title="Destination" allowGPS={false} usedFor="trip_destination" onSelect={function (p) { return setPlace(p); }} onClose={function () { return setPlaceOpen(false); }}/>
    </react_native_1.View>);
}
function Field(_a) {
    var label = _a.label, placeholder = _a.placeholder, value = _a.value, onChange = _a.onChange;
    return (<react_native_1.View>
      <react_native_1.Text style={styles.label}>{label}</react_native_1.Text>
      <react_native_1.TextInput style={styles.input} placeholder={placeholder} placeholderTextColor={tokens_1.color.faint} value={value} onChangeText={onChange} autoCapitalize="words"/>
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    label: __assign(__assign({}, tokens_1.type.stamp), { fontFamily: 'Courier', color: tokens_1.color.mute, marginBottom: tokens_1.space.sm }),
    input: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, backgroundColor: tokens_1.color.paperRaised, borderWidth: 1, borderColor: tokens_1.color.haze, borderRadius: tokens_1.radius.md, paddingHorizontal: tokens_1.space.lg, paddingVertical: tokens_1.space.md }),
    pickerField: {
        flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm,
        backgroundColor: tokens_1.color.paperRaised, borderWidth: 1, borderColor: tokens_1.color.haze,
        borderRadius: tokens_1.radius.md, paddingHorizontal: tokens_1.space.lg, paddingVertical: tokens_1.space.md,
        minHeight: 50,
    },
    pickerText: __assign(__assign({ flex: 1 }, tokens_1.type.body), { color: tokens_1.color.ink }),
    pickerPlaceholder: { color: tokens_1.color.faint },
    error: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, fontWeight: '600' }),
    hint: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    create: {
        backgroundColor: tokens_1.color.ink, paddingVertical: tokens_1.space.md,
        borderRadius: tokens_1.radius.pill, alignItems: 'center', marginTop: tokens_1.space.sm,
    },
    createText: __assign(__assign({}, tokens_1.type.body), { fontWeight: '700', color: tokens_1.color.onInk }),
});
