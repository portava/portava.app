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
exports.default = Settings;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var lucide_react_native_1 = require("lucide-react-native");
var ScreenHeader_1 = require("../src/components/ScreenHeader");
var SessionContext_1 = require("../src/context/SessionContext");
var tokens_1 = require("../src/theme/tokens");
var telegraphChat_1 = require("../src/services/telegraphChat");
var intelligence_1 = require("../src/services/intelligence");
var language_picker_1 = require("./language-picker");
var LanguagePreferenceContext_1 = require("../src/context/LanguagePreferenceContext");
function Settings() {
    var _this = this;
    var _a, _b;
    var _c = (0, SessionContext_1.useSession)(), signOut = _c.signOut, isAuthed = _c.isAuthed, configured = _c.configured;
    var _d = (0, react_1.useState)(true), telegraphDM = _d[0], setTelegraphDM = _d[1];
    var _e = (0, react_1.useState)(true), telegraphTrip = _e[0], setTelegraphTrip = _e[1];
    var _f = (0, react_1.useState)(true), telegraphCircle = _f[0], setTelegraphCircle = _f[1];
    var preferredLanguage = (0, LanguagePreferenceContext_1.useLanguagePreference)().preferredLanguage;
    var _g = (0, react_1.useState)(false), prefLoading = _g[0], setPrefLoading = _g[1];
    var _h = (0, react_1.useState)(false), prefSaving = _h[0], setPrefSaving = _h[1];
    var _j = (0, react_1.useState)('balanced'), pace = _j[0], setPace = _j[1];
    var _k = (0, react_1.useState)('mixed'), groupStyle = _k[0], setGroupStyle = _k[1];
    var _l = (0, react_1.useState)([]), interests = _l[0], setInterests = _l[1];
    var _m = (0, react_1.useState)([]), avoidList = _m[0], setAvoidList = _m[1];
    var _o = (0, react_1.useState)(''), avoidInput = _o[0], setAvoidInput = _o[1];
    var _p = (0, react_1.useState)([]), foodPreferences = _p[0], setFoodPreferences = _p[1];
    var _q = (0, react_1.useState)([]), nightlifePreferences = _q[0], setNightlifePreferences = _q[1];
    var _r = (0, react_1.useState)([]), prefTimes = _r[0], setPrefTimes = _r[1];
    var live = configured && isAuthed;
    var loadPrefs = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var res, e;
        var _a, _b, _c, _d, _e, _f, _g, _h;
        return __generator(this, function (_j) {
            switch (_j.label) {
                case 0:
                    if (!live)
                        return [2 /*return*/];
                    setPrefLoading(true);
                    return [4 /*yield*/, (0, intelligence_1.fetchPreferences)()];
                case 1:
                    res = _j.sent();
                    setPrefLoading(false);
                    if (res.ok && ((_a = res.data) === null || _a === void 0 ? void 0 : _a.explicit)) {
                        e = res.data.explicit;
                        setPace((_b = e.pace) !== null && _b !== void 0 ? _b : 'balanced');
                        setGroupStyle((_c = e.groupStyle) !== null && _c !== void 0 ? _c : 'mixed');
                        setInterests((_d = e.interests) !== null && _d !== void 0 ? _d : []);
                        setAvoidList((_e = e.avoidList) !== null && _e !== void 0 ? _e : []);
                        setFoodPreferences((_f = e.foodPreferences) !== null && _f !== void 0 ? _f : []);
                        setNightlifePreferences((_g = e.nightlifePreferences) !== null && _g !== void 0 ? _g : []);
                        setPrefTimes((_h = e.preferredActivityTimes) !== null && _h !== void 0 ? _h : []);
                    }
                    return [2 /*return*/];
            }
        });
    }); }, [live]);
    (0, react_1.useEffect)(function () { loadPrefs(); }, [loadPrefs]);
    function savePref(patch) {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!live)
                            return [2 /*return*/];
                        setPrefSaving(true);
                        return [4 /*yield*/, (0, intelligence_1.patchPreferences)(patch)];
                    case 1:
                        _a.sent();
                        setPrefSaving(false);
                        return [2 /*return*/];
                }
            });
        });
    }
    function handleResetLearned() {
        return __awaiter(this, void 0, void 0, function () {
            var _this = this;
            return __generator(this, function (_a) {
                if (!live)
                    return [2 /*return*/];
                react_native_1.Alert.alert('Reset learned preferences?', 'Travel Buddy will forget what it learned from your saves and dismissals. Your explicit preferences (interests, pace, avoid list) are kept.', [
                    { text: 'Cancel', style: 'cancel' },
                    {
                        text: 'Reset', style: 'destructive',
                        onPress: function () { return __awaiter(_this, void 0, void 0, function () {
                            return __generator(this, function (_a) {
                                switch (_a.label) {
                                    case 0: return [4 /*yield*/, (0, intelligence_1.resetLearnedPreferences)()];
                                    case 1:
                                        _a.sent();
                                        react_native_1.Alert.alert('Done', 'Learned preferences have been reset.');
                                        return [2 /*return*/];
                                }
                            });
                        }); },
                    },
                ]);
                return [2 /*return*/];
            });
        });
    }
    function toggleInterest(item) {
        var next = interests.includes(item) ? interests.filter(function (i) { return i !== item; }) : __spreadArray(__spreadArray([], interests, true), [item], false);
        setInterests(next);
        savePref({ interests: next });
    }
    function toggleFoodPref(item) {
        var next = foodPreferences.includes(item) ? foodPreferences.filter(function (f) { return f !== item; }) : __spreadArray(__spreadArray([], foodPreferences, true), [item], false);
        setFoodPreferences(next);
        savePref({ foodPreferences: next });
    }
    function toggleNightlifePref(item) {
        var next = nightlifePreferences.includes(item) ? nightlifePreferences.filter(function (n) { return n !== item; }) : __spreadArray(__spreadArray([], nightlifePreferences, true), [item], false);
        setNightlifePreferences(next);
        savePref({ nightlifePreferences: next });
    }
    function toggleTime(item) {
        var next = prefTimes.includes(item) ? prefTimes.filter(function (p) { return p !== item; }) : __spreadArray(__spreadArray([], prefTimes, true), [item], false);
        setPrefTimes(next);
        savePref({ preferredActivityTimes: next });
    }
    function addAvoid() {
        var trimmed = avoidInput.trim().toLowerCase();
        if (!trimmed || avoidList.includes(trimmed)) {
            setAvoidInput('');
            return;
        }
        var next = __spreadArray(__spreadArray([], avoidList, true), [trimmed], false);
        setAvoidList(next);
        setAvoidInput('');
        savePref({ avoidList: next });
    }
    function removeAvoid(item) {
        var next = avoidList.filter(function (a) { return a !== item; });
        setAvoidList(next);
        savePref({ avoidList: next });
    }
    function onItem(label) {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!(label === 'Log out')) return [3 /*break*/, 2];
                        return [4 /*yield*/, signOut()];
                    case 1:
                        _a.sent();
                        expo_router_1.router.replace('/(auth)/sign-in');
                        return [3 /*break*/, 3];
                    case 2:
                        if (label === 'Blocked accounts') {
                            expo_router_1.router.push('/blocked-users');
                        }
                        else if (label === 'Edit profile') {
                            expo_router_1.router.push('/profile/edit');
                        }
                        else if (label === 'Notifications') {
                            expo_router_1.router.push('/notifications');
                        }
                        else if (label === 'Hide current location' ||
                            label === 'Hide upcoming trips' ||
                            label === 'Private account' ||
                            label === 'Nearby visibility' ||
                            label === 'Message permissions') {
                            react_native_1.Alert.alert('Privacy Settings', "".concat(label, " preferences are coming soon."), [{ text: 'OK' }]);
                        }
                        else if (label === 'Report history' || label === 'Muted words') {
                            react_native_1.Alert.alert('Coming Soon', "".concat(label, " will be available in a future update."), [{ text: 'OK' }]);
                        }
                        _a.label = 3;
                    case 3: return [2 /*return*/];
                }
            });
        });
    }
    function handleTelegraphToggle(key, value) {
        return __awaiter(this, void 0, void 0, function () {
            var _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        if (key === 'show_telegraph_dm')
                            setTelegraphDM(value);
                        if (key === 'show_telegraph_trip')
                            setTelegraphTrip(value);
                        if (key === 'show_telegraph_circle')
                            setTelegraphCircle(value);
                        return [4 /*yield*/, (0, telegraphChat_1.updateTelegraphChatSettings)((_a = {}, _a[key] = value, _a)).catch(function () { })];
                    case 1:
                        _b.sent();
                        return [2 /*return*/];
                }
            });
        });
    }
    var BASIC_GROUPS = [
        { h: 'Privacy', items: ['Hide current location', 'Hide upcoming trips', 'Private account', 'Nearby visibility', 'Message permissions'] },
        { h: 'Safety', items: ['Blocked accounts', 'Report history', 'Muted words'] },
        { h: 'Account', items: ['Edit profile', 'Notifications', 'Log out'] },
    ];
    var INTERESTS_OPTIONS = ['beach', 'food', 'nightlife', 'adventure', 'culture', 'wellness', 'photography', 'shopping', 'luxury', 'backpacking'];
    var FOOD_OPTIONS = ['street food', 'seafood', 'vegetarian', 'vegan', 'local cuisine', 'fine dining', 'coffee'];
    var NIGHTLIFE_OPTIONS = ['bars', 'clubs', 'live music', 'rooftop', 'night markets'];
    var PACE_OPTIONS = [
        { value: 'relaxed', label: 'Relaxed', sub: 'Slow down, soak it in' },
        { value: 'balanced', label: 'Balanced', sub: 'Mix of plans + free time' },
        { value: 'packed', label: 'Packed', sub: 'Make the most of every day' },
    ];
    var GROUP_OPTIONS = [
        { value: 'solo', label: 'Solo' },
        { value: 'small', label: 'Small group (2–4)' },
        { value: 'group', label: 'Large group (5+)' },
        { value: 'mixed', label: 'Mixed / flexible' },
    ];
    var TIME_OPTIONS = ['morning', 'afternoon', 'evening', 'late_night'];
    var TIME_LABELS = { morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening', late_night: 'Late night' };
    return (<react_native_1.View style={{ flex: 1, backgroundColor: tokens_1.color.paper }}>
      <ScreenHeader_1.ScreenHeader title="Settings" back/>
      <react_native_1.ScrollView contentContainerStyle={{ padding: tokens_1.space.lg, gap: tokens_1.space.xl, paddingBottom: tokens_1.space.xxxl }}>

        {/* Telegraph suggestions section */}
        <react_native_1.View style={{ gap: tokens_1.space.sm }}>
          <react_native_1.View style={styles.sectionHeader}>
            <lucide_react_native_1.Zap size={13} color={tokens_1.color.signal} fill={tokens_1.color.signal}/>
            <react_native_1.Text style={styles.h}>Telegraph</react_native_1.Text>
          </react_native_1.View>
          <react_native_1.Text style={styles.sectionDesc}>
            Smart suggestions appear above the composer when Telegraph detects travel planning in your chats.
          </react_native_1.Text>

          <react_native_1.View style={styles.toggleRow}>
            <react_native_1.View style={{ flex: 1 }}>
              <react_native_1.Text style={styles.toggleLabel}>Direct messages</react_native_1.Text>
              <react_native_1.Text style={styles.toggleSub}>Show suggestions in 1-on-1 chats</react_native_1.Text>
            </react_native_1.View>
            <react_native_1.Switch value={telegraphDM} onValueChange={function (v) { return handleTelegraphToggle('show_telegraph_dm', v); }} trackColor={{ true: tokens_1.color.signal }} thumbColor={tokens_1.color.onInk}/>
          </react_native_1.View>

          <react_native_1.View style={styles.toggleRow}>
            <react_native_1.View style={{ flex: 1 }}>
              <react_native_1.Text style={styles.toggleLabel}>Trip chats</react_native_1.Text>
              <react_native_1.Text style={styles.toggleSub}>Show suggestions in trip group chats</react_native_1.Text>
            </react_native_1.View>
            <react_native_1.Switch value={telegraphTrip} onValueChange={function (v) { return handleTelegraphToggle('show_telegraph_trip', v); }} trackColor={{ true: tokens_1.color.signal }} thumbColor={tokens_1.color.onInk}/>
          </react_native_1.View>

          <react_native_1.View style={styles.toggleRow}>
            <react_native_1.View style={{ flex: 1 }}>
              <react_native_1.Text style={styles.toggleLabel}>Circle chats</react_native_1.Text>
              <react_native_1.Text style={styles.toggleSub}>Show suggestions in circle group chats</react_native_1.Text>
            </react_native_1.View>
            <react_native_1.Switch value={telegraphCircle} onValueChange={function (v) { return handleTelegraphToggle('show_telegraph_circle', v); }} trackColor={{ true: tokens_1.color.signal }} thumbColor={tokens_1.color.onInk}/>
          </react_native_1.View>
        </react_native_1.View>

        {/* Travel Preferences section */}
        <react_native_1.View style={{ gap: tokens_1.space.md }}>
          <react_native_1.View style={styles.sectionHeader}>
            <lucide_react_native_1.Brain size={13} color={tokens_1.color.deep}/>
            <react_native_1.Text style={styles.h}>Travel Preferences</react_native_1.Text>
            {prefSaving && <react_native_1.ActivityIndicator size="small" color={tokens_1.color.mute}/>}
          </react_native_1.View>
          <react_native_1.Text style={styles.sectionDesc}>
            Travel Buddy learns from what you save, dismiss, and add to trips so suggestions get better over time.
          </react_native_1.Text>

          {prefLoading ? (<react_native_1.View style={styles.loadRow}><react_native_1.ActivityIndicator color={tokens_1.color.signal}/><react_native_1.Text style={styles.loadText}>Loading…</react_native_1.Text></react_native_1.View>) : (<>
              {/* Interests */}
              <react_native_1.View style={{ gap: tokens_1.space.sm }}>
                <react_native_1.Text style={styles.prefLabel}>Interests</react_native_1.Text>
                <react_native_1.View style={styles.chipGrid}>
                  {INTERESTS_OPTIONS.map(function (i) { return (<react_native_1.Pressable key={i} style={[styles.chip, interests.includes(i) && styles.chipActive]} onPress={function () { return toggleInterest(i); }}>
                      <react_native_1.Text style={[styles.chipText, interests.includes(i) && styles.chipTextActive]}>{i}</react_native_1.Text>
                    </react_native_1.Pressable>); })}
                </react_native_1.View>
              </react_native_1.View>

              {/* Food preferences */}
              <react_native_1.View style={{ gap: tokens_1.space.sm }}>
                <react_native_1.Text style={styles.prefLabel}>Food preferences</react_native_1.Text>
                <react_native_1.View style={styles.chipGrid}>
                  {FOOD_OPTIONS.map(function (f) { return (<react_native_1.Pressable key={f} style={[styles.chip, foodPreferences.includes(f) && styles.chipActive]} onPress={function () { return toggleFoodPref(f); }}>
                      <react_native_1.Text style={[styles.chipText, foodPreferences.includes(f) && styles.chipTextActive]}>{f}</react_native_1.Text>
                    </react_native_1.Pressable>); })}
                </react_native_1.View>
              </react_native_1.View>

              {/* Nightlife preferences */}
              <react_native_1.View style={{ gap: tokens_1.space.sm }}>
                <react_native_1.Text style={styles.prefLabel}>Nightlife preferences</react_native_1.Text>
                <react_native_1.View style={styles.chipGrid}>
                  {NIGHTLIFE_OPTIONS.map(function (n) { return (<react_native_1.Pressable key={n} style={[styles.chip, nightlifePreferences.includes(n) && styles.chipActive]} onPress={function () { return toggleNightlifePref(n); }}>
                      <react_native_1.Text style={[styles.chipText, nightlifePreferences.includes(n) && styles.chipTextActive]}>{n}</react_native_1.Text>
                    </react_native_1.Pressable>); })}
                </react_native_1.View>
              </react_native_1.View>

              {/* Travel pace */}
              <react_native_1.View style={{ gap: tokens_1.space.sm }}>
                <react_native_1.Text style={styles.prefLabel}>Travel pace</react_native_1.Text>
                {PACE_OPTIONS.map(function (p) { return (<react_native_1.Pressable key={p.value} style={[styles.radioRow, pace === p.value && styles.radioRowActive]} onPress={function () { setPace(p.value); savePref({ pace: p.value }); }}>
                    <react_native_1.View style={[styles.radio, pace === p.value && styles.radioChecked]}/>
                    <react_native_1.View style={{ flex: 1 }}>
                      <react_native_1.Text style={styles.radioLabel}>{p.label}</react_native_1.Text>
                      <react_native_1.Text style={styles.radioSub}>{p.sub}</react_native_1.Text>
                    </react_native_1.View>
                  </react_native_1.Pressable>); })}
              </react_native_1.View>

              {/* Group style */}
              <react_native_1.View style={{ gap: tokens_1.space.sm }}>
                <react_native_1.Text style={styles.prefLabel}>Who do you travel with?</react_native_1.Text>
                <react_native_1.View style={styles.chipGrid}>
                  {GROUP_OPTIONS.map(function (g) { return (<react_native_1.Pressable key={g.value} style={[styles.chip, groupStyle === g.value && styles.chipActive]} onPress={function () { setGroupStyle(g.value); savePref({ groupStyle: g.value }); }}>
                      <react_native_1.Text style={[styles.chipText, groupStyle === g.value && styles.chipTextActive]}>{g.label}</react_native_1.Text>
                    </react_native_1.Pressable>); })}
                </react_native_1.View>
              </react_native_1.View>

              {/* Preferred activity times */}
              <react_native_1.View style={{ gap: tokens_1.space.sm }}>
                <react_native_1.Text style={styles.prefLabel}>Preferred activity times</react_native_1.Text>
                <react_native_1.View style={styles.chipGrid}>
                  {TIME_OPTIONS.map(function (tm) { return (<react_native_1.Pressable key={tm} style={[styles.chip, prefTimes.includes(tm) && styles.chipActive]} onPress={function () { return toggleTime(tm); }}>
                      <react_native_1.Text style={[styles.chipText, prefTimes.includes(tm) && styles.chipTextActive]}>{TIME_LABELS[tm]}</react_native_1.Text>
                    </react_native_1.Pressable>); })}
                </react_native_1.View>
              </react_native_1.View>

              {/* Avoid list */}
              <react_native_1.View style={{ gap: tokens_1.space.sm }}>
                <react_native_1.Text style={styles.prefLabel}>Avoid list</react_native_1.Text>
                <react_native_1.View style={styles.avoidInput}>
                  <react_native_1.TextInput style={styles.avoidField} value={avoidInput} onChangeText={setAvoidInput} placeholder="e.g. gambling, crowded places…" placeholderTextColor={tokens_1.color.faint} onSubmitEditing={addAvoid} returnKeyType="done" maxLength={50}/>
                  <react_native_1.Pressable style={styles.avoidAdd} onPress={addAvoid}><react_native_1.Text style={styles.avoidAddText}>Add</react_native_1.Text></react_native_1.Pressable>
                </react_native_1.View>
                {avoidList.length > 0 && (<react_native_1.View style={styles.chipGrid}>
                    {avoidList.map(function (a) { return (<react_native_1.Pressable key={a} style={[styles.chip, styles.chipDanger]} onPress={function () { return removeAvoid(a); }}>
                        <react_native_1.Text style={[styles.chipText, styles.chipTextDanger]}>{a} ×</react_native_1.Text>
                      </react_native_1.Pressable>); })}
                  </react_native_1.View>)}
              </react_native_1.View>

              {/* Reset learned */}
              <react_native_1.Pressable style={styles.resetBtn} onPress={handleResetLearned}>
                <react_native_1.Text style={styles.resetText}>Reset learned preferences</react_native_1.Text>
              </react_native_1.Pressable>
              <react_native_1.Text style={styles.resetSub}>Clears what Telegraph learned from your behaviour. Your explicit settings above are kept.</react_native_1.Text>
            </>)}
        </react_native_1.View>

        {/* Language section */}
        {live && (<react_native_1.View style={{ gap: tokens_1.space.sm }}>
            <react_native_1.View style={styles.sectionHeader}>
              <lucide_react_native_1.Globe size={13} color={tokens_1.color.deep}/>
              <react_native_1.Text style={styles.h}>Language</react_native_1.Text>
            </react_native_1.View>
            <react_native_1.Text style={styles.sectionDesc}>
              Incoming messages will be translated into your chosen language. Clear the selection to use your device locale.
            </react_native_1.Text>
            <react_native_1.Pressable style={function (_a) {
            var pressed = _a.pressed;
            return [styles.langRow, pressed && { opacity: tokens_1.layout.pressedOpacity }];
        }} onPress={function () {
                return expo_router_1.router.push({
                    pathname: '/language-picker',
                    params: { current: preferredLanguage !== null && preferredLanguage !== void 0 ? preferredLanguage : '', via: 'language-settings' },
                });
            }}>
              <react_native_1.View style={{ flex: 1 }}>
                <react_native_1.Text style={styles.langRowLabel}>Translation language</react_native_1.Text>
                <react_native_1.Text style={styles.langRowValue}>
                  {preferredLanguage
                ? ((_b = (_a = language_picker_1.SUPPORTED_LANGUAGES.find(function (l) { return l.code === preferredLanguage; })) === null || _a === void 0 ? void 0 : _a.name) !== null && _b !== void 0 ? _b : preferredLanguage)
                : 'Device locale (default)'}
                </react_native_1.Text>
              </react_native_1.View>
              <react_native_1.Text style={styles.langChevron}>›</react_native_1.Text>
            </react_native_1.Pressable>
          </react_native_1.View>)}

        {/* Standard settings groups */}
        {BASIC_GROUPS.map(function (g) { return (<react_native_1.View key={g.h} style={{ gap: tokens_1.space.sm }}>
            <react_native_1.Text style={styles.h}>{g.h}</react_native_1.Text>
            {g.items.map(function (i) {
                var isLogout = i === 'Log out';
                if (isLogout && !(configured && isAuthed))
                    return null;
                return (<react_native_1.Pressable key={i} style={function (_a) {
                    var pressed = _a.pressed;
                    return [styles.row, pressed && { opacity: tokens_1.layout.pressedOpacity }];
                }} onPress={function () { return onItem(i); }}>
                  <react_native_1.Text style={[styles.item, isLogout && styles.logout]}>{i}</react_native_1.Text>
                </react_native_1.Pressable>);
            })}
          </react_native_1.View>); })}
      </react_native_1.ScrollView>
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    h: __assign(__assign({}, tokens_1.type.stamp), { fontFamily: 'Courier', color: tokens_1.color.mute }),
    sectionDesc: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 12, lineHeight: 17 }),
    toggleRow: {
        flexDirection: 'row', alignItems: 'center',
        backgroundColor: tokens_1.color.paperRaised, borderWidth: 1, borderColor: tokens_1.color.haze,
        borderRadius: tokens_1.radius.md, paddingHorizontal: tokens_1.space.lg, paddingVertical: tokens_1.space.md, gap: tokens_1.space.md,
    },
    toggleLabel: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink }),
    toggleSub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 12, marginTop: 1 }),
    loadRow: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm, padding: tokens_1.space.md },
    loadText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    prefLabel: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 13 }),
    chipGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: tokens_1.space.sm },
    chip: {
        paddingHorizontal: tokens_1.space.md, paddingVertical: 6, borderRadius: tokens_1.radius.pill,
        borderWidth: 1, borderColor: tokens_1.color.haze, backgroundColor: tokens_1.color.paperRaised,
    },
    chipActive: { backgroundColor: tokens_1.color.deep, borderColor: tokens_1.color.deep },
    chipDanger: { backgroundColor: '#FFF0EE', borderColor: tokens_1.color.signal },
    chipText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.ink, fontSize: 12, fontWeight: '600' }),
    chipTextActive: { color: tokens_1.color.onInk },
    chipTextDanger: { color: tokens_1.color.signal },
    radioRow: {
        flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.md,
        backgroundColor: tokens_1.color.paperRaised, borderWidth: 1, borderColor: tokens_1.color.haze,
        borderRadius: tokens_1.radius.md, padding: tokens_1.space.md,
    },
    radioRowActive: { borderColor: tokens_1.color.deep, backgroundColor: '#EAF2F4' },
    radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: tokens_1.color.haze },
    radioChecked: { borderColor: tokens_1.color.deep, backgroundColor: tokens_1.color.deep },
    radioLabel: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 13 }),
    radioSub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
    avoidInput: { flexDirection: 'row', gap: tokens_1.space.sm },
    avoidField: __assign(__assign({ flex: 1, backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, paddingHorizontal: tokens_1.space.md, paddingVertical: tokens_1.space.sm }, tokens_1.type.body), { color: tokens_1.color.ink, fontSize: 13 }),
    avoidAdd: {
        paddingHorizontal: tokens_1.space.md, paddingVertical: tokens_1.space.sm, backgroundColor: tokens_1.color.deep,
        borderRadius: tokens_1.radius.md, alignItems: 'center', justifyContent: 'center',
    },
    avoidAddText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.onInk, fontWeight: '700' }),
    resetBtn: {
        backgroundColor: tokens_1.color.paperRaised, borderWidth: 1, borderColor: tokens_1.color.signal,
        borderRadius: tokens_1.radius.md, padding: tokens_1.space.md, alignItems: 'center',
    },
    resetText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.signal, fontSize: 13 }),
    resetSub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11, lineHeight: 16 }),
    row: { backgroundColor: tokens_1.color.paperRaised, borderWidth: 1, borderColor: tokens_1.color.haze, borderRadius: tokens_1.radius.md, padding: tokens_1.space.lg },
    item: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink }),
    logout: { color: tokens_1.color.signal, fontWeight: '700' },
    langRow: {
        flexDirection: 'row', alignItems: 'center',
        backgroundColor: tokens_1.color.paperRaised, borderWidth: 1, borderColor: tokens_1.color.haze,
        borderRadius: tokens_1.radius.md, paddingHorizontal: tokens_1.space.lg, paddingVertical: tokens_1.space.md,
    },
    langRowLabel: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, fontSize: 14 }),
    langRowValue: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 12, marginTop: 2 }),
    langChevron: { fontSize: 22, color: tokens_1.color.mute, lineHeight: 26 },
});
