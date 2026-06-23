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
exports.PassportSettingsSheet = PassportSettingsSheet;
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var ImagePicker = require("expo-image-picker");
var expo_router_1 = require("expo-router");
var profile_1 = require("../services/profile");
var tokens_1 = require("../theme/tokens");
var ALL_INTERESTS = [
    { key: 'nightlife', label: 'Nightlife' }, { key: 'food', label: 'Food' },
    { key: 'beach', label: 'Beach' }, { key: 'luxury', label: 'Luxury' },
    { key: 'culture', label: 'Culture' }, { key: 'adventure', label: 'Adventure' },
    { key: 'wellness', label: 'Wellness' }, { key: 'photography', label: 'Photography' },
    { key: 'backpacking', label: 'Backpacking' }, { key: 'shopping', label: 'Shopping' },
    { key: 'business', label: 'Business' }, { key: 'events', label: 'Events' },
];
var ALL_LANGUAGES = [
    { key: 'English', label: 'English' }, { key: 'Spanish', label: 'Spanish' },
    { key: 'French', label: 'French' }, { key: 'Mandarin', label: 'Mandarin' },
    { key: 'Arabic', label: 'Arabic' }, { key: 'Portuguese', label: 'Portuguese' },
    { key: 'German', label: 'German' }, { key: 'Italian', label: 'Italian' },
    { key: 'Japanese', label: 'Japanese' }, { key: 'Korean', label: 'Korean' },
    { key: 'Hindi', label: 'Hindi' }, { key: 'Russian', label: 'Russian' },
    { key: 'Turkish', label: 'Turkish' }, { key: 'Dutch', label: 'Dutch' },
    { key: 'Thai', label: 'Thai' }, { key: 'Vietnamese', label: 'Vietnamese' },
    { key: 'Indonesian', label: 'Indonesian' }, { key: 'Polish', label: 'Polish' },
    { key: 'Swedish', label: 'Swedish' }, { key: 'Greek', label: 'Greek' },
];
var ALL_TRAVEL_STYLES = [
    { key: 'Luxury', label: 'Luxury' }, { key: 'Budget', label: 'Budget' },
    { key: 'Adventure', label: 'Adventure' }, { key: 'Relaxed', label: 'Relaxed' },
    { key: 'Nightlife', label: 'Nightlife' }, { key: 'Foodie', label: 'Foodie' },
    { key: 'Culture', label: 'Culture' }, { key: 'Shopping', label: 'Shopping' },
    { key: 'Beach', label: 'Beach' }, { key: 'Business', label: 'Business' },
];
var TRAVEL_PACE_OPTIONS = [
    { key: 'slow', label: 'Slow & steady' },
    { key: 'balanced', label: 'Balanced' },
    { key: 'packed', label: 'Packed schedule' },
];
var BUDGET_OPTIONS = [
    { key: 'budget', label: 'Budget' },
    { key: 'mid-range', label: 'Mid-range' },
    { key: 'luxury', label: 'Luxury' },
    { key: 'flexible', label: 'Flexible' },
];
var GROUP_STYLE_OPTIONS = [
    { key: 'Solo', label: 'Solo' },
    { key: 'With friends', label: 'With friends' },
    { key: 'With partner', label: 'With partner' },
    { key: 'With family', label: 'With family' },
    { key: 'Open to groups', label: 'Open to groups' },
];
var LOOKING_FOR_OPTIONS = [
    { key: 'Travel buddies', label: 'Travel buddies' },
    { key: 'Local recs', label: 'Local recs' },
    { key: 'Events', label: 'Events' },
    { key: 'Group plans', label: 'Group plans' },
    { key: 'Language exchange', label: 'Language exchange' },
    { key: 'Business networking', label: 'Business networking' },
];
var COMFORT_OPTIONS = [
    { key: 'public', label: 'Public meetups' },
    { key: 'small_groups', label: 'Small groups' },
    { key: 'one_on_one', label: 'Open to 1-on-1' },
    { key: 'verified_only', label: 'Verified only' },
];
var AVAILABILITY_OPTIONS = [
    { key: 'Morning', label: 'Morning' },
    { key: 'Afternoon', label: 'Afternoon' },
    { key: 'Evening', label: 'Evening' },
    { key: 'Late night', label: 'Late night' },
];
var PLANNING_STYLE_OPTIONS = [
    { key: 'plan_ahead', label: 'Plan ahead' },
    { key: 'last_minute', label: 'Last minute' },
    { key: 'flexible', label: 'Flexible' },
    { key: 'spontaneous', label: 'Spontaneous' },
];
function PassportSettingsSheet(_a) {
    var _this = this;
    var _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t;
    var visible = _a.visible, profile = _a.profile, onClose = _a.onClose, onSaved = _a.onSaved;
    var _u = (0, react_1.useState)('profile'), section = _u[0], setSection = _u[1];
    // Core profile state
    var _v = (0, react_1.useState)((_b = profile.displayName) !== null && _b !== void 0 ? _b : ''), displayName = _v[0], setDisplayName = _v[1];
    var _w = (0, react_1.useState)((_c = profile.username) !== null && _c !== void 0 ? _c : ''), username = _w[0], setUsername = _w[1];
    var _x = (0, react_1.useState)((_d = profile.bio) !== null && _d !== void 0 ? _d : ''), bio = _x[0], setBio = _x[1];
    var _y = (0, react_1.useState)((_e = profile.homeCity) !== null && _e !== void 0 ? _e : ''), homeCity = _y[0], setHomeCity = _y[1];
    var _z = (0, react_1.useState)((_f = profile.homeCountry) !== null && _f !== void 0 ? _f : ''), homeCountry = _z[0], setHomeCountry = _z[1];
    var _0 = (0, react_1.useState)(profile.passportVisibility !== 'private'), passportPublic = _0[0], setPassportPublic = _0[1];
    var _1 = (0, react_1.useState)(null), avatarUri = _1[0], setAvatarUri = _1[1];
    // Preferences state
    var _2 = (0, react_1.useState)((_g = profile.interests) !== null && _g !== void 0 ? _g : []), interests = _2[0], setInterests = _2[1];
    var _3 = (0, react_1.useState)((_h = profile.spokenLanguages) !== null && _h !== void 0 ? _h : []), spokenLanguages = _3[0], setSpokenLanguages = _3[1];
    var _4 = (0, react_1.useState)((_j = profile.defaultLanguage) !== null && _j !== void 0 ? _j : ''), defaultLanguage = _4[0], setDefaultLanguage = _4[1];
    var _5 = (0, react_1.useState)((_k = profile.travelStyles) !== null && _k !== void 0 ? _k : []), travelStyles = _5[0], setTravelStyles = _5[1];
    var _6 = (0, react_1.useState)((_l = profile.travelPace) !== null && _l !== void 0 ? _l : null), travelPace = _6[0], setTravelPace = _6[1];
    var _7 = (0, react_1.useState)((_m = profile.budgetStyle) !== null && _m !== void 0 ? _m : null), budgetStyle = _7[0], setBudgetStyle = _7[1];
    var _8 = (0, react_1.useState)((_o = profile.travelGroupStyle) !== null && _o !== void 0 ? _o : []), travelGroupStyle = _8[0], setTravelGroupStyle = _8[1];
    var _9 = (0, react_1.useState)((_p = profile.lookingFor) !== null && _p !== void 0 ? _p : []), lookingFor = _9[0], setLookingFor = _9[1];
    var _10 = (0, react_1.useState)((_q = profile.comfortLevel) !== null && _q !== void 0 ? _q : null), comfortLevel = _10[0], setComfortLevel = _10[1];
    var _11 = (0, react_1.useState)((_r = profile.availabilityTags) !== null && _r !== void 0 ? _r : []), availabilityTags = _11[0], setAvailabilityTags = _11[1];
    var _12 = (0, react_1.useState)((_s = profile.planningStyle) !== null && _s !== void 0 ? _s : null), planningStyle = _12[0], setPlanningStyle = _12[1];
    // Collapsible preference sections (all open by default)
    var _13 = (0, react_1.useState)(new Set(['interests', 'languages', 'travelStyle', 'tripPrefs', 'availability'])), openSections = _13[0], setOpenSections = _13[1];
    var togglePrefSection = function (key) {
        setOpenSections(function (prev) {
            var next = new Set(prev);
            if (next.has(key))
                next.delete(key);
            else
                next.add(key);
            return next;
        });
    };
    // Username check
    var _14 = (0, react_1.useState)('idle'), usernameStatus = _14[0], setUsernameStatus = _14[1];
    var _15 = (0, react_1.useState)(''), usernameReason = _15[0], setUsernameReason = _15[1];
    var debounceRef = (0, react_1.useRef)(null);
    // Save state
    var _16 = (0, react_1.useState)(false), saving = _16[0], setSaving = _16[1];
    var _17 = (0, react_1.useState)(''), saveError = _17[0], setSaveError = _17[1];
    var _18 = (0, react_1.useState)(false), saved = _18[0], setSaved = _18[1];
    // Avatar upload
    var _19 = (0, react_1.useState)(false), uploadingAvatar = _19[0], setUploadingAvatar = _19[1];
    // Reset on open
    (0, react_1.useEffect)(function () {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s;
        if (visible) {
            setDisplayName((_b = (_a = profile.displayName) !== null && _a !== void 0 ? _a : profile.name) !== null && _b !== void 0 ? _b : '');
            setUsername((_c = profile.username) !== null && _c !== void 0 ? _c : '');
            setBio((_d = profile.bio) !== null && _d !== void 0 ? _d : '');
            setHomeCity((_e = profile.homeCity) !== null && _e !== void 0 ? _e : '');
            setHomeCountry((_f = profile.homeCountry) !== null && _f !== void 0 ? _f : '');
            setPassportPublic(profile.passportVisibility !== 'private');
            setAvatarUri(null);
            setSaveError('');
            setSaved(false);
            setUsernameStatus('idle');
            setInterests((_g = profile.interests) !== null && _g !== void 0 ? _g : []);
            setSpokenLanguages((_h = profile.spokenLanguages) !== null && _h !== void 0 ? _h : []);
            setDefaultLanguage((_j = profile.defaultLanguage) !== null && _j !== void 0 ? _j : '');
            setTravelStyles((_k = profile.travelStyles) !== null && _k !== void 0 ? _k : []);
            setTravelPace((_l = profile.travelPace) !== null && _l !== void 0 ? _l : null);
            setBudgetStyle((_m = profile.budgetStyle) !== null && _m !== void 0 ? _m : null);
            setTravelGroupStyle((_o = profile.travelGroupStyle) !== null && _o !== void 0 ? _o : []);
            setLookingFor((_p = profile.lookingFor) !== null && _p !== void 0 ? _p : []);
            setComfortLevel((_q = profile.comfortLevel) !== null && _q !== void 0 ? _q : null);
            setAvailabilityTags((_r = profile.availabilityTags) !== null && _r !== void 0 ? _r : []);
            setPlanningStyle((_s = profile.planningStyle) !== null && _s !== void 0 ? _s : null);
        }
    }, [visible, profile]);
    // Debounced username check
    var onUsernameChange = (0, react_1.useCallback)(function (val) {
        var v = val.toLowerCase().replace(/[^a-z0-9_.]/g, '');
        setUsername(v);
        setUsernameStatus('idle');
        setUsernameReason('');
        if (debounceRef.current)
            clearTimeout(debounceRef.current);
        if (!v || v === profile.username)
            return;
        if (v.length < 3) {
            setUsernameStatus('unavailable');
            setUsernameReason('Too short (min 3)');
            return;
        }
        setUsernameStatus('checking');
        debounceRef.current = setTimeout(function () { return __awaiter(_this, void 0, void 0, function () {
            var result;
            var _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0: return [4 /*yield*/, (0, profile_1.checkUsername)(v)];
                    case 1:
                        result = _b.sent();
                        setUsernameStatus(result.available ? 'available' : 'unavailable');
                        setUsernameReason((_a = result.reason) !== null && _a !== void 0 ? _a : '');
                        return [2 /*return*/];
                }
            });
        }); }, 600);
    }, [profile.username]);
    var toggleMulti = function (setter) { return function (key) {
        setter(function (prev) { return prev.includes(key) ? prev.filter(function (i) { return i !== key; }) : __spreadArray(__spreadArray([], prev, true), [key], false); });
    }; };
    var toggleSingle = function (setter, current) { return function (key) {
        setter(current === key ? null : key);
    }; };
    var pickAvatar = function () { return __awaiter(_this, void 0, void 0, function () {
        var perm, result;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, ImagePicker.requestMediaLibraryPermissionsAsync()];
                case 1:
                    perm = _a.sent();
                    if (!perm.granted) {
                        react_native_1.Alert.alert('Permission required', 'Allow photo library access to change your avatar.');
                        return [2 /*return*/];
                    }
                    return [4 /*yield*/, ImagePicker.launchImageLibraryAsync({
                            mediaTypes: ImagePicker.MediaTypeOptions.Images,
                            allowsEditing: true,
                            aspect: [1, 1],
                            quality: 0.85,
                        })];
                case 2:
                    result = _a.sent();
                    if (!result.canceled && result.assets[0]) {
                        setAvatarUri(result.assets[0].uri);
                    }
                    return [2 /*return*/];
            }
        });
    }); };
    var handleSave = function () { return __awaiter(_this, void 0, void 0, function () {
        var finalAvatarUrl, mime, uploadRes, patch, res;
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    setSaving(true);
                    setSaveError('');
                    finalAvatarUrl = profile.avatarUrl;
                    if (!avatarUri) return [3 /*break*/, 2];
                    setUploadingAvatar(true);
                    mime = avatarUri.endsWith('.png') ? 'image/png' : avatarUri.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
                    return [4 /*yield*/, (0, profile_1.uploadAvatar)(avatarUri, mime)];
                case 1:
                    uploadRes = _c.sent();
                    setUploadingAvatar(false);
                    if (!uploadRes.ok || !uploadRes.data) {
                        setSaveError((_a = uploadRes.message) !== null && _a !== void 0 ? _a : 'Avatar upload failed');
                        setSaving(false);
                        return [2 /*return*/];
                    }
                    finalAvatarUrl = uploadRes.data.url;
                    _c.label = 2;
                case 2:
                    patch = {
                        displayName: displayName.trim() || undefined,
                        bio: bio.trim() || undefined,
                        homeCity: homeCity.trim() || undefined,
                        homeCountry: homeCountry.trim() || undefined,
                        interests: interests,
                        passportVisibility: passportPublic ? 'public' : 'private',
                        spokenLanguages: spokenLanguages,
                        defaultLanguage: defaultLanguage.trim() || null,
                        travelStyles: travelStyles,
                        travelPace: travelPace !== null && travelPace !== void 0 ? travelPace : null,
                        budgetStyle: budgetStyle !== null && budgetStyle !== void 0 ? budgetStyle : null,
                        travelGroupStyle: travelGroupStyle,
                        lookingFor: lookingFor,
                        comfortLevel: comfortLevel !== null && comfortLevel !== void 0 ? comfortLevel : null,
                        availabilityTags: availabilityTags,
                        planningStyle: planningStyle !== null && planningStyle !== void 0 ? planningStyle : null,
                    };
                    if (finalAvatarUrl !== profile.avatarUrl)
                        patch.avatarUrl = finalAvatarUrl;
                    if (username && username !== profile.username && usernameStatus !== 'unavailable') {
                        patch.username = username;
                    }
                    return [4 /*yield*/, (0, profile_1.updateMyProfile)(patch)];
                case 3:
                    res = _c.sent();
                    setSaving(false);
                    if (!res.ok || !res.data) {
                        setSaveError((_b = res.message) !== null && _b !== void 0 ? _b : 'Save failed');
                        return [2 /*return*/];
                    }
                    setSaved(true);
                    onSaved(res.data);
                    setTimeout(function () { setSaved(false); onClose(); }, 1200);
                    return [2 /*return*/];
            }
        });
    }); };
    var SECTIONS = [
        { key: 'profile', label: 'Profile' },
        { key: 'passport', label: 'Passport' },
        { key: 'preferences', label: 'About Me' },
        { key: 'safety', label: 'Safety & Privacy' },
    ];
    var avatarDisplay = (_t = avatarUri !== null && avatarUri !== void 0 ? avatarUri : profile.avatarUrl) !== null && _t !== void 0 ? _t : undefined;
    return (<react_native_1.Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <react_native_1.KeyboardAvoidingView style={{ flex: 1 }} behavior={react_native_1.Platform.OS === 'ios' ? 'padding' : undefined}>
        <react_native_1.View style={sh.header}>
          <react_native_1.Text style={sh.title}>Passport Settings</react_native_1.Text>
          <react_native_1.Pressable onPress={onClose} hitSlop={8}><lucide_react_native_1.X size={22} color={tokens_1.color.ink}/></react_native_1.Pressable>
        </react_native_1.View>

        <react_native_1.ScrollView horizontal showsHorizontalScrollIndicator={false} style={sh.tabs} contentContainerStyle={sh.tabsContent}>
          {SECTIONS.map(function (s) { return (<react_native_1.Pressable key={s.key} style={[sh.tab, section === s.key && sh.tabActive]} onPress={function () { return setSection(s.key); }}>
              <react_native_1.Text style={[sh.tabText, section === s.key && sh.tabTextActive]}>{s.label}</react_native_1.Text>
            </react_native_1.Pressable>); })}
        </react_native_1.ScrollView>

        <react_native_1.ScrollView style={sh.body} contentContainerStyle={sh.bodyContent} keyboardShouldPersistTaps="handled">

          {section === 'profile' && (<react_native_1.View style={sh.sectionBody}>
              <react_native_1.Pressable style={sh.avatarWrap} onPress={pickAvatar}>
                {avatarDisplay ? (<react_native_1.Image source={{ uri: avatarDisplay }} style={sh.avatar}/>) : (<react_native_1.View style={[sh.avatar, sh.avatarEmpty]}>
                    <react_native_1.Text style={sh.avatarEmptyText}>👤</react_native_1.Text>
                  </react_native_1.View>)}
                <react_native_1.View style={sh.avatarOverlay}>
                  {uploadingAvatar
                ? <react_native_1.ActivityIndicator color={tokens_1.color.onInk} size="small"/>
                : <lucide_react_native_1.Camera size={18} color={tokens_1.color.onInk}/>}
                </react_native_1.View>
                {avatarUri && <react_native_1.Text style={sh.avatarHint}>New photo selected — will upload on save</react_native_1.Text>}
              </react_native_1.Pressable>

              <Field label="Display name">
                <react_native_1.TextInput style={sh.input} value={displayName} onChangeText={setDisplayName} placeholder="Your name" placeholderTextColor={tokens_1.color.faint} maxLength={60}/>
              </Field>

              <Field label="Username">
                <react_native_1.View style={sh.usernameRow}>
                  <react_native_1.Text style={sh.atSign}>@</react_native_1.Text>
                  <react_native_1.TextInput style={[sh.input, sh.usernameInput]} value={username} onChangeText={onUsernameChange} placeholder="username" placeholderTextColor={tokens_1.color.faint} autoCapitalize="none" autoCorrect={false} maxLength={24}/>
                  {usernameStatus === 'checking' && <react_native_1.ActivityIndicator size="small" color={tokens_1.color.mute}/>}
                  {usernameStatus === 'available' && <lucide_react_native_1.Check size={16} color={tokens_1.color.success}/>}
                  {usernameStatus === 'unavailable' && <lucide_react_native_1.AlertCircle size={16} color={tokens_1.color.signal}/>}
                </react_native_1.View>
                {usernameReason ? (<react_native_1.Text style={[sh.fieldHint, usernameStatus === 'available' ? sh.hintGood : sh.hintBad]}>
                    {usernameReason}
                  </react_native_1.Text>) : (<react_native_1.Text style={sh.fieldHint}>3–24 chars, lowercase letters/numbers/underscores/periods</react_native_1.Text>)}
              </Field>

              <Field label="Bio">
                <react_native_1.TextInput style={[sh.input, sh.multiline]} value={bio} onChangeText={setBio} placeholder="Tell travelers about yourself…" placeholderTextColor={tokens_1.color.faint} multiline maxLength={300} textAlignVertical="top"/>
                <react_native_1.Text style={sh.charCount}>{bio.length}/300</react_native_1.Text>
              </Field>

              <Field label="Home city">
                <react_native_1.TextInput style={sh.input} value={homeCity} onChangeText={setHomeCity} placeholder="City" placeholderTextColor={tokens_1.color.faint} maxLength={100}/>
              </Field>

              <Field label="Home country">
                <react_native_1.TextInput style={sh.input} value={homeCountry} onChangeText={setHomeCountry} placeholder="Country" placeholderTextColor={tokens_1.color.faint} maxLength={100}/>
              </Field>
            </react_native_1.View>)}

          {section === 'passport' && (<react_native_1.View style={sh.sectionBody}>
              <react_native_1.View style={sh.switchRow}>
                <react_native_1.View style={{ flex: 1 }}>
                  <react_native_1.Text style={sh.switchLabel}>Public Passport</react_native_1.Text>
                  <react_native_1.Text style={sh.switchSub}>Anyone with your profile link can view your Passport</react_native_1.Text>
                </react_native_1.View>
                <react_native_1.Switch value={passportPublic} onValueChange={setPassportPublic} trackColor={{ true: tokens_1.color.signal, false: tokens_1.color.haze }} thumbColor={tokens_1.color.paper}/>
              </react_native_1.View>
              {!passportPublic && (<react_native_1.View style={sh.infoBox}>
                  <react_native_1.Text style={sh.infoText}>🔒 Your Passport is private. Only you can see it.</react_native_1.Text>
                </react_native_1.View>)}
            </react_native_1.View>)}

          {section === 'preferences' && (<react_native_1.View style={sh.sectionBody}>

              <PrefSection title="Interests" subtitle="What you're into — shown on your Passport." open={openSections.has('interests')} onToggle={function () { return togglePrefSection('interests'); }}>
                <ChipGrid options={ALL_INTERESTS} selected={interests} onToggle={toggleMulti(setInterests)}/>
              </PrefSection>

              <PrefSection title="Languages" subtitle="Languages you speak — helps with local connections." open={openSections.has('languages')} onToggle={function () { return togglePrefSection('languages'); }}>
                <ChipGrid options={ALL_LANGUAGES} selected={spokenLanguages} onToggle={toggleMulti(setSpokenLanguages)}/>
                <react_native_1.View style={{ marginTop: tokens_1.space.sm }}>
                  <react_native_1.Text style={sh.subLabel}>Native / default language</react_native_1.Text>
                  <react_native_1.TextInput style={sh.input} value={defaultLanguage} onChangeText={setDefaultLanguage} placeholder="e.g. English" placeholderTextColor={tokens_1.color.faint} maxLength={50}/>
                </react_native_1.View>
              </PrefSection>

              <PrefSection title="Travel Style" subtitle="How you like to travel." open={openSections.has('travelStyle')} onToggle={function () { return togglePrefSection('travelStyle'); }}>
                <react_native_1.Text style={sh.subLabel}>Travel vibes (pick all that apply)</react_native_1.Text>
                <ChipGrid options={ALL_TRAVEL_STYLES} selected={travelStyles} onToggle={toggleMulti(setTravelStyles)}/>
                <react_native_1.Text style={[sh.subLabel, { marginTop: tokens_1.space.sm }]}>Travel pace</react_native_1.Text>
                <ChipGrid options={TRAVEL_PACE_OPTIONS} selected={travelPace ? [travelPace] : []} onToggle={toggleSingle(setTravelPace, travelPace)}/>
                <react_native_1.Text style={[sh.subLabel, { marginTop: tokens_1.space.sm }]}>Budget style</react_native_1.Text>
                <ChipGrid options={BUDGET_OPTIONS} selected={budgetStyle ? [budgetStyle] : []} onToggle={toggleSingle(setBudgetStyle, budgetStyle)}/>
              </PrefSection>

              <PrefSection title="Trip Preferences" subtitle="Who you travel with and what you're looking for." open={openSections.has('tripPrefs')} onToggle={function () { return togglePrefSection('tripPrefs'); }}>
                <react_native_1.Text style={sh.subLabel}>Usually travel</react_native_1.Text>
                <ChipGrid options={GROUP_STYLE_OPTIONS} selected={travelGroupStyle} onToggle={toggleMulti(setTravelGroupStyle)}/>
                <react_native_1.Text style={[sh.subLabel, { marginTop: tokens_1.space.sm }]}>Looking for</react_native_1.Text>
                <ChipGrid options={LOOKING_FOR_OPTIONS} selected={lookingFor} onToggle={toggleMulti(setLookingFor)}/>
                <react_native_1.Text style={[sh.subLabel, { marginTop: tokens_1.space.sm }]}>Comfort level with meetups</react_native_1.Text>
                <ChipGrid options={COMFORT_OPTIONS} selected={comfortLevel ? [comfortLevel] : []} onToggle={toggleSingle(setComfortLevel, comfortLevel)}/>
              </PrefSection>

              <PrefSection title="Availability" subtitle="When you're typically free and how you plan." open={openSections.has('availability')} onToggle={function () { return togglePrefSection('availability'); }}>
                <react_native_1.Text style={sh.subLabel}>Usually available</react_native_1.Text>
                <ChipGrid options={AVAILABILITY_OPTIONS} selected={availabilityTags} onToggle={toggleMulti(setAvailabilityTags)}/>
                <react_native_1.Text style={[sh.subLabel, { marginTop: tokens_1.space.sm }]}>Planning style</react_native_1.Text>
                <ChipGrid options={PLANNING_STYLE_OPTIONS} selected={planningStyle ? [planningStyle] : []} onToggle={toggleSingle(setPlanningStyle, planningStyle)}/>
              </PrefSection>

            </react_native_1.View>)}

          {section === 'safety' && (<react_native_1.View style={sh.sectionBody}>
              <react_native_1.View style={sh.infoBox}>
                <react_native_1.Text style={sh.infoLabel}>📍 Location Privacy</react_native_1.Text>
                <react_native_1.Text style={sh.infoText}>Your exact GPS is never stored or shown publicly. Only city-level location appears on your Passport.</react_native_1.Text>
              </react_native_1.View>
              <react_native_1.Pressable style={sh.linkRow} onPress={function () { onClose(); setTimeout(function () { return expo_router_1.router.push('/settings/location'); }, 300); }}>
                <react_native_1.Text style={sh.linkRowLabel}>Location Settings</react_native_1.Text>
                <react_native_1.Text style={sh.linkRowChevron}>›</react_native_1.Text>
              </react_native_1.Pressable>
              <react_native_1.View style={sh.infoBox}>
                <react_native_1.Text style={sh.infoLabel}>🔖 Verified Stamps</react_native_1.Text>
                <react_native_1.Text style={sh.infoText}>GPS-verified posts earn stamps when your current location matches the tagged place (within ~1 mile). Manual tags do not earn stamps.</react_native_1.Text>
              </react_native_1.View>
            </react_native_1.View>)}

        </react_native_1.ScrollView>

        <react_native_1.View style={sh.saveBar}>
          {saveError ? <react_native_1.Text style={sh.saveError}>{saveError}</react_native_1.Text> : null}
          <react_native_1.Pressable style={[sh.saveBtn, saving && sh.saveBtnBusy, saved && sh.saveBtnDone]} onPress={handleSave} disabled={saving || saved}>
            {saving ? (<react_native_1.ActivityIndicator color={tokens_1.color.onInk} size="small"/>) : saved ? (<><lucide_react_native_1.Check size={16} color={tokens_1.color.onInk}/><react_native_1.Text style={sh.saveBtnText}>Saved!</react_native_1.Text></>) : (<react_native_1.Text style={sh.saveBtnText}>Save changes</react_native_1.Text>)}
          </react_native_1.Pressable>
        </react_native_1.View>
      </react_native_1.KeyboardAvoidingView>
    </react_native_1.Modal>);
}
function Field(_a) {
    var label = _a.label, children = _a.children;
    return (<react_native_1.View style={sh.field}>
      <react_native_1.Text style={sh.fieldLabel}>{label}</react_native_1.Text>
      {children}
    </react_native_1.View>);
}
function PrefSection(_a) {
    var title = _a.title, subtitle = _a.subtitle, open = _a.open, onToggle = _a.onToggle, children = _a.children;
    return (<react_native_1.View style={sh.prefSection}>
      <react_native_1.Pressable style={sh.prefSectionHeader} onPress={onToggle}>
        <react_native_1.View style={{ flex: 1 }}>
          <react_native_1.Text style={sh.prefSectionTitle}>{title}</react_native_1.Text>
          {!open && <react_native_1.Text style={sh.prefSectionSub} numberOfLines={1}>{subtitle}</react_native_1.Text>}
        </react_native_1.View>
        {open ? <lucide_react_native_1.ChevronUp size={18} color={tokens_1.color.mute}/> : <lucide_react_native_1.ChevronDown size={18} color={tokens_1.color.mute}/>}
      </react_native_1.Pressable>
      {open && (<react_native_1.View style={sh.prefSectionBody}>
          <react_native_1.Text style={sh.prefSectionSub}>{subtitle}</react_native_1.Text>
          {children}
        </react_native_1.View>)}
    </react_native_1.View>);
}
function ChipGrid(_a) {
    var options = _a.options, selected = _a.selected, onToggle = _a.onToggle;
    return (<react_native_1.View style={sh.chipGrid}>
      {options.map(function (_a) {
            var key = _a.key, label = _a.label;
            var on = selected.includes(key);
            return (<react_native_1.Pressable key={key} style={[sh.chip, on && sh.chipOn]} onPress={function () { return onToggle(key); }}>
            <react_native_1.Text style={[sh.chipText, on && sh.chipTextOn]}>{label}</react_native_1.Text>
          </react_native_1.Pressable>);
        })}
    </react_native_1.View>);
}
var sh = react_native_1.StyleSheet.create({
    header: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        paddingHorizontal: tokens_1.space.lg, paddingTop: tokens_1.space.lg, paddingBottom: tokens_1.space.md,
        borderBottomWidth: 1, borderBottomColor: tokens_1.color.haze,
    },
    title: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink }),
    tabs: { maxHeight: 48, borderBottomWidth: 1, borderBottomColor: tokens_1.color.haze },
    tabsContent: { paddingHorizontal: tokens_1.space.lg, gap: tokens_1.space.sm, alignItems: 'center' },
    tab: { paddingHorizontal: tokens_1.space.md, paddingVertical: 10, borderRadius: tokens_1.radius.pill },
    tabActive: { backgroundColor: tokens_1.color.ink },
    tabText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontWeight: '600' }),
    tabTextActive: { color: tokens_1.color.onInk },
    body: { flex: 1 },
    bodyContent: { paddingBottom: tokens_1.space.xxxl },
    sectionBody: { padding: tokens_1.space.lg, gap: tokens_1.space.lg },
    avatarWrap: { alignItems: 'center', marginBottom: tokens_1.space.sm },
    avatar: { width: 88, height: 88, borderRadius: 44, backgroundColor: tokens_1.color.haze },
    avatarEmpty: { alignItems: 'center', justifyContent: 'center' },
    avatarEmptyText: { fontSize: 36 },
    avatarOverlay: {
        position: 'absolute', bottom: 0, right: 120,
        backgroundColor: tokens_1.color.ink, borderRadius: 16, padding: 6,
        borderWidth: 2, borderColor: tokens_1.color.paper,
    },
    avatarHint: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, marginTop: 4 }),
    field: { gap: tokens_1.space.xs },
    fieldLabel: { fontFamily: 'Courier', fontSize: 11, fontWeight: '700', color: tokens_1.color.mute, letterSpacing: 1 },
    fieldHint: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, marginTop: 2 }),
    hintGood: { color: tokens_1.color.success },
    hintBad: { color: tokens_1.color.signal },
    charCount: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.faint, textAlign: 'right' }),
    input: __assign(__assign({ borderWidth: 1, borderColor: tokens_1.color.haze, borderRadius: tokens_1.radius.md, paddingHorizontal: tokens_1.space.md, paddingVertical: 10 }, tokens_1.type.body), { color: tokens_1.color.ink, backgroundColor: tokens_1.color.paper }),
    multiline: { minHeight: 88, textAlignVertical: 'top' },
    usernameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    atSign: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.mute, fontSize: 16 }),
    usernameInput: { flex: 1 },
    switchRow: {
        flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.md,
        backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md,
        borderWidth: 1, borderColor: tokens_1.color.haze, padding: tokens_1.space.md,
    },
    switchLabel: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink }),
    switchSub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, marginTop: 2 }),
    linkRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingVertical: tokens_1.space.sm,
        paddingHorizontal: tokens_1.space.md,
        backgroundColor: tokens_1.color.paperRaised,
        borderRadius: tokens_1.radius.md,
        marginBottom: tokens_1.space.xs,
    },
    linkRowLabel: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.signal }),
    linkRowChevron: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.signal, fontSize: 20 }),
    infoBox: {
        backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md,
        borderWidth: 1, borderColor: tokens_1.color.haze, padding: tokens_1.space.md, gap: tokens_1.space.xs,
    },
    infoLabel: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink }),
    infoText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute, lineHeight: 20 }),
    prefSection: {
        borderWidth: 1, borderColor: tokens_1.color.haze, borderRadius: tokens_1.radius.md,
        backgroundColor: tokens_1.color.paperRaised, overflow: 'hidden',
    },
    prefSectionHeader: {
        flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm,
        padding: tokens_1.space.md,
    },
    prefSectionTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink }),
    prefSectionSub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, marginTop: 2 }),
    prefSectionBody: { paddingHorizontal: tokens_1.space.md, paddingBottom: tokens_1.space.md, gap: tokens_1.space.sm },
    subLabel: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: tokens_1.color.mute, letterSpacing: 0.8, marginBottom: 6 },
    chipGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    chip: {
        borderRadius: tokens_1.radius.pill, borderWidth: 1, borderColor: tokens_1.color.haze,
        paddingHorizontal: 12, paddingVertical: 6, backgroundColor: tokens_1.color.paper,
    },
    chipOn: { backgroundColor: tokens_1.color.ink, borderColor: tokens_1.color.ink },
    chipText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontWeight: '600', fontSize: 13 }),
    chipTextOn: { color: tokens_1.color.onInk },
    saveBar: { borderTopWidth: 1, borderTopColor: tokens_1.color.haze, padding: tokens_1.space.lg, gap: tokens_1.space.sm },
    saveBtn: {
        backgroundColor: tokens_1.color.signal, borderRadius: tokens_1.radius.pill,
        paddingVertical: 14, alignItems: 'center', justifyContent: 'center',
        flexDirection: 'row', gap: 8,
    },
    saveBtnBusy: { opacity: 0.7 },
    saveBtnDone: { backgroundColor: tokens_1.color.success },
    saveBtnText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.onInk, fontSize: 16 }),
    saveError: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, textAlign: 'center' }),
});
