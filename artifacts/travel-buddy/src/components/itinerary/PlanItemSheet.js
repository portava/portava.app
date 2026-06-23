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
exports.PlanItemSheet = PlanItemSheet;
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var tripPlan_1 = require("../../services/tripPlan");
var tokens_1 = require("../../theme/tokens");
var DateTimePickerField_1 = require("../DateTimePickerField");
// ── Category / status maps ────────────────────────────────────────────────────
var CAT_LABEL = {
    accommodation: 'Stay',
    activity: 'Activity',
    dining: 'Dining',
    transport: 'Transport',
    free_time: 'Free time',
    meeting_point: 'Meetup',
    other: 'Other',
};
var CAT_COLOR = {
    accommodation: { bg: '#E2EDF0', fg: tokens_1.color.deep },
    activity: { bg: '#E3F1EA', fg: tokens_1.color.success },
    dining: { bg: '#FCE9E4', fg: tokens_1.color.signal },
    transport: { bg: '#EFE7FA', fg: '#7A4DBF' },
    free_time: { bg: '#F5F0E8', fg: '#8B6914' },
    meeting_point: { bg: '#FFF0D0', fg: '#B07000' },
    other: { bg: tokens_1.color.haze, fg: tokens_1.color.mute },
};
var STATUS_LABEL = {
    confirmed: 'Confirmed',
    tentative: 'Tentative',
    done: 'Done',
    cancelled: 'Cancelled',
};
var STATUS_COLOR = {
    confirmed: { bg: '#E3F1EA', fg: tokens_1.color.success },
    tentative: { bg: '#F5F0E8', fg: '#8B6914' },
    done: { bg: tokens_1.color.haze, fg: tokens_1.color.mute },
    cancelled: { bg: '#FCE9E4', fg: '#B0291A' },
};
var WARN_LABEL = {
    time_overlap: '⚠ Time conflict with another item',
    duplicate: '⚠ Duplicate source item in plan',
    outside_trip_dates: '⚠ Scheduled outside trip dates',
};
var STATUS_OPTIONS = ['tentative', 'confirmed', 'done', 'cancelled'];
// ── Date helpers ──────────────────────────────────────────────────────────────
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
// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtDateTime(isoDate, isoTime) {
    var d = isoDate ? new Date(isoDate + 'T00:00:00') : null;
    if (!d || isNaN(d.getTime()))
        return null;
    var datePart = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    if (!isoTime)
        return datePart;
    var t = new Date(isoTime);
    if (isNaN(t.getTime()))
        return datePart;
    return "".concat(datePart, ", ").concat(t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
}
// ── Category options ──────────────────────────────────────────────────────────
var CAT_OPTIONS = [
    { value: 'activity', label: 'Activity' },
    { value: 'dining', label: 'Dining' },
    { value: 'accommodation', label: 'Stay / Accommodation' },
    { value: 'transport', label: 'Transport' },
    { value: 'meeting_point', label: 'Meetup / Meeting point' },
    { value: 'free_time', label: 'Free time' },
    { value: 'other', label: 'Other' },
];
// ── Edit form ─────────────────────────────────────────────────────────────────
function EditForm(_a) {
    var _this = this;
    var _b, _c, _d;
    var item = _a.item, tripId = _a.tripId, onSaved = _a.onSaved, onCancel = _a.onCancel;
    var _e = (0, react_1.useState)(item.title), title = _e[0], setTitle = _e[1];
    var _f = (0, react_1.useState)(item.category), category = _f[0], setCategory = _f[1];
    var _g = (0, react_1.useState)(false), catPickerOpen = _g[0], setCatPickerOpen = _g[1];
    var _h = (0, react_1.useState)(item.dayDate ? new Date(item.dayDate + 'T00:00:00') : null), dayDate = _h[0], setDayDate = _h[1];
    var _j = (0, react_1.useState)(item.startsAt ? new Date(item.startsAt) : null), startsAt = _j[0], setStartsAt = _j[1];
    var _k = (0, react_1.useState)((_b = item.locationName) !== null && _b !== void 0 ? _b : ''), locationName = _k[0], setLocationName = _k[1];
    var _l = (0, react_1.useState)(item.status), status = _l[0], setStatus = _l[1];
    var _m = (0, react_1.useState)((_c = item.notes) !== null && _c !== void 0 ? _c : ''), notes = _m[0], setNotes = _m[1];
    var _o = (0, react_1.useState)(false), submitting = _o[0], setSubmitting = _o[1];
    var _p = (0, react_1.useState)(''), err = _p[0], setErr = _p[1];
    var selectedCat = (_d = CAT_OPTIONS.find(function (c) { return c.value === category; })) !== null && _d !== void 0 ? _d : CAT_OPTIONS[0];
    var handleSave = function () { return __awaiter(_this, void 0, void 0, function () {
        var dateStr, updated, e_1;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (!title.trim()) {
                        setErr('Title is required');
                        return [2 /*return*/];
                    }
                    setErr('');
                    setSubmitting(true);
                    _b.label = 1;
                case 1:
                    _b.trys.push([1, 3, 4, 5]);
                    dateStr = dayDate ? dateToDayStr(dayDate) : null;
                    return [4 /*yield*/, (0, tripPlan_1.updatePlanItem)(tripId, item.id, {
                            title: title.trim(),
                            category: category,
                            dayDate: dateStr,
                            startsAt: dateStr && startsAt ? "".concat(dateStr, "T").concat(dateToHHMM(startsAt), ":00") : null,
                            locationName: locationName.trim() || null,
                            status: status,
                            notes: notes.trim() || null,
                        })];
                case 2:
                    updated = _b.sent();
                    onSaved(updated);
                    return [3 /*break*/, 5];
                case 3:
                    e_1 = _b.sent();
                    setErr((_a = e_1.message) !== null && _a !== void 0 ? _a : 'Could not save');
                    return [3 /*break*/, 5];
                case 4:
                    setSubmitting(false);
                    return [7 /*endfinally*/];
                case 5: return [2 /*return*/];
            }
        });
    }); };
    return (<react_native_1.View style={ef.wrap}>
      <react_native_1.View style={ef.row}>
        <react_native_1.Text style={ef.sectionLabel}>Edit Item</react_native_1.Text>
        <react_native_1.Pressable onPress={onCancel} hitSlop={8}>
          <lucide_react_native_1.X size={18} color={tokens_1.color.mute}/>
        </react_native_1.Pressable>
      </react_native_1.View>

      <react_native_1.Text style={ef.label}>Title</react_native_1.Text>
      <react_native_1.TextInput style={ef.input} value={title} onChangeText={setTitle} placeholderTextColor={tokens_1.color.faint}/>

      <react_native_1.Text style={ef.label}>Category</react_native_1.Text>
      <react_native_1.Pressable style={ef.picker} onPress={function () { return setCatPickerOpen(!catPickerOpen); }}>
        <react_native_1.Text style={ef.pickerText}>{selectedCat.label}</react_native_1.Text>
        <lucide_react_native_1.ChevronDown size={15} color={tokens_1.color.mute}/>
      </react_native_1.Pressable>
      {catPickerOpen && (<react_native_1.View style={ef.catList}>
          {CAT_OPTIONS.map(function (c) { return (<react_native_1.Pressable key={c.value} style={[ef.catOption, c.value === category && ef.catOptionActive]} onPress={function () { setCategory(c.value); setCatPickerOpen(false); }}>
              <react_native_1.Text style={[ef.catOptionText, c.value === category && ef.catOptionTextActive]}>
                {c.label}
              </react_native_1.Text>
            </react_native_1.Pressable>); })}
        </react_native_1.View>)}

      <react_native_1.Text style={ef.label}>Date</react_native_1.Text>
      <DateTimePickerField_1.DatePickerField value={dayDate} onChange={setDayDate} onClear={function () { setDayDate(null); setStartsAt(null); }} placeholder="Select a date (optional)"/>

      <react_native_1.Text style={ef.label}>Time <react_native_1.Text style={ef.opt}>(optional)</react_native_1.Text></react_native_1.Text>
      <DateTimePickerField_1.DatePickerField mode="time" value={startsAt} onChange={setStartsAt} onClear={function () { return setStartsAt(null); }} placeholder="Pick a time"/>

      <react_native_1.Text style={ef.label}>Location <react_native_1.Text style={ef.opt}>(optional)</react_native_1.Text></react_native_1.Text>
      <react_native_1.TextInput style={ef.input} value={locationName} onChangeText={setLocationName} placeholder="e.g. Ayala Mall, Cebu" placeholderTextColor={tokens_1.color.faint}/>

      <react_native_1.Text style={ef.label}>Status</react_native_1.Text>
      <react_native_1.View style={ef.statusRow}>
        {STATUS_OPTIONS.map(function (s) { return (<react_native_1.Pressable key={s} style={[ef.statusChip, status === s && ef.statusChipActive]} onPress={function () { return setStatus(s); }}>
            <react_native_1.Text style={[ef.statusChipText, status === s && ef.statusChipTextActive]}>{STATUS_LABEL[s]}</react_native_1.Text>
          </react_native_1.Pressable>); })}
      </react_native_1.View>

      <react_native_1.Text style={ef.label}>Notes <react_native_1.Text style={ef.opt}>(optional)</react_native_1.Text></react_native_1.Text>
      <react_native_1.TextInput style={[ef.input, ef.inputMulti]} value={notes} onChangeText={setNotes} placeholder="Any extra details…" placeholderTextColor={tokens_1.color.faint} multiline numberOfLines={3} textAlignVertical="top"/>

      {err ? <react_native_1.Text style={ef.error}>{err}</react_native_1.Text> : null}

      <react_native_1.Pressable style={[ef.saveBtn, submitting && ef.saveBtnDim]} onPress={handleSave} disabled={submitting}>
        <react_native_1.Text style={ef.saveText}>{submitting ? 'Saving…' : 'Save Changes'}</react_native_1.Text>
      </react_native_1.Pressable>
    </react_native_1.View>);
}
function PlanItemSheet(_a) {
    var _this = this;
    var _b, _c, _d, _e;
    var item = _a.item, tripId = _a.tripId, currentUserId = _a.currentUserId, isOwner = _a.isOwner, _f = _a.canEdit, canEdit = _f === void 0 ? true : _f, startInEditMode = _a.startInEditMode, onClose = _a.onClose, onUpdated = _a.onUpdated, onRemoved = _a.onRemoved;
    var _g = (0, react_1.useState)(false), editing = _g[0], setEditing = _g[1];
    // Enter edit mode automatically when the prop flips (e.g. context menu "Edit" tapped)
    (0, react_1.useEffect)(function () {
        if (item && startInEditMode)
            setEditing(true);
        if (!item)
            setEditing(false);
    }, [item, startInEditMode]);
    if (!item)
        return null;
    var canAct = canEdit && (isOwner || item.creatorId === currentUserId);
    var cat = (_b = CAT_COLOR[item.category]) !== null && _b !== void 0 ? _b : CAT_COLOR.other;
    var st = (_c = STATUS_COLOR[item.status]) !== null && _c !== void 0 ? _c : STATUS_COLOR.tentative;
    var dateTimeStr = fmtDateTime(item.dayDate, item.startsAt);
    var handleRemove = function () {
        react_native_1.Alert.alert('Remove item', 'Remove this item from the trip plan?', [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Remove', style: 'destructive', onPress: function () { return __awaiter(_this, void 0, void 0, function () {
                    var e_2;
                    var _a;
                    return __generator(this, function (_b) {
                        switch (_b.label) {
                            case 0:
                                _b.trys.push([0, 2, , 3]);
                                return [4 /*yield*/, (0, tripPlan_1.removePlanItem)(tripId, item.id)];
                            case 1:
                                _b.sent();
                                onRemoved(item.id);
                                onClose();
                                return [3 /*break*/, 3];
                            case 2:
                                e_2 = _b.sent();
                                react_native_1.Alert.alert('Error', (_a = e_2.message) !== null && _a !== void 0 ? _a : 'Could not remove item');
                                return [3 /*break*/, 3];
                            case 3: return [2 /*return*/];
                        }
                    });
                }); },
            },
        ]);
    };
    return (<react_native_1.Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <react_native_1.KeyboardAvoidingView behavior={react_native_1.Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <react_native_1.Pressable style={sh.overlay} onPress={onClose}/>
        <react_native_1.View style={sh.sheet}>
          <react_native_1.View style={sh.handle}/>

          {/* Header */}
          <react_native_1.View style={sh.header}>
            <react_native_1.Pressable onPress={onClose} hitSlop={8} style={sh.closeBtn}>
              <lucide_react_native_1.X size={20} color={tokens_1.color.mute}/>
            </react_native_1.Pressable>
            {canAct && !editing && (<react_native_1.View style={sh.actionBtns}>
                <react_native_1.Pressable style={sh.editBtn} onPress={function () { return setEditing(true); }}>
                  <lucide_react_native_1.Pencil size={14} color={tokens_1.color.deep}/>
                  <react_native_1.Text style={sh.editBtnText}>Edit</react_native_1.Text>
                </react_native_1.Pressable>
                <react_native_1.Pressable style={sh.removeBtn} onPress={handleRemove}>
                  <lucide_react_native_1.Trash2 size={14} color={tokens_1.color.signal}/>
                  <react_native_1.Text style={sh.removeBtnText}>Remove</react_native_1.Text>
                </react_native_1.Pressable>
              </react_native_1.View>)}
          </react_native_1.View>

          <react_native_1.ScrollView contentContainerStyle={sh.body} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            {editing ? (<EditForm item={item} tripId={tripId} onSaved={function (updated) { setEditing(false); onUpdated(updated); }} onCancel={function () { return setEditing(false); }}/>) : (<>
                {/* Warnings */}
                {item.warnings.length > 0 && (<react_native_1.View style={sh.warnBox}>
                    {item.warnings.map(function (w) {
                    var _a;
                    return (<react_native_1.View key={w} style={sh.warnRow}>
                        <lucide_react_native_1.AlertTriangle size={13} color="#B07000"/>
                        <react_native_1.Text style={sh.warnText}>{(_a = WARN_LABEL[w]) !== null && _a !== void 0 ? _a : w}</react_native_1.Text>
                      </react_native_1.View>);
                })}
                  </react_native_1.View>)}

                {/* Title */}
                <react_native_1.Text style={sh.title}>{item.title}</react_native_1.Text>

                {/* Badges */}
                <react_native_1.View style={sh.badgeRow}>
                  <react_native_1.View style={[sh.badge, { backgroundColor: cat.bg }]}>
                    <react_native_1.Text style={[sh.badgeText, { color: cat.fg }]}>{(_d = CAT_LABEL[item.category]) !== null && _d !== void 0 ? _d : 'Other'}</react_native_1.Text>
                  </react_native_1.View>
                  <react_native_1.View style={[sh.badge, { backgroundColor: st.bg }]}>
                    <react_native_1.Text style={[sh.badgeText, { color: st.fg }]}>{(_e = STATUS_LABEL[item.status]) !== null && _e !== void 0 ? _e : item.status}</react_native_1.Text>
                  </react_native_1.View>
                  {item.sourceType !== 'manual' && (<react_native_1.View style={[sh.badge, { backgroundColor: tokens_1.color.haze }]}>
                      <lucide_react_native_1.Tag size={10} color={tokens_1.color.mute}/>
                      <react_native_1.Text style={[sh.badgeText, { color: tokens_1.color.mute }]}>
                        {item.sourceType === 'meetup' ? 'From Meetup' : 'From Place'}
                      </react_native_1.Text>
                    </react_native_1.View>)}
                </react_native_1.View>

                {/* Date / time */}
                {dateTimeStr && (<react_native_1.View style={sh.field}>
                    <lucide_react_native_1.Clock size={14} color={tokens_1.color.mute} style={sh.fieldIcon}/>
                    <react_native_1.Text style={sh.fieldText}>{dateTimeStr}</react_native_1.Text>
                  </react_native_1.View>)}

                {/* Location */}
                {item.locationName && (<react_native_1.View style={sh.field}>
                    <lucide_react_native_1.MapPin size={14} color={tokens_1.color.mute} style={sh.fieldIcon}/>
                    <react_native_1.Text style={sh.fieldText}>{item.locationName}</react_native_1.Text>
                    {item.locationIsPrivate && (<react_native_1.Text style={sh.privateTag}> · Private</react_native_1.Text>)}
                  </react_native_1.View>)}

                {/* Notes */}
                {item.notes && (<react_native_1.View style={sh.notesBox}>
                    <react_native_1.View style={sh.field}>
                      <lucide_react_native_1.FileText size={14} color={tokens_1.color.mute} style={sh.fieldIcon}/>
                      <react_native_1.Text style={sh.notesLabel}>Notes</react_native_1.Text>
                    </react_native_1.View>
                    <react_native_1.Text style={sh.notesText}>{item.notes}</react_native_1.Text>
                  </react_native_1.View>)}

                {/* Source ID for non-manual items */}
                {item.sourceId && (<react_native_1.Text style={sh.sourceHint}>Source ID: {item.sourceId}</react_native_1.Text>)}

                {/* Status quick-change */}
                {canAct && (<react_native_1.View style={sh.statusSection}>
                    <react_native_1.Text style={sh.statusLabel}>Status</react_native_1.Text>
                    <react_native_1.View style={sh.statusRow}>
                      {STATUS_OPTIONS.filter(function (s) { return s !== item.status; }).map(function (s) {
                    var sc = STATUS_COLOR[s];
                    return (<react_native_1.Pressable key={s} style={[sh.statusChip, { backgroundColor: sc.bg }]} onPress={function () { return __awaiter(_this, void 0, void 0, function () {
                            var updated, _a;
                            return __generator(this, function (_b) {
                                switch (_b.label) {
                                    case 0:
                                        _b.trys.push([0, 2, , 3]);
                                        return [4 /*yield*/, (0, tripPlan_1.updatePlanItem)(tripId, item.id, { status: s })];
                                    case 1:
                                        updated = _b.sent();
                                        onUpdated(updated);
                                        return [3 /*break*/, 3];
                                    case 2:
                                        _a = _b.sent();
                                        return [3 /*break*/, 3];
                                    case 3: return [2 /*return*/];
                                }
                            });
                        }); }}>
                            <lucide_react_native_1.CheckCircle2 size={11} color={sc.fg}/>
                            <react_native_1.Text style={[sh.statusChipText, { color: sc.fg }]}>
                              Mark {STATUS_LABEL[s]}
                            </react_native_1.Text>
                          </react_native_1.Pressable>);
                })}
                    </react_native_1.View>
                  </react_native_1.View>)}
              </>)}
          </react_native_1.ScrollView>
        </react_native_1.View>
      </react_native_1.KeyboardAvoidingView>
    </react_native_1.Modal>);
}
// ── Styles ────────────────────────────────────────────────────────────────────
var sh = react_native_1.StyleSheet.create({
    overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
    sheet: { backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '90%' },
    handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: tokens_1.color.haze, alignSelf: 'center', marginTop: 10, marginBottom: 4 },
    header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: tokens_1.space.lg, paddingVertical: tokens_1.space.sm },
    closeBtn: { padding: 4 },
    actionBtns: { flexDirection: 'row', gap: 8, marginLeft: 'auto' },
    editBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#E9F0FB', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
    editBtnText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.deep, fontWeight: '600' }),
    removeBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#FDEAEA', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
    removeBtnText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, fontWeight: '600' }),
    body: { paddingHorizontal: tokens_1.space.lg, paddingBottom: 40, gap: 12 },
    warnBox: { backgroundColor: '#FFF8E7', borderRadius: tokens_1.radius.md, padding: 10, gap: 4 },
    warnRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    warnText: __assign(__assign({}, tokens_1.type.small), { color: '#8B6914', flex: 1 }),
    title: __assign(__assign({}, tokens_1.type.title), { fontSize: 20, color: tokens_1.color.ink }),
    badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    badge: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
    badgeText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '600', fontSize: 11 }),
    field: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    fieldIcon: {},
    fieldText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, flex: 1 }),
    privateTag: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    notesBox: { gap: 4 },
    notesLabel: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontWeight: '600' }),
    notesText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, lineHeight: 22 }),
    sourceHint: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.faint }),
    statusSection: { gap: 8, marginTop: 4 },
    statusLabel: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontWeight: '600' }),
    statusRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    statusChip: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
    statusChipText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '600', fontSize: 11 }),
});
var ef = react_native_1.StyleSheet.create({
    wrap: { gap: 10 },
    row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
    sectionLabel: __assign(__assign({}, tokens_1.type.title), { fontSize: 16, color: tokens_1.color.ink }),
    label: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontWeight: '600', marginTop: 2 }),
    opt: { fontWeight: '400', color: tokens_1.color.faint },
    input: __assign(__assign({ backgroundColor: tokens_1.color.haze, borderRadius: tokens_1.radius.md, padding: 10 }, tokens_1.type.body), { color: tokens_1.color.ink }),
    inputMulti: { minHeight: 72 },
    picker: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: tokens_1.color.haze, borderRadius: tokens_1.radius.md, padding: 10 },
    dateField: { borderWidth: 0, backgroundColor: tokens_1.color.haze, borderRadius: tokens_1.radius.md, padding: 10 },
    pickerText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink }),
    catList: { borderWidth: 1, borderColor: tokens_1.color.haze, borderRadius: tokens_1.radius.md, overflow: 'hidden', marginTop: 2 },
    catOption: { paddingHorizontal: tokens_1.space.md, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: tokens_1.color.haze },
    catOptionActive: { backgroundColor: tokens_1.color.deep },
    catOptionText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink }),
    catOptionTextActive: { color: '#fff', fontWeight: '700' },
    statusRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    statusChip: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, backgroundColor: tokens_1.color.haze },
    statusChipActive: { backgroundColor: tokens_1.color.deep },
    statusChipText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontWeight: '600' }),
    statusChipTextActive: { color: '#fff' },
    error: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal }),
    saveBtn: { backgroundColor: tokens_1.color.deep, borderRadius: tokens_1.radius.md, padding: 13, alignItems: 'center', marginTop: 4 },
    saveBtnDim: { opacity: 0.55 },
    saveText: __assign(__assign({}, tokens_1.type.body), { color: '#fff', fontWeight: '700' }),
});
