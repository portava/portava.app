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
exports.default = EditProfileScreen;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var react_native_safe_area_context_1 = require("react-native-safe-area-context");
var lucide_react_native_1 = require("lucide-react-native");
var ImagePicker = require("expo-image-picker");
var imageRender_1 = require("../../src/lib/imageRender");
var profile_1 = require("../../src/services/profile");
var LanguagePreferenceContext_1 = require("../../src/context/LanguagePreferenceContext");
var tokens_1 = require("../../src/theme/tokens");
var BIO_MAX = 300;
var VISIBILITY_OPTIONS = [
    { key: 'public', label: 'Public', desc: 'Anyone can view your profile' },
    { key: 'followers_only', label: 'Followers only', desc: 'Only people who follow you' },
    { key: 'private', label: 'Private', desc: 'Only you can see your passport' },
];
var LANGUAGE_OPTIONS = [
    { code: 'en', label: 'English' },
    { code: 'es', label: 'Spanish' },
    { code: 'fr', label: 'French' },
    { code: 'de', label: 'German' },
    { code: 'pt', label: 'Portuguese' },
    { code: 'it', label: 'Italian' },
    { code: 'nl', label: 'Dutch' },
    { code: 'sv', label: 'Swedish' },
    { code: 'pl', label: 'Polish' },
    { code: 'ru', label: 'Russian' },
    { code: 'tr', label: 'Turkish' },
    { code: 'ar', label: 'Arabic' },
    { code: 'hi', label: 'Hindi' },
    { code: 'ja', label: 'Japanese' },
    { code: 'ko', label: 'Korean' },
    { code: 'zh', label: 'Chinese (Simplified)' },
    { code: 'th', label: 'Thai' },
    { code: 'vi', label: 'Vietnamese' },
    { code: 'id', label: 'Indonesian' },
    { code: 'tl', label: 'Filipino' },
];
function languageLabel(code) {
    var _a, _b;
    if (!code)
        return 'Same as message settings';
    return (_b = (_a = LANGUAGE_OPTIONS.find(function (l) { return l.code === code; })) === null || _a === void 0 ? void 0 : _a.label) !== null && _b !== void 0 ? _b : code;
}
function EditProfileScreen() {
    var _this = this;
    var _a, _b, _c, _d;
    var navigation = (0, expo_router_1.useNavigation)();
    var insets = (0, react_native_safe_area_context_1.useSafeAreaInsets)();
    var _e = (0, LanguagePreferenceContext_1.useLanguagePreference)(), ctxLanguage = _e.preferredLanguage, updateLanguage = _e.updateLanguage;
    var _f = (0, react_1.useState)(true), loadingProfile = _f[0], setLoadingProfile = _f[1];
    var _g = (0, react_1.useState)(null), profile = _g[0], setProfile = _g[1];
    var _h = (0, react_1.useState)({
        displayName: '',
        username: '',
        bio: '',
        visibility: 'public',
        avatarUri: null,
        coverUri: null,
        avatarUrl: null,
        coverUrl: null,
        preferredLanguage: null,
    }), form = _h[0], setForm = _h[1];
    var _j = (0, react_1.useState)(null), originalForm = _j[0], setOriginalForm = _j[1];
    var _k = (0, react_1.useState)(false), saving = _k[0], setSaving = _k[1];
    var _l = (0, react_1.useState)(null), saveError = _l[0], setSaveError = _l[1];
    var _m = (0, react_1.useState)(false), langPickerVisible = _m[0], setLangPickerVisible = _m[1];
    var _o = (0, react_1.useState)('idle'), usernameStatus = _o[0], setUsernameStatus = _o[1];
    var _p = (0, react_1.useState)(null), usernameMessage = _p[0], setUsernameMessage = _p[1];
    var usernameTimer = (0, react_1.useRef)(null);
    var _q = (0, react_1.useState)('idle'), photoPhase = _q[0], setPhotoPhase = _q[1];
    /** Width (px) of the last cover image picked — used to avoid upscaling in renderCoverImage */
    var coverOriginalWidthRef = (0, react_1.useRef)(1920);
    var isDirty = originalForm !== null && (form.displayName !== originalForm.displayName ||
        form.username !== originalForm.username ||
        form.bio !== originalForm.bio ||
        form.visibility !== originalForm.visibility ||
        form.avatarUri !== originalForm.avatarUri ||
        form.coverUri !== originalForm.coverUri ||
        form.preferredLanguage !== originalForm.preferredLanguage);
    (0, react_1.useEffect)(function () {
        var alive = true;
        (0, profile_1.getMyProfile)().then(function (res) {
            var _a, _b, _c, _d, _e, _f;
            if (!alive)
                return;
            if (res.ok && res.data) {
                var p = res.data;
                setProfile(p);
                // Prefer context value (already reflects any language-settings changes); fall back to profile
                var langFromCtx = ctxLanguage !== undefined ? ctxLanguage : ((_a = p.preferredLanguage) !== null && _a !== void 0 ? _a : null);
                var initial = {
                    displayName: (_c = (_b = p.displayName) !== null && _b !== void 0 ? _b : p.name) !== null && _c !== void 0 ? _c : '',
                    username: (_d = p.username) !== null && _d !== void 0 ? _d : '',
                    bio: (_e = p.bio) !== null && _e !== void 0 ? _e : '',
                    visibility: (_f = p.passportVisibility) !== null && _f !== void 0 ? _f : 'public',
                    avatarUri: null,
                    coverUri: null,
                    avatarUrl: p.avatarUrl,
                    coverUrl: p.coverPhotoUrl,
                    preferredLanguage: langFromCtx,
                };
                setForm(initial);
                setOriginalForm(initial);
            }
            setLoadingProfile(false);
        }).catch(function () {
            if (alive)
                setLoadingProfile(false);
        });
        return function () { alive = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    // Sync preferred language from context whenever the screen gains focus (e.g. after
    // the user changed it in Settings) — but only when the field hasn't been modified locally.
    var originalFormRef = (0, react_1.useRef)(null);
    (0, expo_router_1.useFocusEffect)((0, react_1.useCallback)(function () {
        if (ctxLanguage === undefined || ctxLanguage === null)
            return;
        setForm(function (prev) {
            var _a, _b;
            var isClean = prev.preferredLanguage === ((_b = (_a = originalFormRef.current) === null || _a === void 0 ? void 0 : _a.preferredLanguage) !== null && _b !== void 0 ? _b : null);
            if (isClean && prev.preferredLanguage !== ctxLanguage) {
                return __assign(__assign({}, prev), { preferredLanguage: ctxLanguage });
            }
            return prev;
        });
        setOriginalForm(function (prev) {
            if (!prev)
                return prev;
            originalFormRef.current = __assign(__assign({}, prev), { preferredLanguage: ctxLanguage });
            return originalFormRef.current;
        });
    }, [ctxLanguage]));
    // Keep originalFormRef in sync whenever originalForm changes
    (0, react_1.useEffect)(function () {
        originalFormRef.current = originalForm;
    }, [originalForm]);
    (0, react_1.useEffect)(function () {
        var unsubscribe = navigation.addListener('beforeRemove', function (e) {
            if (!isDirty)
                return;
            e.preventDefault();
            react_native_1.Alert.alert('Discard changes?', 'You have unsaved changes. Are you sure you want to go back?', [
                { text: 'Keep editing', style: 'cancel' },
                { text: 'Discard', style: 'destructive', onPress: function () { return navigation.dispatch(e.data.action); } },
            ]);
        });
        return unsubscribe;
    }, [navigation, isDirty]);
    var handleUsernameChange = (0, react_1.useCallback)(function (text) {
        var _a;
        var cleaned = text.toLowerCase().replace(/[^a-z0-9_.]/g, '');
        setForm(function (f) { return (__assign(__assign({}, f), { username: cleaned })); });
        setUsernameStatus('idle');
        setUsernameMessage(null);
        if (usernameTimer.current)
            clearTimeout(usernameTimer.current);
        if (!cleaned || cleaned === ((_a = profile === null || profile === void 0 ? void 0 : profile.username) !== null && _a !== void 0 ? _a : ''))
            return;
        if (cleaned.length < 3) {
            setUsernameStatus('invalid');
            setUsernameMessage('At least 3 characters required');
            return;
        }
        setUsernameStatus('checking');
        usernameTimer.current = setTimeout(function () { return __awaiter(_this, void 0, void 0, function () {
            var res;
            var _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0: return [4 /*yield*/, (0, profile_1.checkUsername)(cleaned)];
                    case 1:
                        res = _b.sent();
                        if (res.available) {
                            setUsernameStatus('available');
                            setUsernameMessage(null);
                        }
                        else {
                            setUsernameStatus('taken');
                            setUsernameMessage((_a = res.reason) !== null && _a !== void 0 ? _a : 'Username not available');
                        }
                        return [2 /*return*/];
                }
            });
        }); }, 500);
    }, [profile === null || profile === void 0 ? void 0 : profile.username]);
    var pickAvatar = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var status, result, asset_1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, ImagePicker.requestMediaLibraryPermissionsAsync()];
                case 1:
                    status = (_a.sent()).status;
                    if (status !== 'granted') {
                        react_native_1.Alert.alert('Permission needed', 'Allow photo access to update your profile photo.');
                        return [2 /*return*/];
                    }
                    return [4 /*yield*/, ImagePicker.launchImageLibraryAsync({
                            mediaTypes: ImagePicker.MediaTypeOptions.Images,
                            allowsEditing: true,
                            aspect: [1, 1],
                            // No quality cap here — renderAvatarImage handles compression
                        })];
                case 2:
                    result = _a.sent();
                    if (!result.canceled && result.assets[0]) {
                        asset_1 = result.assets[0];
                        if (asset_1.fileSize != null && asset_1.fileSize > imageRender_1.MAX_ORIGINAL_BYTES) {
                            react_native_1.Alert.alert('Image too large', 'This image is very large. Choose a file under 25 MB or use a smaller photo.');
                            return [2 /*return*/];
                        }
                        setForm(function (f) { return (__assign(__assign({}, f), { avatarUri: asset_1.uri })); });
                    }
                    return [2 /*return*/];
            }
        });
    }); }, []);
    var pickCover = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var status, result, asset_2;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, ImagePicker.requestMediaLibraryPermissionsAsync()];
                case 1:
                    status = (_b.sent()).status;
                    if (status !== 'granted') {
                        react_native_1.Alert.alert('Permission needed', 'Allow photo access to update your cover photo.');
                        return [2 /*return*/];
                    }
                    return [4 /*yield*/, ImagePicker.launchImageLibraryAsync({
                            mediaTypes: ImagePicker.MediaTypeOptions.Images,
                            allowsEditing: true,
                            aspect: [16, 9],
                            // No quality cap here — renderCoverImage handles compression
                        })];
                case 2:
                    result = _b.sent();
                    if (!result.canceled && result.assets[0]) {
                        asset_2 = result.assets[0];
                        if (asset_2.fileSize != null && asset_2.fileSize > imageRender_1.MAX_ORIGINAL_BYTES) {
                            react_native_1.Alert.alert('Image too large', 'This image is very large. Choose a file under 25 MB or use a smaller photo.');
                            return [2 /*return*/];
                        }
                        // Store original width so renderCoverImage knows whether to downscale
                        coverOriginalWidthRef.current = (_a = asset_2.width) !== null && _a !== void 0 ? _a : 1920;
                        setForm(function (f) { return (__assign(__assign({}, f), { coverUri: asset_2.uri })); });
                    }
                    return [2 /*return*/];
            }
        });
    }); }, []);
    var canSave = usernameStatus !== 'taken' && usernameStatus !== 'invalid' && usernameStatus !== 'checking';
    var handleSave = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var patch, rendered, upRes, rendered, upRes, langChanged, _a, langRes, profileRes;
        var _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
        return __generator(this, function (_o) {
            switch (_o.label) {
                case 0:
                    if (!canSave)
                        return [2 /*return*/];
                    setSaving(true);
                    setSaveError(null);
                    patch = {};
                    if (form.displayName !== ((_b = originalForm === null || originalForm === void 0 ? void 0 : originalForm.displayName) !== null && _b !== void 0 ? _b : '')) {
                        patch.displayName = form.displayName.trim();
                    }
                    if (form.username !== ((_c = originalForm === null || originalForm === void 0 ? void 0 : originalForm.username) !== null && _c !== void 0 ? _c : '') && form.username) {
                        patch.username = form.username;
                    }
                    if (form.bio !== ((_d = originalForm === null || originalForm === void 0 ? void 0 : originalForm.bio) !== null && _d !== void 0 ? _d : '')) {
                        patch.bio = form.bio;
                    }
                    if (form.visibility !== ((_e = originalForm === null || originalForm === void 0 ? void 0 : originalForm.visibility) !== null && _e !== void 0 ? _e : 'public')) {
                        patch.passportVisibility = form.visibility;
                    }
                    if (!form.avatarUri) return [3 /*break*/, 3];
                    // Step 1 — compress to 512×512 JPEG
                    setPhotoPhase('optimizing');
                    return [4 /*yield*/, (0, imageRender_1.renderAvatarImage)(form.avatarUri)];
                case 1:
                    rendered = _o.sent();
                    // Step 2 — upload compressed variant
                    setPhotoPhase('uploading');
                    return [4 /*yield*/, (0, profile_1.uploadAvatar)(rendered.uri, rendered.mimeType)];
                case 2:
                    upRes = _o.sent();
                    setPhotoPhase('idle');
                    if (!upRes.ok) {
                        setSaveError((_f = upRes.message) !== null && _f !== void 0 ? _f : 'Photo upload failed. Try again.');
                        setSaving(false);
                        return [2 /*return*/];
                    }
                    patch.avatarUrl = upRes.data.url;
                    _o.label = 3;
                case 3:
                    if (!form.coverUri) return [3 /*break*/, 6];
                    // Step 1 — compress to max 1200px JPEG
                    setPhotoPhase('optimizing');
                    return [4 /*yield*/, (0, imageRender_1.renderCoverImage)(form.coverUri, coverOriginalWidthRef.current)];
                case 4:
                    rendered = _o.sent();
                    // Step 2 — upload compressed variant
                    setPhotoPhase('uploading');
                    return [4 /*yield*/, (0, profile_1.uploadCover)(rendered.uri, rendered.mimeType)];
                case 5:
                    upRes = _o.sent();
                    setPhotoPhase('idle');
                    if (!upRes.ok) {
                        setSaveError((_g = upRes.message) !== null && _g !== void 0 ? _g : 'Photo upload failed. Try again.');
                        setSaving(false);
                        return [2 /*return*/];
                    }
                    patch.coverUrl = upRes.data.url;
                    _o.label = 6;
                case 6:
                    langChanged = form.preferredLanguage !== ((_h = originalForm === null || originalForm === void 0 ? void 0 : originalForm.preferredLanguage) !== null && _h !== void 0 ? _h : null);
                    if (Object.keys(patch).length === 0 && !langChanged) {
                        setSaving(false);
                        expo_router_1.router.back();
                        return [2 /*return*/];
                    }
                    return [4 /*yield*/, Promise.all([
                            langChanged ? updateLanguage(form.preferredLanguage) : Promise.resolve({ ok: true }),
                            Object.keys(patch).length > 0 ? (0, profile_1.updateMyProfile)(patch) : Promise.resolve({ ok: true }),
                        ])];
                case 7:
                    _a = _o.sent(), langRes = _a[0], profileRes = _a[1];
                    setSaving(false);
                    if (!langRes.ok) {
                        setSaveError((_j = langRes.message) !== null && _j !== void 0 ? _j : 'Failed to save language preference');
                        return [2 /*return*/];
                    }
                    if (!profileRes.ok) {
                        if (profileRes.errorKind === 'invalid_payload' && ((_k = profileRes.message) === null || _k === void 0 ? void 0 : _k.toLowerCase().includes('username'))) {
                            setUsernameStatus('taken');
                            setUsernameMessage((_l = profileRes.message) !== null && _l !== void 0 ? _l : 'Username not available');
                        }
                        else {
                            setSaveError((_m = profileRes.message) !== null && _m !== void 0 ? _m : 'Failed to save profile');
                        }
                        return [2 /*return*/];
                    }
                    setOriginalForm(form);
                    expo_router_1.router.back();
                    return [2 /*return*/];
            }
        });
    }); }, [form, originalForm, canSave, updateLanguage]);
    if (loadingProfile) {
        return (<react_native_1.SafeAreaView style={styles.loadingWrap}>
        <react_native_1.ActivityIndicator color={tokens_1.color.signal} size="large"/>
      </react_native_1.SafeAreaView>);
    }
    var avatarSource = (_b = (_a = form.avatarUri) !== null && _a !== void 0 ? _a : form.avatarUrl) !== null && _b !== void 0 ? _b : null;
    var coverSource = (_d = (_c = form.coverUri) !== null && _c !== void 0 ? _c : form.coverUrl) !== null && _d !== void 0 ? _d : null;
    return (<react_native_1.View style={{ flex: 1, backgroundColor: tokens_1.color.paper }}>
      <react_native_1.KeyboardAvoidingView style={{ flex: 1 }} behavior={react_native_1.Platform.OS === 'ios' ? 'padding' : 'height'}>
        <react_native_1.View style={{ flex: 1 }}>
          {/* Header */}
          <react_native_1.View style={[styles.header, { paddingTop: insets.top + tokens_1.space.sm }]}>
            <react_native_1.Pressable style={styles.headerBtn} onPress={function () { return expo_router_1.router.back(); }} hitSlop={8}>
              <lucide_react_native_1.ArrowLeft size={22} color={tokens_1.color.ink}/>
            </react_native_1.Pressable>
            <react_native_1.Text style={styles.headerTitle}>Edit Profile</react_native_1.Text>
            <react_native_1.Pressable style={[styles.saveBtn, (!canSave || saving) && styles.saveBtnDisabled]} onPress={handleSave} disabled={!canSave || saving}>
              {saving && photoPhase === 'idle' ? (<react_native_1.ActivityIndicator size="small" color={tokens_1.color.onInk}/>) : photoPhase === 'optimizing' ? (<react_native_1.Text style={styles.saveBtnText}>Optimizing…</react_native_1.Text>) : photoPhase === 'uploading' ? (<react_native_1.Text style={styles.saveBtnText}>Uploading…</react_native_1.Text>) : (<react_native_1.Text style={styles.saveBtnText}>Save</react_native_1.Text>)}
            </react_native_1.Pressable>
          </react_native_1.View>

          <react_native_1.ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: insets.bottom + tokens_1.space.xxxl }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            {/* Cover photo */}
            <react_native_1.Pressable style={styles.coverWrap} onPress={pickCover}>
              {coverSource ? (<react_native_1.Image source={{ uri: coverSource }} style={styles.coverImage}/>) : (<react_native_1.View style={styles.coverPlaceholder}>
                  <lucide_react_native_1.ImagePlus size={28} color={tokens_1.color.faint}/>
                  <react_native_1.Text style={styles.coverPlaceholderText}>Add cover photo</react_native_1.Text>
                </react_native_1.View>)}
              <react_native_1.View style={styles.coverEditBadge}>
                <lucide_react_native_1.Camera size={16} color={tokens_1.color.onInk}/>
              </react_native_1.View>
            </react_native_1.Pressable>

            {/* Avatar */}
            <react_native_1.View style={styles.avatarRow}>
              <react_native_1.Pressable style={styles.avatarWrap} onPress={pickAvatar}>
                {avatarSource ? (<react_native_1.Image source={{ uri: avatarSource }} style={styles.avatar}/>) : (<react_native_1.View style={styles.avatarEmpty}>
                    <react_native_1.Text style={{ fontSize: 32 }}>👤</react_native_1.Text>
                  </react_native_1.View>)}
                <react_native_1.View style={styles.avatarEditBadge}>
                  <lucide_react_native_1.Camera size={14} color={tokens_1.color.onInk}/>
                </react_native_1.View>
              </react_native_1.Pressable>
              <react_native_1.Text style={styles.avatarHint}>Tap to change photo</react_native_1.Text>
            </react_native_1.View>

            {/* Error banner */}
            {saveError && (<react_native_1.View style={styles.errorBanner}>
                <lucide_react_native_1.AlertCircle size={16} color={tokens_1.color.signal}/>
                <react_native_1.Text style={styles.errorBannerText}>{saveError}</react_native_1.Text>
              </react_native_1.View>)}

            {/* Form fields */}
            <react_native_1.View style={styles.form}>
              {/* Display name */}
              <react_native_1.View style={styles.field}>
                <react_native_1.Text style={styles.fieldLabel}>Display Name</react_native_1.Text>
                <react_native_1.TextInput style={styles.fieldInput} value={form.displayName} onChangeText={function (text) { return setForm(function (f) { return (__assign(__assign({}, f), { displayName: text })); }); }} placeholder="Your name" placeholderTextColor={tokens_1.color.faint} maxLength={60} autoCapitalize="words" returnKeyType="next"/>
              </react_native_1.View>

              {/* Username */}
              <react_native_1.View style={styles.field}>
                <react_native_1.Text style={styles.fieldLabel}>Username</react_native_1.Text>
                <react_native_1.View style={styles.usernameRow}>
                  <react_native_1.View style={[styles.fieldInputWrap, styles.usernameInputWrap]}>
                    <react_native_1.Text style={styles.atSign}>@</react_native_1.Text>
                    <react_native_1.TextInput style={[styles.fieldInput, styles.usernameInput]} value={form.username} onChangeText={handleUsernameChange} placeholder="username" placeholderTextColor={tokens_1.color.faint} maxLength={24} autoCapitalize="none" autoCorrect={false} returnKeyType="next"/>
                    {usernameStatus === 'checking' && (<react_native_1.ActivityIndicator size="small" color={tokens_1.color.faint}/>)}
                    {usernameStatus === 'available' && (<lucide_react_native_1.Check size={16} color={tokens_1.color.success}/>)}
                    {(usernameStatus === 'taken' || usernameStatus === 'invalid') && (<lucide_react_native_1.X size={16} color={tokens_1.color.signal}/>)}
                  </react_native_1.View>
                </react_native_1.View>
                {usernameMessage && (<react_native_1.Text style={[styles.fieldHint, usernameStatus === 'available' ? styles.hintSuccess : styles.hintError]}>
                    {usernameMessage}
                  </react_native_1.Text>)}
                <react_native_1.Text style={styles.fieldHint}>3-24 chars, letters/numbers/underscores/periods</react_native_1.Text>
              </react_native_1.View>

              {/* Bio */}
              <react_native_1.View style={styles.field}>
                <react_native_1.View style={styles.fieldLabelRow}>
                  <react_native_1.Text style={styles.fieldLabel}>Bio</react_native_1.Text>
                  <react_native_1.Text style={[styles.charCount, form.bio.length > BIO_MAX * 0.9 && styles.charCountWarn]}>
                    {form.bio.length}/{BIO_MAX}
                  </react_native_1.Text>
                </react_native_1.View>
                <react_native_1.TextInput style={[styles.fieldInput, styles.bioInput]} value={form.bio} onChangeText={function (text) { return setForm(function (f) { return (__assign(__assign({}, f), { bio: text.slice(0, BIO_MAX) })); }); }} placeholder="Tell travelers about yourself…" placeholderTextColor={tokens_1.color.faint} multiline numberOfLines={4} textAlignVertical="top" maxLength={BIO_MAX} returnKeyType="default"/>
              </react_native_1.View>

              {/* Visibility */}
              <react_native_1.View style={styles.field}>
                <react_native_1.Text style={styles.fieldLabel}>Profile Visibility</react_native_1.Text>
                <react_native_1.View style={styles.visibilityOptions}>
                  {VISIBILITY_OPTIONS.map(function (opt) { return (<react_native_1.Pressable key={opt.key} style={[styles.visibilityOption, form.visibility === opt.key && styles.visibilityOptionActive]} onPress={function () { return setForm(function (f) { return (__assign(__assign({}, f), { visibility: opt.key })); }); }}>
                      <react_native_1.View style={styles.visibilityRadio}>
                        {form.visibility === opt.key && <react_native_1.View style={styles.visibilityRadioDot}/>}
                      </react_native_1.View>
                      <react_native_1.View style={{ flex: 1 }}>
                        <react_native_1.Text style={[styles.visibilityLabel, form.visibility === opt.key && styles.visibilityLabelActive]}>
                          {opt.label}
                        </react_native_1.Text>
                        <react_native_1.Text style={styles.visibilityDesc}>{opt.desc}</react_native_1.Text>
                      </react_native_1.View>
                    </react_native_1.Pressable>); })}
                </react_native_1.View>
              </react_native_1.View>

              {/* Preferred translation language */}
              <react_native_1.View style={styles.field}>
                <react_native_1.Text style={styles.fieldLabel}>Preferred Translation Language</react_native_1.Text>
                <react_native_1.Pressable style={styles.langPickerRow} onPress={function () { return setLangPickerVisible(true); }}>
                  <react_native_1.Text style={[styles.langPickerValue, !form.preferredLanguage && styles.langPickerPlaceholder]}>
                    {languageLabel(form.preferredLanguage)}
                  </react_native_1.Text>
                  <lucide_react_native_1.ChevronDown size={18} color={tokens_1.color.mute}/>
                </react_native_1.Pressable>
                <react_native_1.Text style={styles.fieldHint}>
                  Messages from others will be translated into this language. Leave unset to use your message language preference.
                </react_native_1.Text>
              </react_native_1.View>
            </react_native_1.View>
          </react_native_1.ScrollView>
        </react_native_1.View>
      </react_native_1.KeyboardAvoidingView>

      {/* Language picker modal */}
      <react_native_1.Modal visible={langPickerVisible} transparent animationType="slide" onRequestClose={function () { return setLangPickerVisible(false); }}>
        <react_native_1.Pressable style={styles.modalBackdrop} onPress={function () { return setLangPickerVisible(false); }}>
          <react_native_1.Pressable style={[styles.modalSheet, { paddingBottom: insets.bottom + tokens_1.space.md }]} onPress={function () { }}>
            <react_native_1.View style={styles.modalHandle}/>
            <react_native_1.Text style={styles.modalTitle}>Translation Language</react_native_1.Text>

            <react_native_1.FlatList data={__spreadArray([{ code: null, label: 'Same as message settings' }], LANGUAGE_OPTIONS, true)} keyExtractor={function (item) { var _a; return (_a = item.code) !== null && _a !== void 0 ? _a : '__none'; }} style={styles.langList} showsVerticalScrollIndicator={false} renderItem={function (_a) {
            var item = _a.item;
            var selected = form.preferredLanguage === item.code;
            return (<react_native_1.Pressable style={[styles.langItem, selected && styles.langItemSelected]} onPress={function () {
                    setForm(function (f) { return (__assign(__assign({}, f), { preferredLanguage: item.code })); });
                    setLangPickerVisible(false);
                }}>
                    <react_native_1.Text style={[styles.langItemText, selected && styles.langItemTextSelected]}>
                      {item.label}
                    </react_native_1.Text>
                    {selected && <lucide_react_native_1.Check size={16} color={tokens_1.color.ink}/>}
                  </react_native_1.Pressable>);
        }}/>
          </react_native_1.Pressable>
        </react_native_1.Pressable>
      </react_native_1.Modal>
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    loadingWrap: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: tokens_1.color.paper,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: tokens_1.space.lg,
        paddingBottom: tokens_1.space.md,
        backgroundColor: tokens_1.color.paper,
        borderBottomWidth: 1,
        borderBottomColor: tokens_1.color.haze,
    },
    headerBtn: { width: 36, alignItems: 'flex-start' },
    headerTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontWeight: '700', flex: 1, textAlign: 'center' }),
    saveBtn: {
        backgroundColor: tokens_1.color.ink,
        borderRadius: tokens_1.radius.pill,
        paddingHorizontal: tokens_1.space.lg,
        paddingVertical: 8,
        minWidth: 60,
        alignItems: 'center',
    },
    saveBtnDisabled: { backgroundColor: tokens_1.color.haze },
    saveBtnText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.onInk, fontWeight: '700' }),
    coverWrap: {
        height: 180,
        backgroundColor: tokens_1.color.haze,
        position: 'relative',
        overflow: 'hidden',
    },
    coverImage: { width: '100%', height: '100%' },
    coverPlaceholder: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: tokens_1.space.sm,
    },
    coverPlaceholderText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.faint, fontWeight: '600' }),
    coverEditBadge: __assign({ position: 'absolute', bottom: tokens_1.space.md, right: tokens_1.space.md, backgroundColor: 'rgba(17,17,15,0.65)', borderRadius: tokens_1.radius.pill, padding: 8 }, tokens_1.shadow.card),
    avatarRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: tokens_1.space.lg,
        paddingTop: tokens_1.space.md,
        paddingBottom: tokens_1.space.sm,
        gap: tokens_1.space.md,
    },
    avatarWrap: __assign({ width: 80, height: 80, borderRadius: 40, borderWidth: 3, borderColor: tokens_1.color.paper, backgroundColor: tokens_1.color.haze, overflow: 'visible' }, tokens_1.shadow.card),
    avatar: { width: 74, height: 74, borderRadius: 37 },
    avatarEmpty: {
        width: 74,
        height: 74,
        borderRadius: 37,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#F0EDE8',
    },
    avatarEditBadge: {
        position: 'absolute',
        bottom: 0,
        right: 0,
        backgroundColor: tokens_1.color.ink,
        borderRadius: 12,
        padding: 5,
        borderWidth: 2,
        borderColor: tokens_1.color.paper,
    },
    avatarHint: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontWeight: '500' }),
    errorBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.sm,
        marginHorizontal: tokens_1.space.lg,
        marginTop: tokens_1.space.sm,
        backgroundColor: '#FFF1EF',
        borderRadius: tokens_1.radius.sm,
        borderWidth: 1,
        borderColor: '#FFCCBB',
        padding: tokens_1.space.md,
    },
    errorBannerText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, flex: 1 }),
    form: {
        paddingHorizontal: tokens_1.space.lg,
        paddingTop: tokens_1.space.md,
        gap: tokens_1.space.xl,
    },
    field: { gap: tokens_1.space.sm },
    fieldLabelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    fieldLabel: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 }),
    fieldInput: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, backgroundColor: tokens_1.color.paperRaised, borderWidth: 1, borderColor: tokens_1.color.haze, borderRadius: tokens_1.radius.sm, paddingHorizontal: tokens_1.space.md, paddingVertical: tokens_1.space.md }),
    fieldInputWrap: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: tokens_1.color.paperRaised,
        borderWidth: 1,
        borderColor: tokens_1.color.haze,
        borderRadius: tokens_1.radius.sm,
        paddingHorizontal: tokens_1.space.md,
        paddingVertical: tokens_1.space.sm,
        gap: tokens_1.space.xs,
    },
    usernameRow: {},
    usernameInputWrap: { flex: 1 },
    atSign: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute, fontWeight: '600' }),
    usernameInput: {
        flex: 1,
        backgroundColor: 'transparent',
        borderWidth: 0,
        paddingHorizontal: 0,
        paddingVertical: 4,
    },
    bioInput: {
        minHeight: 100,
        paddingTop: tokens_1.space.md,
    },
    charCount: __assign(__assign({}, tokens_1.type.stamp), { color: tokens_1.color.faint }),
    charCountWarn: { color: tokens_1.color.warn },
    fieldHint: __assign(__assign({}, tokens_1.type.stamp), { color: tokens_1.color.faint, fontSize: 11 }),
    hintSuccess: { color: tokens_1.color.success },
    hintError: { color: tokens_1.color.signal },
    visibilityOptions: {
        gap: tokens_1.space.sm,
    },
    visibilityOption: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.md,
        backgroundColor: tokens_1.color.paperRaised,
        borderWidth: 1,
        borderColor: tokens_1.color.haze,
        borderRadius: tokens_1.radius.md,
        padding: tokens_1.space.md,
    },
    visibilityOptionActive: {
        borderColor: tokens_1.color.ink,
        backgroundColor: tokens_1.color.paper,
    },
    visibilityRadio: {
        width: 20,
        height: 20,
        borderRadius: 10,
        borderWidth: 2,
        borderColor: tokens_1.color.haze,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: tokens_1.color.paperRaised,
    },
    visibilityRadioDot: {
        width: 10,
        height: 10,
        borderRadius: 5,
        backgroundColor: tokens_1.color.ink,
    },
    visibilityLabel: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.mute, fontWeight: '600' }),
    visibilityLabelActive: { color: tokens_1.color.ink },
    visibilityDesc: __assign(__assign({}, tokens_1.type.stamp), { color: tokens_1.color.faint, marginTop: 2 }),
    langPickerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: tokens_1.color.paperRaised,
        borderWidth: 1,
        borderColor: tokens_1.color.haze,
        borderRadius: tokens_1.radius.sm,
        paddingHorizontal: tokens_1.space.md,
        paddingVertical: tokens_1.space.md,
    },
    langPickerValue: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, flex: 1 }),
    langPickerPlaceholder: { color: tokens_1.color.faint },
    modalBackdrop: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.4)',
        justifyContent: 'flex-end',
    },
    modalSheet: {
        backgroundColor: tokens_1.color.paper,
        borderTopLeftRadius: tokens_1.radius.lg,
        borderTopRightRadius: tokens_1.radius.lg,
        paddingTop: tokens_1.space.sm,
        paddingHorizontal: tokens_1.space.lg,
        maxHeight: '70%',
    },
    modalHandle: {
        width: 36,
        height: 4,
        borderRadius: 2,
        backgroundColor: tokens_1.color.haze,
        alignSelf: 'center',
        marginBottom: tokens_1.space.md,
    },
    modalTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontWeight: '700', marginBottom: tokens_1.space.md }),
    langList: { flexGrow: 0 },
    langItem: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: tokens_1.space.md,
        borderBottomWidth: 1,
        borderBottomColor: tokens_1.color.haze,
    },
    langItemSelected: {},
    langItemText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink }),
    langItemTextSelected: { fontWeight: '700' },
});
