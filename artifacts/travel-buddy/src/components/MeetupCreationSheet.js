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
exports.MeetupCreationSheet = MeetupCreationSheet;
/**
 * MeetupCreationSheet — bottom sheet for creating a meetup.
 *
 * Invite picker:
 *   - No context     → shows your friends list (flat)
 *   - tripId         → "Trip members" section (pre-selected, locked) +
 *                      "Other friends" section below
 *   - circleOwnerId  → "Circle members" section (pre-selected, locked) +
 *                      "Other friends" section below
 *
 * Group members are pre-selected and locked — they are the primary audience
 * for this meetup and will always be invited. Other friends are optional.
 *
 * Time proposals:
 *   - Off (default) → single approximate date + time-of-day block
 *   - On  → up to 5 date+block slots; addTimeOption called after creation
 *           Any slot failures are surfaced and the sheet stays open.
 *
 * Props:
 *   tripId        — pre-fill trip scope (optional)
 *   circleOwnerId — pre-fill circle scope (optional)
 *   onCreated     — callback after successful creation + time-slot posting
 *   onDismiss     — close the sheet
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var DateTimePickerField_1 = require("./DateTimePickerField");
var meetups_1 = require("../services/meetups");
var friends_1 = require("../services/friends");
var tokens_1 = require("../theme/tokens");
// ── Types ─────────────────────────────────────────────────────────────────────
var BLOCKS = [
    { key: 'morning', label: 'Morning' },
    { key: 'afternoon', label: 'Afternoon' },
    { key: 'evening', label: 'Evening' },
    { key: 'late', label: 'Late night' },
];
// ── Sub-components ────────────────────────────────────────────────────────────
function PersonAvatar(_a) {
    var _b, _c, _d, _e;
    var user = _a.user;
    if (user.avatarUrl)
        return <react_native_1.Image source={{ uri: user.avatarUrl }} style={sub.avatar}/>;
    return (<react_native_1.View style={[sub.avatar, sub.avatarFallback]}>
      <react_native_1.Text style={sub.avatarInitial}>
        {((_e = (_c = (_b = user.name) === null || _b === void 0 ? void 0 : _b[0]) !== null && _c !== void 0 ? _c : (_d = user.handle) === null || _d === void 0 ? void 0 : _d[0]) !== null && _e !== void 0 ? _e : '?').toUpperCase()}
      </react_native_1.Text>
    </react_native_1.View>);
}
function SelectedChips(_a) {
    var users = _a.users, lockedIds = _a.lockedIds, onRemove = _a.onRemove;
    if (users.length === 0)
        return null;
    return (<react_native_1.View style={sub.chips}>
      {users.map(function (u) {
            var locked = lockedIds.has(u.id);
            return (<react_native_1.View key={u.id} style={[sub.chip, locked && sub.chipLocked]}>
            <PersonAvatar user={u}/>
            <react_native_1.Text style={[sub.chipName, locked && sub.chipNameLocked]} numberOfLines={1}>
              {u.name || u.handle}
            </react_native_1.Text>
            {locked ? (<lucide_react_native_1.Check size={11} color={tokens_1.color.signal}/>) : (<react_native_1.Pressable onPress={function () { return onRemove(u.id); }} hitSlop={8}>
                <lucide_react_native_1.X size={12} color={tokens_1.color.mute}/>
              </react_native_1.Pressable>)}
          </react_native_1.View>);
        })}
    </react_native_1.View>);
}
function BlockPicker(_a) {
    var value = _a.value, onChange = _a.onChange, small = _a.small;
    return (<react_native_1.View style={[sub.blockRow, small && { gap: tokens_1.space.xs }]}>
      {BLOCKS.map(function (b) {
            var active = value === b.key;
            return (<react_native_1.Pressable key={b.key} style={[sub.blockBtn, active && sub.blockBtnActive, small && sub.blockBtnSmall]} onPress={function () { return onChange(active ? null : b.key); }}>
            <react_native_1.Text style={[sub.blockBtnText, active && sub.blockBtnTextActive,
                    small && { fontSize: 11 }]}>{b.label}</react_native_1.Text>
            {active && <lucide_react_native_1.Check size={small ? 10 : 11} color={tokens_1.color.onInk}/>}
          </react_native_1.Pressable>);
        })}
    </react_native_1.View>);
}
var TODAY_START = new Date();
TODAY_START.setHours(0, 0, 0, 0);
function TimeSlotRow(_a) {
    var slot = _a.slot, index = _a.index, onChange = _a.onChange, onRemove = _a.onRemove, canRemove = _a.canRemove;
    var isPast = slot.date !== null && slot.date < TODAY_START;
    return (<react_native_1.View style={[sub.slotCard, isPast && sub.slotCardPast]}>
      <react_native_1.View style={sub.slotHeader}>
        <react_native_1.Text style={sub.slotNum}>Slot {index + 1}</react_native_1.Text>
        {isPast && <react_native_1.Text style={sub.slotPastWarning}>Date is in the past</react_native_1.Text>}
        {canRemove && (<react_native_1.Pressable onPress={onRemove} hitSlop={8}>
            <lucide_react_native_1.Trash2 size={14} color={tokens_1.color.mute}/>
          </react_native_1.Pressable>)}
      </react_native_1.View>
      <DateTimePickerField_1.DatePickerField value={slot.date} onChange={function (d) { return onChange(__assign(__assign({}, slot), { date: d })); }} minimumDate={TODAY_START} placeholder="Pick a date"/>
      <react_native_1.View style={sub.slotTimeRow}>
        <react_native_1.View style={{ flex: 1 }}>
          <DateTimePickerField_1.DatePickerField mode="time" value={slot.proposedTime} onChange={function (t) { return onChange(__assign(__assign({}, slot), { proposedTime: t, block: null })); }} onClear={function () { return onChange(__assign(__assign({}, slot), { proposedTime: null })); }} placeholder="Pick a time (optional)"/>
        </react_native_1.View>
      </react_native_1.View>
      <react_native_1.View style={slot.proposedTime ? sub.blockRowDimmed : undefined}>
        <BlockPicker small value={slot.proposedTime ? null : slot.block} onChange={function (b) { if (!slot.proposedTime)
        onChange(__assign(__assign({}, slot), { block: b })); }}/>
      </react_native_1.View>
      {slot.proposedTime && (<react_native_1.Text style={sub.slotTimeNote}>Block ignored — exact time set above</react_native_1.Text>)}
    </react_native_1.View>);
}
// ── Main component ────────────────────────────────────────────────────────────
function MeetupCreationSheet(_a) {
    var _this = this;
    var tripId = _a.tripId, circleOwnerId = _a.circleOwnerId, onCreated = _a.onCreated, onDismiss = _a.onDismiss, initialTitle = _a.initialTitle, initialLocation = _a.initialLocation;
    // ── Details ──
    var _b = (0, react_1.useState)(initialTitle !== null && initialTitle !== void 0 ? initialTitle : ''), title = _b[0], setTitle = _b[1];
    var _c = (0, react_1.useState)(''), description = _c[0], setDescription = _c[1];
    var _d = (0, react_1.useState)(initialLocation !== null && initialLocation !== void 0 ? initialLocation : ''), locationName = _d[0], setLocationName = _d[1];
    var _e = (0, react_1.useState)(false), saving = _e[0], setSaving = _e[1];
    var _f = (0, react_1.useState)(null), error = _f[0], setError = _f[1];
    // ── Invite section ──
    var _g = (0, react_1.useState)(false), inviteOpen = _g[0], setInviteOpen = _g[1];
    var _h = (0, react_1.useState)([]), groupMembers = _h[0], setGroupMembers = _h[1];
    var _j = (0, react_1.useState)([]), otherFollowers = _j[0], setOtherFollowers = _j[1];
    var _k = (0, react_1.useState)(false), candidatesLoading = _k[0], setCandidatesLoading = _k[1];
    var _l = (0, react_1.useState)(false), candidatesLoaded = _l[0], setCandidatesLoaded = _l[1];
    var _m = (0, react_1.useState)(''), friendSearch = _m[0], setFriendSearch = _m[1];
    var _o = (0, react_1.useState)(new Set()), selectedIds = _o[0], setSelectedIds = _o[1];
    var _p = (0, react_1.useState)(new Set()), lockedIds = _p[0], setLockedIds = _p[1];
    var _q = (0, react_1.useState)([]), frequentInvitees = _q[0], setFrequentInvitees = _q[1];
    var _r = (0, react_1.useState)(false), frequentLoaded = _r[0], setFrequentLoaded = _r[1];
    // ── Time proposals ──
    var _s = (0, react_1.useState)(false), proposeMode = _s[0], setProposeMode = _s[1];
    var _t = (0, react_1.useState)([{ date: null, block: null, proposedTime: null }]), slots = _t[0], setSlots = _t[1];
    // ── Single-date (propose mode off) ──
    var _u = (0, react_1.useState)(null), approximateDate = _u[0], setApproximateDate = _u[1];
    var _v = (0, react_1.useState)(null), exactTime = _v[0], setExactTime = _v[1];
    var _w = (0, react_1.useState)(null), timeBlock = _w[0], setTimeBlock = _w[1];
    var defaultVisibility = tripId ? 'trip' : circleOwnerId ? 'circle' : 'invitees';
    // Fetch frequent invitees eagerly on mount (before invite section opens)
    (0, react_1.useEffect)(function () {
        var cancelled = false;
        (0, meetups_1.getFrequentInvitees)().then(function (res) {
            if (cancelled)
                return;
            if (res.ok && res.data) {
                var invitees_1 = res.data.invitees;
                setFrequentInvitees(invitees_1);
                // Pre-select them immediately (user can deselect)
                if (invitees_1.length > 0) {
                    setSelectedIds(function (prev) {
                        var next = new Set(prev);
                        invitees_1.forEach(function (u) { return next.add(u.id); });
                        return next;
                    });
                }
            }
            setFrequentLoaded(true);
        });
        return function () { cancelled = true; };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps
    // Load candidates:
    //   trip context   → groupMembers (locked, pre-selected) + otherFollowers
    //   circle context → groupMembers (locked, pre-selected) + otherFollowers
    //   plain          → otherFollowers only (friends list, flat)
    var loadCandidates = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var res, _a, gm, of_, ids_1, res, _b, gm, of_, ids_2, res, list;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    if (candidatesLoaded || candidatesLoading)
                        return [2 /*return*/];
                    setCandidatesLoading(true);
                    if (!tripId) return [3 /*break*/, 2];
                    return [4 /*yield*/, (0, friends_1.getTripInvitableUsers)(tripId)];
                case 1:
                    res = _c.sent();
                    if (res.ok && res.data) {
                        _a = res.data, gm = _a.groupMembers, of_ = _a.otherFollowers;
                        setGroupMembers(gm);
                        setOtherFollowers(of_);
                        ids_1 = new Set(gm.map(function (u) { return u.id; }));
                        setLockedIds(ids_1);
                        setSelectedIds(function (prev) {
                            var next = new Set(prev); // preserve frequent pre-selections
                            ids_1.forEach(function (id) { return next.add(id); });
                            return next;
                        });
                    }
                    return [3 /*break*/, 6];
                case 2:
                    if (!circleOwnerId) return [3 /*break*/, 4];
                    return [4 /*yield*/, (0, friends_1.getCircleInvitableUsers)(circleOwnerId)];
                case 3:
                    res = _c.sent();
                    if (res.ok && res.data) {
                        _b = res.data, gm = _b.groupMembers, of_ = _b.otherFollowers;
                        setGroupMembers(gm);
                        setOtherFollowers(of_);
                        ids_2 = new Set(gm.map(function (u) { return u.id; }));
                        setLockedIds(ids_2);
                        setSelectedIds(function (prev) {
                            var next = new Set(prev); // preserve frequent pre-selections
                            ids_2.forEach(function (id) { return next.add(id); });
                            return next;
                        });
                    }
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, (0, friends_1.getMyFriends)()];
                case 5:
                    res = _c.sent();
                    list = (res.ok && res.data) ? res.data.friends : [];
                    setOtherFollowers(list);
                    _c.label = 6;
                case 6:
                    setCandidatesLoading(false);
                    setCandidatesLoaded(true);
                    return [2 /*return*/];
            }
        });
    }); }, [candidatesLoaded, candidatesLoading, tripId, circleOwnerId]);
    (0, react_1.useEffect)(function () {
        if (inviteOpen)
            loadCandidates();
    }, [inviteOpen, loadCandidates]);
    var allCandidates = __spreadArray(__spreadArray([], groupMembers, true), otherFollowers, true);
    var selectedCandidates = allCandidates.filter(function (c) { return selectedIds.has(c.id); });
    var filterUser = function (c) {
        var _a, _b, _c;
        if (!friendSearch)
            return true;
        var q = friendSearch.toLowerCase();
        return (_c = (((_a = c.name) === null || _a === void 0 ? void 0 : _a.toLowerCase().includes(q)) || ((_b = c.handle) === null || _b === void 0 ? void 0 : _b.toLowerCase().includes(q)))) !== null && _c !== void 0 ? _c : false;
    };
    var filteredGroup = groupMembers.filter(filterUser);
    var filteredOthers = otherFollowers.filter(filterUser);
    function toggleCandidate(id) {
        if (lockedIds.has(id))
            return;
        setSelectedIds(function (prev) {
            var next = new Set(prev);
            if (next.has(id))
                next.delete(id);
            else
                next.add(id);
            return next;
        });
    }
    var hasContext = !!(tripId || circleOwnerId);
    var groupLabel = tripId ? 'Trip members' : 'Circle members';
    var hasCandidates = candidatesLoaded && (groupMembers.length > 0 || otherFollowers.length > 0);
    function addSlot() {
        if (slots.length >= 5)
            return;
        setSlots(function (prev) { return __spreadArray(__spreadArray([], prev, true), [{ date: null, block: null, proposedTime: null }], false); });
    }
    function removeSlot(i) {
        setSlots(function (prev) { return prev.filter(function (_, idx) { return idx !== i; }); });
    }
    function updateSlot(i, s) {
        setSlots(function (prev) { return prev.map(function (x, idx) { return (idx === i ? s : x); }); });
    }
    function toISODate(d) {
        var y = d.getFullYear();
        var m = String(d.getMonth() + 1).padStart(2, '0');
        var day = String(d.getDate()).padStart(2, '0');
        return "".concat(y, "-").concat(m, "-").concat(day);
    }
    function combineDateTime(date, time) {
        var y = date.getFullYear();
        var m = String(date.getMonth() + 1).padStart(2, '0');
        var day = String(date.getDate()).padStart(2, '0');
        var h = String(time.getHours()).padStart(2, '0');
        var min = String(time.getMinutes()).padStart(2, '0');
        return "".concat(y, "-").concat(m, "-").concat(day, "T").concat(h, ":").concat(min, ":00");
    }
    function handleCreate() {
        return __awaiter(this, void 0, void 0, function () {
            var trimmed, validSlots, pastSlots, res, meetupId, slotResults, failed;
            var _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        trimmed = title.trim();
                        if (!trimmed) {
                            setError('Please enter a title');
                            return [2 /*return*/];
                        }
                        // Validate: single-date mode — past date check
                        if (!proposeMode && approximateDate && approximateDate < TODAY_START) {
                            setError('The selected date is in the past. Please choose a future date.');
                            return [2 /*return*/];
                        }
                        validSlots = proposeMode
                            ? slots.filter(function (s) { return s.date !== null; })
                            : [];
                        if (proposeMode && validSlots.length === 0) {
                            setError('Pick a date for at least one time slot.');
                            return [2 /*return*/];
                        }
                        pastSlots = validSlots.filter(function (s) { return s.date < TODAY_START; });
                        if (pastSlots.length > 0) {
                            setError("".concat(pastSlots.length, " slot").concat(pastSlots.length > 1 ? 's are' : ' is', " in the past. Remove or update them first."));
                            return [2 /*return*/];
                        }
                        setSaving(true);
                        setError(null);
                        return [4 /*yield*/, (0, meetups_1.createMeetup)({
                                title: trimmed,
                                description: description.trim() || undefined,
                                locationName: locationName.trim() || undefined,
                                approximateDate: (!proposeMode && approximateDate) ? toISODate(approximateDate) : undefined,
                                timeBlock: (!proposeMode && !exactTime && timeBlock) ? timeBlock : undefined,
                                startsAt: (!proposeMode && approximateDate && exactTime)
                                    ? combineDateTime(approximateDate, exactTime)
                                    : undefined,
                                tripId: tripId,
                                circleOwnerId: circleOwnerId,
                                visibility: defaultVisibility,
                                inviteeIds: selectedIds.size > 0 ? __spreadArray([], selectedIds, true) : undefined,
                            })];
                    case 1:
                        res = _b.sent();
                        if (!res.ok || !res.data) {
                            setSaving(false);
                            setError((_a = res.message) !== null && _a !== void 0 ? _a : 'Could not create meetup');
                            return [2 /*return*/];
                        }
                        meetupId = res.data.id;
                        if (!(proposeMode && validSlots.length > 0)) return [3 /*break*/, 3];
                        return [4 /*yield*/, Promise.all(validSlots.map(function (slot) {
                                var _a;
                                var pt = slot.proposedTime;
                                var proposedTime = pt
                                    ? "".concat(String(pt.getHours()).padStart(2, '0'), ":").concat(String(pt.getMinutes()).padStart(2, '0'))
                                    : undefined;
                                return (0, meetups_1.addTimeOption)(meetupId, {
                                    proposedDate: toISODate(slot.date),
                                    proposedTime: proposedTime,
                                    timeBlock: proposedTime ? undefined : ((_a = slot.block) !== null && _a !== void 0 ? _a : undefined),
                                });
                            }))];
                    case 2:
                        slotResults = _b.sent();
                        failed = slotResults.filter(function (r) { return !r.ok; });
                        if (failed.length > 0) {
                            setSaving(false);
                            setError("Meetup created, but ".concat(failed.length, " time slot").concat(failed.length > 1 ? 's' : '', " could not be saved. ") +
                                "You can add them from the meetup page.");
                            // Still proceed — meetup exists; partial slot failures are recoverable
                            onCreated === null || onCreated === void 0 ? void 0 : onCreated(res.data);
                            return [2 /*return*/];
                        }
                        _b.label = 3;
                    case 3:
                        setSaving(false);
                        onCreated === null || onCreated === void 0 ? void 0 : onCreated(res.data);
                        onDismiss();
                        return [2 /*return*/];
                }
            });
        });
    }
    var inviteLabel = tripId ? 'Trip members' : circleOwnerId ? 'Circle members' : 'Friends';
    return (<react_native_1.KeyboardAvoidingView behavior={react_native_1.Platform.OS === 'ios' ? 'padding' : 'height'} style={s.kav}>
      <react_native_1.View style={s.backdrop}>
        <react_native_1.View style={s.sheet}>

          {/* Header */}
          <react_native_1.View style={s.sheetHead}>
            <react_native_1.Text style={s.sheetTitle}>New Meetup</react_native_1.Text>
            {(tripId || circleOwnerId) && (<react_native_1.View style={s.scopeBadge}>
                <lucide_react_native_1.Users size={11} color={tokens_1.color.signal}/>
                <react_native_1.Text style={s.scopeText}>{tripId ? 'Trip' : 'Circle'}</react_native_1.Text>
              </react_native_1.View>)}
            <react_native_1.View style={{ flex: 1 }}/>
            <react_native_1.Pressable onPress={onDismiss} hitSlop={8}><lucide_react_native_1.X size={20} color={tokens_1.color.ink}/></react_native_1.Pressable>
          </react_native_1.View>

          <react_native_1.ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">

            {/* ── Details ── */}
            <react_native_1.Text style={s.label}>Title *</react_native_1.Text>
            <react_native_1.TextInput style={s.input} placeholder="e.g. Sunset drinks at a rooftop bar" placeholderTextColor={tokens_1.color.faint} value={title} onChangeText={setTitle} maxLength={200} autoFocus/>

            <react_native_1.View style={s.labelRow}>
              <lucide_react_native_1.MapPin size={12} color={tokens_1.color.mute}/>
              <react_native_1.Text style={s.label}>Location</react_native_1.Text>
            </react_native_1.View>
            <react_native_1.TextInput style={s.input} placeholder="e.g. Mango Square, Cebu" placeholderTextColor={tokens_1.color.faint} value={locationName} onChangeText={setLocationName} maxLength={300}/>

            <react_native_1.Text style={s.label}>Description (optional)</react_native_1.Text>
            <react_native_1.TextInput style={[s.input, { minHeight: 60, textAlignVertical: 'top' }]} placeholder="What's the plan?" placeholderTextColor={tokens_1.color.faint} value={description} onChangeText={setDescription} maxLength={1000} multiline/>

            {/* ── Invite people ── */}
            <react_native_1.View style={s.divider}/>
            <react_native_1.Pressable style={s.sectionToggle} onPress={function () { return setInviteOpen(function (v) { return !v; }); }}>
              <lucide_react_native_1.Users size={14} color={tokens_1.color.ink}/>
              <react_native_1.Text style={s.sectionToggleText}>Invite {inviteLabel}</react_native_1.Text>
              {selectedIds.size > 0 && (<react_native_1.View style={s.countBadge}>
                  <react_native_1.Text style={s.countBadgeText}>{selectedIds.size}</react_native_1.Text>
                </react_native_1.View>)}
              <react_native_1.View style={{ flex: 1 }}/>
              {inviteOpen
            ? <lucide_react_native_1.ChevronUp size={16} color={tokens_1.color.mute}/>
            : <lucide_react_native_1.ChevronDown size={16} color={tokens_1.color.mute}/>}
            </react_native_1.Pressable>

            {inviteOpen && (<react_native_1.View style={s.inviteBody}>
                <SelectedChips users={selectedCandidates} lockedIds={lockedIds} onRemove={toggleCandidate}/>
                {/* ── Usually invite section (pre-selected frequent invitees) ── */}
                {frequentInvitees.length > 0 && (<>
                    <react_native_1.View style={s.sectionHeaderRow}>
                      <react_native_1.Text style={s.sectionHeaderText}>Usually invite</react_native_1.Text>
                    </react_native_1.View>
                    <react_native_1.View style={s.candidateList}>
                      {frequentInvitees.map(function (c) {
                    var selected = selectedIds.has(c.id);
                    var locked = lockedIds.has(c.id);
                    return (<react_native_1.Pressable key={c.id} style={[s.candidateRow, (selected || locked) && s.candidateRowActive, locked && s.candidateRowLocked]} onPress={function () { return !locked && toggleCandidate(c.id); }}>
                            <PersonAvatar user={c}/>
                            <react_native_1.View style={{ flex: 1 }}>
                              <react_native_1.Text style={s.candidateName} numberOfLines={1}>{c.name || c.handle}</react_native_1.Text>
                              {c.name && c.handle
                            ? <react_native_1.Text style={s.candidateHandle} numberOfLines={1}>@{c.handle}</react_native_1.Text>
                            : null}
                            </react_native_1.View>
                            {locked ? (<react_native_1.View style={s.checkboxLocked}>
                                <lucide_react_native_1.Check size={11} color={tokens_1.color.signal}/>
                              </react_native_1.View>) : (<react_native_1.View style={[s.checkbox, selected && s.checkboxActive]}>
                                {selected && <lucide_react_native_1.Check size={11} color={tokens_1.color.onInk}/>}
                              </react_native_1.View>)}
                          </react_native_1.Pressable>);
                })}
                    </react_native_1.View>
                  </>)}

                {candidatesLoading ? (<react_native_1.ActivityIndicator size="small" color={tokens_1.color.signal} style={{ marginVertical: tokens_1.space.md }}/>) : !hasCandidates ? (<react_native_1.Text style={s.emptyNote}>
                    {hasContext
                    ? 'No members found. You can still create the meetup.'
                    : 'No friends yet — connect with travelers first.'}
                  </react_native_1.Text>) : (<>
                    <react_native_1.View style={s.searchRow}>
                      <lucide_react_native_1.Search size={14} color={tokens_1.color.mute}/>
                      <react_native_1.TextInput style={s.searchInput} placeholder="Search…" placeholderTextColor={tokens_1.color.faint} value={friendSearch} onChangeText={setFriendSearch} autoCapitalize="none"/>
                    </react_native_1.View>

                    {/* ── Group members section (trip / circle context) ── */}
                    {hasContext && filteredGroup.length > 0 && (<>
                        <react_native_1.View style={s.sectionHeaderRow}>
                          <react_native_1.Text style={s.sectionHeaderText}>{groupLabel}</react_native_1.Text>
                          <react_native_1.Text style={s.sectionHeaderHint}>Always invited</react_native_1.Text>
                        </react_native_1.View>
                        <react_native_1.View style={s.candidateList}>
                          {filteredGroup.map(function (c) { return (<react_native_1.View key={c.id} style={[s.candidateRow, s.candidateRowLocked]}>
                              <PersonAvatar user={c}/>
                              <react_native_1.View style={{ flex: 1 }}>
                                <react_native_1.Text style={s.candidateName} numberOfLines={1}>{c.name || c.handle}</react_native_1.Text>
                                {c.name && c.handle
                            ? <react_native_1.Text style={s.candidateHandle} numberOfLines={1}>@{c.handle}</react_native_1.Text>
                            : null}
                              </react_native_1.View>
                              <react_native_1.View style={s.checkboxLocked}>
                                <lucide_react_native_1.Check size={11} color={tokens_1.color.signal}/>
                              </react_native_1.View>
                            </react_native_1.View>); })}
                          {filteredGroup.length === 0 && friendSearch ? (<react_native_1.Text style={s.emptyNote}>No match in {groupLabel.toLowerCase()}</react_native_1.Text>) : null}
                        </react_native_1.View>
                      </>)}

                    {/* ── Other followers section ── */}
                    {filteredOthers.length > 0 && (<>
                        {hasContext && (<react_native_1.View style={s.sectionHeaderRow}>
                            <react_native_1.Text style={s.sectionHeaderText}>Other friends</react_native_1.Text>
                          </react_native_1.View>)}
                        <react_native_1.View style={s.candidateList}>
                          {filteredOthers.map(function (c) {
                        var selected = selectedIds.has(c.id);
                        return (<react_native_1.Pressable key={c.id} style={[s.candidateRow, selected && s.candidateRowActive]} onPress={function () { return toggleCandidate(c.id); }}>
                                <PersonAvatar user={c}/>
                                <react_native_1.View style={{ flex: 1 }}>
                                  <react_native_1.Text style={s.candidateName} numberOfLines={1}>
                                    {c.name || c.handle}
                                  </react_native_1.Text>
                                  {c.name && c.handle
                                ? <react_native_1.Text style={s.candidateHandle} numberOfLines={1}>@{c.handle}</react_native_1.Text>
                                : null}
                                </react_native_1.View>
                                <react_native_1.View style={[s.checkbox, selected && s.checkboxActive]}>
                                  {selected && <lucide_react_native_1.Check size={11} color={tokens_1.color.onInk}/>}
                                </react_native_1.View>
                              </react_native_1.Pressable>);
                    })}
                          {filteredOthers.length === 0 && friendSearch ? (<react_native_1.Text style={s.emptyNote}>No match for "{friendSearch}"</react_native_1.Text>) : null}
                        </react_native_1.View>
                      </>)}

                    {/* Empty state: all followers already in the group */}
                    {hasContext && !friendSearch && candidatesLoaded && otherFollowers.length === 0 && (<react_native_1.Text style={s.emptyNote}>
                        All your friends are already in this {tripId ? 'trip' : 'circle'}.
                      </react_native_1.Text>)}

                    {/* No results at all for this search */}
                    {friendSearch && filteredGroup.length === 0 && filteredOthers.length === 0 && (<react_native_1.Text style={s.emptyNote}>No match for "{friendSearch}"</react_native_1.Text>)}
                  </>)}
              </react_native_1.View>)}

            {/* ── Time proposals ── */}
            <react_native_1.View style={s.divider}/>
            <react_native_1.View style={s.proposeHeader}>
              <lucide_react_native_1.CalendarClock size={14} color={tokens_1.color.ink}/>
              <react_native_1.Text style={s.sectionToggleText}>Propose times</react_native_1.Text>
              <react_native_1.View style={{ flex: 1 }}/>
              <react_native_1.Pressable style={[s.toggle, proposeMode && s.toggleOn]} onPress={function () { return setProposeMode(function (v) { return !v; }); }}>
                <react_native_1.View style={[s.toggleThumb, proposeMode && s.toggleThumbOn]}/>
              </react_native_1.Pressable>
            </react_native_1.View>
            <react_native_1.Text style={s.proposeHint}>
              {proposeMode
            ? 'Invitees vote on your proposed times — you confirm the winner.'
            : 'Off — set a single approximate date and time of day.'}
            </react_native_1.Text>

            {!proposeMode ? (<react_native_1.View style={s.singleDate}>
                <react_native_1.View style={s.labelRow}>
                  <lucide_react_native_1.CalendarClock size={12} color={tokens_1.color.mute}/>
                  <react_native_1.Text style={s.label}>Approximate date</react_native_1.Text>
                </react_native_1.View>
                <DateTimePickerField_1.DatePickerField value={approximateDate} onChange={setApproximateDate} minimumDate={TODAY_START} placeholder="Pick a date (optional)"/>
                {approximateDate && approximateDate < TODAY_START && (<react_native_1.Text style={s.fieldWarning}>This date is in the past</react_native_1.Text>)}
                <react_native_1.View style={s.timeLabelRow}>
                  <react_native_1.Text style={s.label}>Exact time</react_native_1.Text>
                  <react_native_1.Text style={s.labelHint}>(optional)</react_native_1.Text>
                </react_native_1.View>
                <DateTimePickerField_1.DatePickerField mode="time" value={exactTime} onChange={function (t) { setExactTime(t); setTimeBlock(null); }} onClear={function () { return setExactTime(null); }} placeholder="Pick a time"/>
                <react_native_1.Text style={s.label}>
                  {exactTime ? 'Time of day (overridden by exact time above)' : 'Time of day'}
                </react_native_1.Text>
                <BlockPicker value={exactTime ? null : timeBlock} onChange={function (b) { setTimeBlock(b); setExactTime(null); }}/>
              </react_native_1.View>) : (<react_native_1.View style={{ gap: tokens_1.space.sm }}>
                {slots.map(function (slot, i) { return (<TimeSlotRow key={i} slot={slot} index={i} onChange={function (updated) { return updateSlot(i, updated); }} onRemove={function () { return removeSlot(i); }} canRemove={slots.length > 1}/>); })}
                {slots.length < 5 && (<react_native_1.Pressable style={s.addSlotBtn} onPress={addSlot}>
                    <lucide_react_native_1.Plus size={14} color={tokens_1.color.signal}/>
                    <react_native_1.Text style={s.addSlotText}>Add another time ({slots.length}/5)</react_native_1.Text>
                  </react_native_1.Pressable>)}
              </react_native_1.View>)}

            {/* ── Error + Submit ── */}
            {error ? <react_native_1.Text style={s.errText}>{error}</react_native_1.Text> : null}

            <react_native_1.Pressable style={[s.createBtn, saving && { opacity: 0.6 }]} onPress={handleCreate} disabled={saving}>
              {saving ? <react_native_1.ActivityIndicator size="small" color={tokens_1.color.onInk}/> : null}
              <react_native_1.Text style={s.createBtnText}>
                {saving
            ? 'Creating…'
            : selectedIds.size > 0
                ? "Create & Invite ".concat(selectedIds.size)
                : 'Create Meetup'}
              </react_native_1.Text>
            </react_native_1.Pressable>

          </react_native_1.ScrollView>
        </react_native_1.View>
      </react_native_1.View>
    </react_native_1.KeyboardAvoidingView>);
}
// ── Sub-styles ────────────────────────────────────────────────────────────────
var sub = react_native_1.StyleSheet.create({
    avatar: { width: 32, height: 32, borderRadius: 16 },
    avatarFallback: { backgroundColor: tokens_1.color.haze, alignItems: 'center', justifyContent: 'center' },
    avatarInitial: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', color: tokens_1.color.ink, fontSize: 13 }),
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: tokens_1.space.sm, marginBottom: tokens_1.space.sm },
    chip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: tokens_1.space.sm, paddingVertical: 5, borderRadius: tokens_1.radius.pill, borderWidth: 1, borderColor: tokens_1.color.signal, backgroundColor: tokens_1.color.paperRaised, maxWidth: 150 },
    chipName: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, fontWeight: '700', fontSize: 11, flex: 1 }),
    chipLocked: { borderColor: tokens_1.color.haze, backgroundColor: tokens_1.color.paper },
    chipNameLocked: { color: tokens_1.color.mute },
    blockRow: { flexDirection: 'row', flexWrap: 'wrap', gap: tokens_1.space.sm },
    blockBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: tokens_1.space.md, paddingVertical: tokens_1.space.sm, borderRadius: tokens_1.radius.pill, borderWidth: 1, borderColor: tokens_1.color.haze, backgroundColor: tokens_1.color.paper },
    blockBtnSmall: { paddingHorizontal: tokens_1.space.sm, paddingVertical: 5 },
    blockBtnActive: { backgroundColor: tokens_1.color.signal, borderColor: tokens_1.color.signal },
    blockBtnText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', color: tokens_1.color.ink }),
    blockBtnTextActive: { color: tokens_1.color.onInk },
    slotCard: { backgroundColor: tokens_1.color.paper, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, padding: tokens_1.space.md, gap: tokens_1.space.sm },
    slotCardPast: { borderColor: '#FCA5A5', backgroundColor: '#FFF5F5' },
    slotHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    slotNum: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', color: tokens_1.color.ink, fontSize: 12 }),
    slotPastWarning: __assign(__assign({}, tokens_1.type.small), { color: '#DC2626', fontSize: 11, flex: 1, textAlign: 'center' }),
    slotTimeRow: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm },
    blockRowDimmed: { opacity: 0.35 },
    slotTimeNote: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 10, fontStyle: 'italic' }),
});
// ── Main styles ───────────────────────────────────────────────────────────────
var s = react_native_1.StyleSheet.create({
    kav: { position: 'absolute', bottom: 0, left: 0, right: 0 },
    backdrop: { flex: 1, justifyContent: 'flex-end' },
    sheet: { backgroundColor: tokens_1.color.paperRaised, borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, borderColor: tokens_1.color.haze, maxHeight: '92%' },
    sheetHead: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm, paddingHorizontal: tokens_1.space.lg, paddingTop: tokens_1.space.lg, paddingBottom: tokens_1.space.md, borderBottomWidth: 1, borderBottomColor: tokens_1.color.haze },
    sheetTitle: __assign(__assign({}, tokens_1.type.title), { color: tokens_1.color.ink, fontSize: 18 }),
    scopeBadge: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: tokens_1.space.sm, paddingVertical: 3, borderRadius: tokens_1.radius.pill, borderWidth: 1, borderColor: tokens_1.color.signal },
    scopeText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, fontWeight: '700', fontSize: 11 }),
    body: { padding: tokens_1.space.lg, gap: tokens_1.space.md, paddingBottom: tokens_1.space.xxxl },
    labelRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    label: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', color: tokens_1.color.ink, fontSize: 12 }),
    timeLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    labelHint: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
    input: __assign(__assign({ backgroundColor: tokens_1.color.paper, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, paddingHorizontal: tokens_1.space.md, paddingVertical: tokens_1.space.sm + 2 }, tokens_1.type.body), { color: tokens_1.color.ink }),
    divider: { height: 1, backgroundColor: tokens_1.color.haze, marginVertical: tokens_1.space.xs },
    sectionToggle: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm, paddingVertical: tokens_1.space.sm },
    sectionToggleText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontWeight: '700' }),
    countBadge: { backgroundColor: tokens_1.color.signal, borderRadius: 999, minWidth: 20, height: 20, paddingHorizontal: 5, alignItems: 'center', justifyContent: 'center' },
    countBadgeText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.onInk, fontWeight: '800', fontSize: 11 }),
    inviteBody: { gap: tokens_1.space.sm, marginTop: tokens_1.space.xs },
    searchRow: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm, backgroundColor: tokens_1.color.paper, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, paddingHorizontal: tokens_1.space.md, paddingVertical: tokens_1.space.sm },
    searchInput: __assign(__assign({ flex: 1 }, tokens_1.type.body), { color: tokens_1.color.ink, padding: 0 }),
    candidateList: { gap: 2, maxHeight: 240 },
    candidateRow: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm, padding: tokens_1.space.sm, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: 'transparent' },
    candidateRowActive: { backgroundColor: '#FFF0ED', borderColor: tokens_1.color.signal },
    candidateName: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontWeight: '600', fontSize: 14 }),
    candidateHandle: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
    checkbox: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, borderColor: tokens_1.color.haze, alignItems: 'center', justifyContent: 'center', backgroundColor: tokens_1.color.paper },
    checkboxActive: { backgroundColor: tokens_1.color.signal, borderColor: tokens_1.color.signal },
    checkboxLocked: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, borderColor: tokens_1.color.signal, alignItems: 'center', justifyContent: 'center', backgroundColor: tokens_1.color.paperRaised },
    candidateRowLocked: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm, padding: tokens_1.space.sm, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: 'transparent', opacity: 0.85 },
    sectionHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 4, paddingHorizontal: 2, marginTop: tokens_1.space.sm },
    sectionHeaderText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', color: tokens_1.color.signal, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }),
    sectionHeaderHint: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 10, fontStyle: 'italic' }),
    fieldWarning: __assign(__assign({}, tokens_1.type.small), { color: '#DC2626', fontSize: 11, marginTop: -tokens_1.space.xs }),
    emptyNote: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.faint, textAlign: 'center', paddingVertical: tokens_1.space.md }),
    proposeHeader: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm, paddingVertical: tokens_1.space.sm },
    proposeHint: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11, marginTop: -tokens_1.space.sm }),
    toggle: { width: 44, height: 26, borderRadius: 13, backgroundColor: tokens_1.color.haze, justifyContent: 'center', paddingHorizontal: 2 },
    toggleOn: { backgroundColor: tokens_1.color.signal },
    toggleThumb: { width: 22, height: 22, borderRadius: 11, backgroundColor: tokens_1.color.paperRaised },
    toggleThumbOn: { alignSelf: 'flex-end' },
    singleDate: { gap: tokens_1.space.md },
    addSlotBtn: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm, paddingVertical: tokens_1.space.sm, paddingHorizontal: tokens_1.space.md, borderRadius: tokens_1.radius.md, borderWidth: 1, borderStyle: 'dashed', borderColor: tokens_1.color.signal },
    addSlotText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.signal, fontSize: 13 }),
    errText: __assign(__assign({}, tokens_1.type.small), { color: '#DC2626', textAlign: 'center' }),
    createBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: tokens_1.color.signal, borderRadius: tokens_1.radius.md, paddingVertical: tokens_1.space.md },
    createBtnText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.onInk }),
});
