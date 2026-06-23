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
exports.AddToPlanSheet = AddToPlanSheet;
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var tripPlan_1 = require("../services/tripPlan");
var tokens_1 = require("../theme/tokens");
var DateTimePickerField_1 = require("./DateTimePickerField");
// ── Category options ──────────────────────────────────────────────────────────
var CATEGORIES = [
    { value: 'activity', label: 'Activity' },
    { value: 'dining', label: 'Dining' },
    { value: 'accommodation', label: 'Stay / Accommodation' },
    { value: 'transport', label: 'Transport' },
    { value: 'meeting_point', label: 'Meetup / Meeting point' },
    { value: 'free_time', label: 'Free time' },
    { value: 'other', label: 'Other' },
];
// ── Component ─────────────────────────────────────────────────────────────────
function AddToPlanSheet(_a) {
    var _this = this;
    var _b, _c, _d, _e;
    var visible = _a.visible, tripId = _a.tripId, onClose = _a.onClose, onAdded = _a.onAdded, prefill = _a.prefill;
    var _f = (0, react_1.useState)((_b = prefill === null || prefill === void 0 ? void 0 : prefill.title) !== null && _b !== void 0 ? _b : ''), title = _f[0], setTitle = _f[1];
    var _g = (0, react_1.useState)((_c = prefill === null || prefill === void 0 ? void 0 : prefill.category) !== null && _c !== void 0 ? _c : 'activity'), category = _g[0], setCategory = _g[1];
    var _h = (0, react_1.useState)(null), dayDate = _h[0], setDayDate = _h[1];
    var _j = (0, react_1.useState)(null), startsAt = _j[0], setStartsAt = _j[1];
    var _k = (0, react_1.useState)((_d = prefill === null || prefill === void 0 ? void 0 : prefill.locationName) !== null && _d !== void 0 ? _d : ''), locationName = _k[0], setLocationName = _k[1];
    var _l = (0, react_1.useState)(''), notes = _l[0], setNotes = _l[1];
    var _m = (0, react_1.useState)(false), catPickerOpen = _m[0], setCatPickerOpen = _m[1];
    var _o = (0, react_1.useState)(false), submitting = _o[0], setSubmitting = _o[1];
    var _p = (0, react_1.useState)(''), error = _p[0], setError = _p[1];
    var selectedCat = (_e = CATEGORIES.find(function (c) { return c.value === category; })) !== null && _e !== void 0 ? _e : CATEGORIES[0];
    var reset = function () {
        var _a, _b, _c;
        setTitle((_a = prefill === null || prefill === void 0 ? void 0 : prefill.title) !== null && _a !== void 0 ? _a : '');
        setCategory((_b = prefill === null || prefill === void 0 ? void 0 : prefill.category) !== null && _b !== void 0 ? _b : 'activity');
        setDayDate(null);
        setStartsAt(null);
        setLocationName((_c = prefill === null || prefill === void 0 ? void 0 : prefill.locationName) !== null && _c !== void 0 ? _c : '');
        setNotes('');
        setError('');
        setCatPickerOpen(false);
    };
    var handleClose = function () { reset(); onClose(); };
    var handleSubmit = function () { return __awaiter(_this, void 0, void 0, function () {
        var item, e_1;
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    if (!title.trim()) {
                        setError('Title is required');
                        return [2 /*return*/];
                    }
                    setError('');
                    setSubmitting(true);
                    _c.label = 1;
                case 1:
                    _c.trys.push([1, 3, 4, 5]);
                    return [4 /*yield*/, (0, tripPlan_1.createPlanItem)(tripId, {
                            title: title.trim(),
                            category: category,
                            sourceType: (_a = prefill === null || prefill === void 0 ? void 0 : prefill.sourceType) !== null && _a !== void 0 ? _a : 'manual',
                            sourceId: prefill === null || prefill === void 0 ? void 0 : prefill.sourceId,
                            dayDate: dayDate ? dateToDayStr(dayDate) : undefined,
                            startsAt: buildTimestamp(dayDate, startsAt),
                            locationName: locationName.trim() || undefined,
                            notes: notes.trim() || undefined,
                        })];
                case 2:
                    item = _c.sent();
                    onAdded(item);
                    reset();
                    return [3 /*break*/, 5];
                case 3:
                    e_1 = _c.sent();
                    setError((_b = e_1.message) !== null && _b !== void 0 ? _b : 'Could not add item. Please try again.');
                    return [3 /*break*/, 5];
                case 4:
                    setSubmitting(false);
                    return [7 /*endfinally*/];
                case 5: return [2 /*return*/];
            }
        });
    }); };
    return (<react_native_1.Modal visible={visible} animationType="slide" transparent onRequestClose={handleClose}>
      <react_native_1.KeyboardAvoidingView behavior={react_native_1.Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <react_native_1.Pressable style={sh.overlay} onPress={handleClose}/>
        <react_native_1.View style={sh.sheet}>
          <react_native_1.View style={sh.handle}/>
          <react_native_1.View style={sh.header}>
            <react_native_1.Text style={sh.headerTitle}>Add to Plan</react_native_1.Text>
            <react_native_1.Pressable onPress={handleClose} hitSlop={8}><lucide_react_native_1.X size={20} color={tokens_1.color.mute}/></react_native_1.Pressable>
          </react_native_1.View>

          <react_native_1.ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={sh.body} keyboardShouldPersistTaps="handled">
            <react_native_1.Text style={sh.label}>Title <react_native_1.Text style={sh.req}>*</react_native_1.Text></react_native_1.Text>
            <react_native_1.TextInput style={sh.input} value={title} onChangeText={setTitle} placeholder="e.g. Dinner at Anzani" placeholderTextColor={tokens_1.color.faint} returnKeyType="next"/>

            <react_native_1.Text style={sh.label}>Category</react_native_1.Text>
            <react_native_1.Pressable style={sh.picker} onPress={function () { return setCatPickerOpen(!catPickerOpen); }}>
              <react_native_1.Text style={sh.pickerText}>{selectedCat.label}</react_native_1.Text>
              <lucide_react_native_1.ChevronDown size={16} color={tokens_1.color.mute}/>
            </react_native_1.Pressable>
            {catPickerOpen && (<react_native_1.View style={sh.catList}>
                {CATEGORIES.map(function (c) { return (<react_native_1.Pressable key={c.value} style={[sh.catOption, c.value === category && sh.catOptionActive]} onPress={function () { setCategory(c.value); setCatPickerOpen(false); }}>
                    <react_native_1.Text style={[sh.catOptionText, c.value === category && sh.catOptionTextActive]}>
                      {c.label}
                    </react_native_1.Text>
                  </react_native_1.Pressable>); })}
              </react_native_1.View>)}

            <react_native_1.Text style={sh.label}>Date <react_native_1.Text style={sh.opt}>(optional)</react_native_1.Text></react_native_1.Text>
            <DateTimePickerField_1.DatePickerField value={dayDate} onChange={setDayDate} onClear={function () { setDayDate(null); setStartsAt(null); }} placeholder="Select a date (optional)"/>

            <react_native_1.Text style={sh.label}>Time <react_native_1.Text style={sh.opt}>(optional)</react_native_1.Text></react_native_1.Text>
            <DateTimePickerField_1.DatePickerField mode="time" value={startsAt} onChange={setStartsAt} onClear={function () { return setStartsAt(null); }} placeholder="Pick a time"/>

            <react_native_1.Text style={sh.label}>Location <react_native_1.Text style={sh.opt}>(optional)</react_native_1.Text></react_native_1.Text>
            <react_native_1.TextInput style={sh.input} value={locationName} onChangeText={setLocationName} placeholder="e.g. Ayala Mall, Cebu" placeholderTextColor={tokens_1.color.faint}/>

            <react_native_1.Text style={sh.label}>Notes <react_native_1.Text style={sh.opt}>(optional)</react_native_1.Text></react_native_1.Text>
            <react_native_1.TextInput style={[sh.input, sh.inputMulti]} value={notes} onChangeText={setNotes} placeholder="Any extra details…" placeholderTextColor={tokens_1.color.faint} multiline numberOfLines={3} textAlignVertical="top"/>

            {error ? <react_native_1.Text style={sh.error}>{error}</react_native_1.Text> : null}

            <react_native_1.Pressable style={[sh.submitBtn, submitting && sh.submitBtnDisabled]} onPress={handleSubmit} disabled={submitting}>
              <react_native_1.Text style={sh.submitText}>{submitting ? 'Adding…' : 'Add to Trip Plan'}</react_native_1.Text>
            </react_native_1.Pressable>
          </react_native_1.ScrollView>
        </react_native_1.View>
      </react_native_1.KeyboardAvoidingView>
    </react_native_1.Modal>);
}
// ── Helpers ───────────────────────────────────────────────────────────────────
/** "YYYY-MM-DD" string from a Date (local timezone) */
function dateToDayStr(d) {
    var y = d.getFullYear();
    var mo = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return "".concat(y, "-").concat(mo, "-").concat(day);
}
/** "HH:MM" 24-hour string from a Date */
function dateToHHMM(d) {
    var h = String(d.getHours()).padStart(2, '0');
    var m = String(d.getMinutes()).padStart(2, '0');
    return "".concat(h, ":").concat(m);
}
function buildTimestamp(date, time) {
    if (!date || !time)
        return undefined;
    return "".concat(dateToDayStr(date), "T").concat(dateToHHMM(time), ":00");
}
// ── Styles ────────────────────────────────────────────────────────────────────
var sh = react_native_1.StyleSheet.create({
    overlay: { flex: 1, backgroundColor: 'transparent' },
    sheet: {
        backgroundColor: tokens_1.color.paper,
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        maxHeight: '90%',
        paddingBottom: 30,
    },
    handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: tokens_1.color.haze, alignSelf: 'center', marginTop: 10, marginBottom: 4 },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: tokens_1.space.lg, paddingVertical: tokens_1.space.md, borderBottomWidth: 1, borderBottomColor: tokens_1.color.haze },
    headerTitle: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink, fontSize: 17 }),
    body: { paddingHorizontal: tokens_1.space.lg, paddingTop: tokens_1.space.md, paddingBottom: tokens_1.space.lg, gap: 4 },
    label: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', color: tokens_1.color.ink, marginTop: tokens_1.space.md, marginBottom: 4 }),
    req: { color: tokens_1.color.signal },
    opt: { fontWeight: '400', color: tokens_1.color.mute },
    input: __assign(__assign({ borderWidth: 1, borderColor: tokens_1.color.haze, borderRadius: tokens_1.radius.md, paddingHorizontal: tokens_1.space.md, paddingVertical: tokens_1.space.sm }, tokens_1.type.body), { color: tokens_1.color.ink, backgroundColor: tokens_1.color.paperRaised }),
    inputMulti: { height: 80, paddingTop: tokens_1.space.sm },
    picker: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        borderWidth: 1, borderColor: tokens_1.color.haze, borderRadius: tokens_1.radius.md,
        paddingHorizontal: tokens_1.space.md, paddingVertical: tokens_1.space.sm,
        backgroundColor: tokens_1.color.paperRaised,
    },
    pickerText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink }),
    catList: { borderWidth: 1, borderColor: tokens_1.color.haze, borderRadius: tokens_1.radius.md, overflow: 'hidden', marginTop: 2 },
    catOption: { paddingHorizontal: tokens_1.space.md, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: tokens_1.color.haze },
    catOptionActive: { backgroundColor: tokens_1.color.signal },
    catOptionText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink }),
    catOptionTextActive: { color: tokens_1.color.onInk, fontWeight: '700' },
    error: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, marginTop: tokens_1.space.sm }),
    submitBtn: { marginTop: tokens_1.space.lg, backgroundColor: tokens_1.color.signal, borderRadius: tokens_1.radius.md, paddingVertical: 14, alignItems: 'center' },
    submitBtnDisabled: { opacity: 0.6 },
    submitText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.onInk, fontSize: 15 }),
});
