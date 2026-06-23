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
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TripPlanSettingsSheet = TripPlanSettingsSheet;
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var tripPlan_1 = require("../services/tripPlan");
var tokens_1 = require("../theme/tokens");
var PERMISSION_OPTIONS = [
    {
        value: 'all_members',
        label: 'All members',
        description: 'Any accepted trip member can add and edit plan items.',
        icon: <lucide_react_native_1.Users size={18} color={tokens_1.color.deep}/>,
    },
    {
        value: 'specific_members',
        label: 'Specific members',
        description: 'Only members you choose (plus you) can edit the plan.',
        icon: <lucide_react_native_1.UserCheck size={18} color="#7A4DBF"/>,
    },
    {
        value: 'owner_only',
        label: 'Owner only',
        description: 'Only you can edit the plan. Members can still view it.',
        icon: <lucide_react_native_1.Lock size={18} color={tokens_1.color.signal}/>,
    },
];
function TripPlanSettingsSheet(_a) {
    var _this = this;
    var visible = _a.visible, tripId = _a.tripId, onClose = _a.onClose, onSaved = _a.onSaved;
    var _b = (0, react_1.useState)(false), loading = _b[0], setLoading = _b[1];
    var _c = (0, react_1.useState)(false), saving = _c[0], setSaving = _c[1];
    var _d = (0, react_1.useState)('all_members'), permission = _d[0], setPermission = _d[1];
    var _e = (0, react_1.useState)([]), selectedEditors = _e[0], setSelectedEditors = _e[1];
    var _f = (0, react_1.useState)([]), members = _f[0], setMembers = _f[1];
    var _g = (0, react_1.useState)(false), membersLoading = _g[0], setMembersLoading = _g[1];
    var load = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var result, _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    setLoading(true);
                    _b.label = 1;
                case 1:
                    _b.trys.push([1, 3, 4, 5]);
                    return [4 /*yield*/, (0, tripPlan_1.fetchTripPlanPermission)(tripId)];
                case 2:
                    result = _b.sent();
                    setPermission(result.planEditPermission);
                    setSelectedEditors(result.planEditors);
                    return [3 /*break*/, 5];
                case 3:
                    _a = _b.sent();
                    return [3 /*break*/, 5];
                case 4:
                    setLoading(false);
                    return [7 /*endfinally*/];
                case 5: return [2 /*return*/];
            }
        });
    }); }, [tripId]);
    var loadMembers = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var apiBase, supabase, refreshed, session, _a, token, res, json, _b;
        var _c, _d, _e;
        return __generator(this, function (_f) {
            switch (_f.label) {
                case 0:
                    if (members.length > 0)
                        return [2 /*return*/];
                    setMembersLoading(true);
                    _f.label = 1;
                case 1:
                    _f.trys.push([1, 9, 10, 11]);
                    apiBase = (_c = process.env.EXPO_PUBLIC_API_BASE_URL) !== null && _c !== void 0 ? _c : '';
                    return [4 /*yield*/, Promise.resolve().then(function () { return require('../lib/supabase'); })];
                case 2:
                    supabase = (_f.sent()).supabase;
                    return [4 /*yield*/, supabase.auth.refreshSession()];
                case 3:
                    refreshed = (_f.sent()).data;
                    if (!((_d = refreshed === null || refreshed === void 0 ? void 0 : refreshed.session) !== null && _d !== void 0)) return [3 /*break*/, 4];
                    _a = _d;
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, supabase.auth.getSession()];
                case 5:
                    _a = (_f.sent()).data.session;
                    _f.label = 6;
                case 6:
                    session = _a;
                    token = session === null || session === void 0 ? void 0 : session.access_token;
                    if (!token)
                        return [2 /*return*/];
                    return [4 /*yield*/, fetch("".concat(apiBase, "/api/trips/").concat(tripId, "/members"), {
                            headers: { Authorization: "Bearer ".concat(token) },
                        })];
                case 7:
                    res = _f.sent();
                    if (!res.ok)
                        return [2 /*return*/];
                    return [4 /*yield*/, res.json()];
                case 8:
                    json = _f.sent();
                    setMembers((_e = json.members) !== null && _e !== void 0 ? _e : []);
                    return [3 /*break*/, 11];
                case 9:
                    _b = _f.sent();
                    return [3 /*break*/, 11];
                case 10:
                    setMembersLoading(false);
                    return [7 /*endfinally*/];
                case 11: return [2 /*return*/];
            }
        });
    }); }, [tripId, members.length]);
    (0, react_1.useEffect)(function () {
        if (visible) {
            load();
        }
    }, [visible, load]);
    (0, react_1.useEffect)(function () {
        if (visible && permission === 'specific_members') {
            loadMembers();
        }
    }, [visible, permission, loadMembers]);
    var toggleEditor = function (userId) {
        setSelectedEditors(function (prev) {
            return prev.includes(userId) ? prev.filter(function (id) { return id !== userId; }) : __spreadArray(__spreadArray([], prev, true), [userId], false);
        });
    };
    var handleSave = function () { return __awaiter(_this, void 0, void 0, function () {
        var editors, e_1;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    setSaving(true);
                    _b.label = 1;
                case 1:
                    _b.trys.push([1, 3, 4, 5]);
                    editors = permission === 'specific_members' ? selectedEditors : undefined;
                    return [4 /*yield*/, (0, tripPlan_1.updateTripPlanPermission)(tripId, permission, editors)];
                case 2:
                    _b.sent();
                    onSaved === null || onSaved === void 0 ? void 0 : onSaved();
                    onClose();
                    return [3 /*break*/, 5];
                case 3:
                    e_1 = _b.sent();
                    react_native_1.Alert.alert('Error', (_a = e_1.message) !== null && _a !== void 0 ? _a : 'Could not save settings');
                    return [3 /*break*/, 5];
                case 4:
                    setSaving(false);
                    return [7 /*endfinally*/];
                case 5: return [2 /*return*/];
            }
        });
    }); };
    return (<react_native_1.Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <react_native_1.Pressable style={s.overlay} onPress={onClose}/>
      <react_native_1.View style={s.sheet}>
        <react_native_1.View style={s.handle}/>

        <react_native_1.View style={s.header}>
          <react_native_1.Text style={s.title}>Plan editing</react_native_1.Text>
          <react_native_1.Pressable onPress={onClose} hitSlop={8}>
            <lucide_react_native_1.X size={20} color={tokens_1.color.mute}/>
          </react_native_1.Pressable>
        </react_native_1.View>

        <react_native_1.Text style={s.subtitle}>Who can add and edit items in this trip's plan?</react_native_1.Text>

        {loading ? (<react_native_1.ActivityIndicator color={tokens_1.color.signal} style={{ marginVertical: tokens_1.space.lg }}/>) : (<react_native_1.ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={s.body}>
            {PERMISSION_OPTIONS.map(function (opt) {
                var active = permission === opt.value;
                return (<react_native_1.Pressable key={opt.value} style={[s.option, active && s.optionActive]} onPress={function () { return setPermission(opt.value); }}>
                  <react_native_1.View style={s.optionIcon}>{opt.icon}</react_native_1.View>
                  <react_native_1.View style={s.optionText}>
                    <react_native_1.Text style={[s.optionLabel, active && s.optionLabelActive]}>{opt.label}</react_native_1.Text>
                    <react_native_1.Text style={s.optionDesc}>{opt.description}</react_native_1.Text>
                  </react_native_1.View>
                  {active && <lucide_react_native_1.CheckCircle2 size={18} color={tokens_1.color.deep}/>}
                </react_native_1.Pressable>);
            })}

            {permission === 'specific_members' && (<react_native_1.View style={s.memberSection}>
                <react_native_1.Text style={s.memberLabel}>Choose who can edit</react_native_1.Text>
                {membersLoading ? (<react_native_1.ActivityIndicator color={tokens_1.color.signal} style={{ marginVertical: tokens_1.space.md }}/>) : members.length === 0 ? (<react_native_1.Text style={s.noMembers}>No other members in this trip yet.</react_native_1.Text>) : (members.map(function (m) {
                    var selected = selectedEditors.includes(m.id);
                    return (<react_native_1.Pressable key={m.id} style={[s.memberRow, selected && s.memberRowActive]} onPress={function () { return toggleEditor(m.id); }}>
                        <react_native_1.View style={s.memberAvatar}>
                          <react_native_1.Text style={s.memberAvatarText}>{m.name.charAt(0).toUpperCase()}</react_native_1.Text>
                        </react_native_1.View>
                        <react_native_1.View style={s.memberInfo}>
                          <react_native_1.Text style={s.memberName}>{m.name}</react_native_1.Text>
                          <react_native_1.Text style={s.memberHandle}>@{m.handle}</react_native_1.Text>
                        </react_native_1.View>
                        {selected && <lucide_react_native_1.CheckCircle2 size={16} color={tokens_1.color.deep}/>}
                      </react_native_1.Pressable>);
                }))}
              </react_native_1.View>)}

            <react_native_1.View style={s.actions}>
              <react_native_1.Pressable style={s.cancelBtn} onPress={onClose} disabled={saving}>
                <react_native_1.Text style={s.cancelBtnText}>Cancel</react_native_1.Text>
              </react_native_1.Pressable>
              <react_native_1.Pressable style={[s.saveBtn, saving && s.saveBtnDisabled]} onPress={handleSave} disabled={saving}>
                {saving
                ? <react_native_1.ActivityIndicator size="small" color="#fff"/>
                : <react_native_1.Text style={s.saveBtnText}>Save</react_native_1.Text>}
              </react_native_1.Pressable>
            </react_native_1.View>
          </react_native_1.ScrollView>)}
      </react_native_1.View>
    </react_native_1.Modal>);
}
var s = react_native_1.StyleSheet.create({
    overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
    sheet: {
        backgroundColor: '#fff',
        borderTopLeftRadius: 24, borderTopRightRadius: 24,
        paddingHorizontal: tokens_1.space.lg, paddingBottom: 36, maxHeight: '80%',
    },
    handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: tokens_1.color.haze, alignSelf: 'center', marginTop: 10, marginBottom: tokens_1.space.md },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: tokens_1.space.sm },
    title: __assign(__assign({}, tokens_1.type.title), { color: tokens_1.color.ink, fontSize: 18 }),
    subtitle: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute, marginBottom: tokens_1.space.lg }),
    body: { gap: tokens_1.space.sm, paddingBottom: 4 },
    option: {
        flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.md,
        padding: tokens_1.space.md, borderRadius: tokens_1.radius.md,
        borderWidth: 1.5, borderColor: tokens_1.color.haze,
        backgroundColor: tokens_1.color.paperRaised,
    },
    optionActive: { borderColor: tokens_1.color.deep, backgroundColor: '#EEF4FF' },
    optionIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#F0F4FF', alignItems: 'center', justifyContent: 'center' },
    optionText: { flex: 1 },
    optionLabel: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 14 }),
    optionLabelActive: { color: tokens_1.color.deep },
    optionDesc: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, marginTop: 2, lineHeight: 18 }),
    memberSection: { marginTop: tokens_1.space.sm, gap: tokens_1.space.sm },
    memberLabel: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase', fontSize: 11 }),
    noMembers: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute, textAlign: 'center', paddingVertical: tokens_1.space.md }),
    memberRow: {
        flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.md,
        padding: tokens_1.space.md, borderRadius: tokens_1.radius.md,
        borderWidth: 1, borderColor: tokens_1.color.haze,
        backgroundColor: tokens_1.color.paperRaised,
    },
    memberRowActive: { borderColor: tokens_1.color.deep, backgroundColor: '#EEF4FF' },
    memberAvatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: tokens_1.color.deep, alignItems: 'center', justifyContent: 'center' },
    memberAvatarText: __assign(__assign({}, tokens_1.type.small), { color: '#fff', fontWeight: '700' }),
    memberInfo: { flex: 1 },
    memberName: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 14 }),
    memberHandle: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    actions: { flexDirection: 'row', gap: tokens_1.space.md, marginTop: tokens_1.space.lg },
    cancelBtn: { flex: 1, padding: tokens_1.space.md, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, alignItems: 'center' },
    cancelBtnText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.mute }),
    saveBtn: { flex: 1, padding: tokens_1.space.md, borderRadius: tokens_1.radius.md, backgroundColor: tokens_1.color.deep, alignItems: 'center' },
    saveBtnDisabled: { opacity: 0.6 },
    saveBtnText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: '#fff' }),
});
