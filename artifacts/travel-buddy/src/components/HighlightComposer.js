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
exports.HighlightComposer = HighlightComposer;
/**
 * HighlightComposer — bottom sheet for creating a Highlight.
 * Media picker (photo + video ≤10s), caption, location tag,
 * visibility selector, duration selector, then POST /api/highlights.
 *
 * Video picks are previewed with a native expo-av player (muted, looping).
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var ImagePicker = require("expo-image-picker");
var expo_av_1 = require("expo-av");
var lucide_react_native_1 = require("lucide-react-native");
var react_native_safe_area_context_1 = require("react-native-safe-area-context");
var tokens_1 = require("../theme/tokens");
var media_1 = require("../services/media");
var highlights_1 = require("../services/highlights");
var SessionContext_1 = require("../context/SessionContext");
var expo_router_1 = require("expo-router");
var MediaFilterEditor_1 = require("./MediaFilterEditor");
var GlobalPlacePicker_1 = require("./selectors/GlobalPlacePicker");
var MAX_VIDEO_DURATION_SECONDS = 10;
var DURATIONS = [
    { hours: 3, label: '3h' },
    { hours: 6, label: '6h' },
    { hours: 12, label: '12h' },
    { hours: 24, label: '24h' },
    { hours: 48, label: '48h' },
];
var VISIBILITIES = [
    { value: 'public', label: 'Everyone' },
    { value: 'travelers_nearby', label: 'Nearby travelers' },
    { value: 'circle_only', label: 'My circle' },
    { value: 'trip_only', label: 'Trip members' },
    { value: 'private', label: 'Only me' },
];
function HighlightComposer(_a) {
    var _b, _c, _d, _e, _f, _g;
    var visible = _a.visible, onClose = _a.onClose, onSuccess = _a.onSuccess;
    var insets = (0, react_native_safe_area_context_1.useSafeAreaInsets)();
    var signOut = (0, SessionContext_1.useSession)().signOut;
    var _h = (0, react_1.useState)(null), mediaUri = _h[0], setMediaUri = _h[1];
    var _j = (0, react_1.useState)('image/jpeg'), mimeType = _j[0], setMimeType = _j[1];
    var _k = (0, react_1.useState)(false), isVideo = _k[0], setIsVideo = _k[1];
    var _l = (0, react_1.useState)(null), videoDuration = _l[0], setVideoDuration = _l[1];
    var _m = (0, react_1.useState)(null), fileSize = _m[0], setFileSize = _m[1];
    var _o = (0, react_1.useState)(''), caption = _o[0], setCaption = _o[1];
    var _p = (0, react_1.useState)('public'), vis = _p[0], setVis = _p[1];
    var _q = (0, react_1.useState)(24), expiresInHours = _q[0], setExpiresInHours = _q[1];
    var _r = (0, react_1.useState)({ source: 'none' }), loc = _r[0], setLoc = _r[1];
    var _s = (0, react_1.useState)(false), placePickerOpen = _s[0], setPlacePickerOpen = _s[1];
    var _t = (0, react_1.useState)(false), submitting = _t[0], setSubmitting = _t[1];
    var _u = (0, react_1.useState)(null), error = _u[0], setError = _u[1];
    var _v = (0, react_1.useState)(false), filterEditorOpen = _v[0], setFilterEditorOpen = _v[1];
    var _w = (0, react_1.useState)(null), filterEditorAsset = _w[0], setFilterEditorAsset = _w[1];
    var _x = (0, react_1.useState)('original'), filterId = _x[0], setFilterId = _x[1];
    var _y = (0, react_1.useState)(100), filterIntensity = _y[0], setFilterIntensity = _y[1];
    (0, react_1.useEffect)(function () {
        if (visible) {
            setMediaUri(null);
            setMimeType('image/jpeg');
            setIsVideo(false);
            setVideoDuration(null);
            setFileSize(null);
            setCaption('');
            setVis('public');
            setExpiresInHours(24);
            setLoc({ source: 'none' });
            setPlacePickerOpen(false);
            setError(null);
            setFilterEditorOpen(false);
            setFilterEditorAsset(null);
            setFilterId('original');
            setFilterIntensity(100);
        }
    }, [visible]);
    function pickFromLibrary() {
        return __awaiter(this, void 0, void 0, function () {
            var perm, res;
            var _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        setError(null);
                        return [4 /*yield*/, ImagePicker.requestMediaLibraryPermissionsAsync()];
                    case 1:
                        perm = _b.sent();
                        if (!perm.granted) {
                            setError('Photo library permission required to add media.');
                            return [2 /*return*/];
                        }
                        return [4 /*yield*/, ImagePicker.launchImageLibraryAsync({
                                mediaTypes: ['images', 'videos'],
                                quality: 0.85,
                                videoMaxDuration: MAX_VIDEO_DURATION_SECONDS,
                                allowsEditing: true,
                            })];
                    case 2:
                        res = _b.sent();
                        if (res.canceled || !((_a = res.assets) === null || _a === void 0 ? void 0 : _a[0]))
                            return [2 /*return*/];
                        handlePickedAsset(res.assets[0]);
                        return [2 /*return*/];
                }
            });
        });
    }
    function pickFromCamera() {
        return __awaiter(this, void 0, void 0, function () {
            var perm, res;
            var _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        setError(null);
                        return [4 /*yield*/, ImagePicker.requestCameraPermissionsAsync()];
                    case 1:
                        perm = _b.sent();
                        if (!perm.granted) {
                            setError('Camera access denied. Enable it in Settings to capture media for Highlights.');
                            return [2 /*return*/];
                        }
                        return [4 /*yield*/, ImagePicker.launchCameraAsync({
                                mediaTypes: ['images', 'videos'],
                                quality: 0.85,
                                videoMaxDuration: MAX_VIDEO_DURATION_SECONDS,
                                allowsEditing: true,
                            })];
                    case 2:
                        res = _b.sent();
                        if (res.canceled || !((_a = res.assets) === null || _a === void 0 ? void 0 : _a[0]))
                            return [2 /*return*/];
                        handlePickedAsset(res.assets[0]);
                        return [2 /*return*/];
                }
            });
        });
    }
    function handlePickedAsset(a) {
        var _a, _b, _c, _d;
        var mime = (_a = a.mimeType) !== null && _a !== void 0 ? _a : (a.type === 'video' ? 'video/mp4' : 'image/jpeg');
        var asVideo = mime.startsWith('video/') || a.type === 'video';
        var durationSec = a.duration ? a.duration / 1000 : null;
        if (asVideo && durationSec != null && durationSec > MAX_VIDEO_DURATION_SECONDS) {
            setError("Highlights can be up to ".concat(MAX_VIDEO_DURATION_SECONDS, "s. Your video is ").concat(durationSec.toFixed(1), "s."));
            return;
        }
        var picked = {
            uri: a.uri,
            mimeType: mime,
            fileName: (_b = a.fileName) !== null && _b !== void 0 ? _b : null,
            fileSize: (_c = a.fileSize) !== null && _c !== void 0 ? _c : null,
            width: a.width,
            height: a.height,
            type: a.type,
        };
        var v = (0, media_1.validateMedia)(picked, { maxVideoDurationSeconds: 10 });
        if (!v.ok) {
            setError(v.message);
            return;
        }
        setMimeType(mime);
        setIsVideo(asVideo);
        setVideoDuration(durationSec);
        setFileSize((_d = a.fileSize) !== null && _d !== void 0 ? _d : null);
        setFilterEditorAsset(a);
        setFilterEditorOpen(true);
    }
    var handleFilterApply = (0, react_1.useCallback)(function (result) {
        setFilterEditorOpen(false);
        setMediaUri(result.uri);
        setFilterId(result.filterId);
        setFilterIntensity(result.filterIntensity);
        setFilterEditorAsset(null);
    }, []);
    function applyPlace(p) {
        if (p.source === 'gps' && p.lat != null && p.lng != null) {
            setLoc({ source: 'gps', lat: p.lat, lng: p.lng, name: p.name, city: p.city, country: p.country });
        }
        else {
            setLoc({ source: 'manual', name: p.name, city: p.city, country: p.country });
        }
        setPlacePickerOpen(false);
    }
    function handleSubmit() {
        return __awaiter(this, void 0, void 0, function () {
            var up, locationCity, locationCountry, locationName, result;
            var _a, _b, _c;
            return __generator(this, function (_d) {
                switch (_d.label) {
                    case 0:
                        if (!mediaUri || submitting)
                            return [2 /*return*/];
                        setSubmitting(true);
                        setError(null);
                        _d.label = 1;
                    case 1:
                        _d.trys.push([1, , 10, 11]);
                        return [4 /*yield*/, (0, media_1.uploadMedia)({
                                uri: mediaUri,
                                mimeType: mimeType,
                                fileSize: fileSize,
                                type: isVideo ? 'video' : 'image',
                            })];
                    case 2:
                        up = _d.sent();
                        if (!(!up.ok || !up.url)) return [3 /*break*/, 5];
                        if (!(up.errorKind === 'unauthenticated')) return [3 /*break*/, 4];
                        return [4 /*yield*/, signOut()];
                    case 3:
                        _d.sent();
                        expo_router_1.router.replace('/(auth)/sign-in');
                        onClose();
                        return [2 /*return*/];
                    case 4:
                        setError((_a = up.message) !== null && _a !== void 0 ? _a : 'Media upload failed.');
                        return [2 /*return*/];
                    case 5:
                        locationCity = loc.source === 'gps' ? loc.city : null;
                        locationCountry = loc.source === 'gps' ? loc.country : null;
                        locationName = loc.source === 'none' ? null : loc.source === 'manual' ? loc.name : ((_b = loc.name) !== null && _b !== void 0 ? _b : loc.city);
                        return [4 /*yield*/, (0, highlights_1.createHighlight)({
                                mediaUrl: up.url,
                                mediaType: mimeType,
                                videoDurationSeconds: videoDuration,
                                caption: caption.trim() || null,
                                locationName: locationName,
                                locationCity: locationCity,
                                locationCountry: locationCountry,
                                visibility: vis,
                                expiresInHours: expiresInHours,
                                filterId: filterId,
                                filterIntensity: filterIntensity,
                            })];
                    case 6:
                        result = _d.sent();
                        if (!!result.ok) return [3 /*break*/, 9];
                        if (!(result.errorKind === 'unauthenticated')) return [3 /*break*/, 8];
                        return [4 /*yield*/, signOut()];
                    case 7:
                        _d.sent();
                        expo_router_1.router.replace('/(auth)/sign-in');
                        onClose();
                        return [2 /*return*/];
                    case 8:
                        setError((_c = result.message) !== null && _c !== void 0 ? _c : 'Could not post highlight.');
                        return [2 /*return*/];
                    case 9:
                        onSuccess === null || onSuccess === void 0 ? void 0 : onSuccess();
                        onClose();
                        return [3 /*break*/, 11];
                    case 10:
                        setSubmitting(false);
                        return [7 /*endfinally*/];
                    case 11: return [2 /*return*/];
                }
            });
        });
    }
    var locLabel = loc.source === 'gps' ? "".concat((_c = (_b = loc.name) !== null && _b !== void 0 ? _b : loc.city) !== null && _c !== void 0 ? _c : 'Current location', " \u00B7 GPS")
        : loc.source === 'manual' ? "".concat(loc.name, " \u00B7 Manual")
            : null;
    var canSubmit = !!mediaUri && !submitting;
    return (<react_native_1.Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <react_native_1.KeyboardAvoidingView style={{ flex: 1 }} behavior={react_native_1.Platform.OS === 'ios' ? 'padding' : 'height'}>
        <react_native_1.Pressable style={s.backdrop} onPress={onClose}/>
        <react_native_1.View style={[s.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          <react_native_1.View style={s.grab}/>
          <react_native_1.View style={s.head}>
            <react_native_1.Text style={s.headTitle}>New Highlight</react_native_1.Text>
            <react_native_1.Pressable onPress={onClose} hitSlop={8} style={s.closeBtn}>
              <lucide_react_native_1.X size={18} color={tokens_1.color.ink}/>
            </react_native_1.Pressable>
          </react_native_1.View>

          <react_native_1.ScrollView style={{ flex: 1 }} contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            {/* Media picker */}
            <react_native_1.View style={s.field}>
              <react_native_1.Text style={s.fieldLabel}>Media <react_native_1.Text style={{ color: tokens_1.color.signal }}>*</react_native_1.Text></react_native_1.Text>
              {mediaUri ? (<react_native_1.View style={s.mediaPreviewWrap}>
                  {isVideo ? (<expo_av_1.Video source={{ uri: mediaUri }} style={s.mediaPreview} resizeMode={expo_av_1.ResizeMode.COVER} shouldPlay isLooping isMuted useNativeControls={false}/>) : (<react_native_1.Image source={{ uri: mediaUri }} style={s.mediaPreview} resizeMode="cover"/>)}
                  <react_native_1.Pressable style={s.mediaRemove} onPress={function () { return setMediaUri(null); }} hitSlop={8}>
                    <lucide_react_native_1.X size={14} color="#fff"/>
                  </react_native_1.Pressable>
                  {isVideo && videoDuration != null && (<react_native_1.View style={s.durationBadge}>
                      <react_native_1.Text style={s.durationText}>{videoDuration.toFixed(1)}s</react_native_1.Text>
                    </react_native_1.View>)}
                </react_native_1.View>) : (<react_native_1.View style={s.mediaBtns}>
                  <react_native_1.Pressable style={s.mediaBtn} onPress={pickFromCamera}>
                    <lucide_react_native_1.Camera size={18} color={tokens_1.color.signal}/>
                    <react_native_1.Text style={s.mediaBtnText}>Camera</react_native_1.Text>
                  </react_native_1.Pressable>
                  <react_native_1.Pressable style={s.mediaBtn} onPress={pickFromLibrary}>
                    <lucide_react_native_1.Video size={18} color={tokens_1.color.deep}/>
                    <react_native_1.Text style={s.mediaBtnText}>Library</react_native_1.Text>
                  </react_native_1.Pressable>
                </react_native_1.View>)}
              <react_native_1.Text style={s.mediaHint}>Photos or videos up to {MAX_VIDEO_DURATION_SECONDS}s</react_native_1.Text>
            </react_native_1.View>

            {/* Caption */}
            <react_native_1.View style={s.field}>
              <react_native_1.Text style={s.fieldLabel}>Caption</react_native_1.Text>
              <react_native_1.TextInput style={[s.input, s.multiline]} placeholder="Add a caption…" placeholderTextColor={tokens_1.color.faint} multiline value={caption} onChangeText={setCaption} editable={!submitting} textAlignVertical="top"/>
            </react_native_1.View>

            {/* Location */}
            <react_native_1.View style={s.field}>
              <react_native_1.Text style={s.fieldLabel}>Location</react_native_1.Text>
              <react_native_1.Pressable style={[s.locPickerBtn, loc.source !== 'none' && s.locPickerBtnActive]} onPress={function () { return setPlacePickerOpen(true); }} disabled={submitting}>
                <lucide_react_native_1.MapPin size={14} color={loc.source !== 'none' ? tokens_1.color.signal : tokens_1.color.mute}/>
                <react_native_1.Text style={[s.locPickerText, loc.source === 'none' && s.locPickerPlaceholder]} numberOfLines={1}>
                  {locLabel !== null && locLabel !== void 0 ? locLabel : 'Add a location…'}
                </react_native_1.Text>
                {loc.source !== 'none' && (<react_native_1.Pressable hitSlop={8} onPress={function () { return setLoc({ source: 'none' }); }}>
                    <lucide_react_native_1.X size={13} color={tokens_1.color.mute}/>
                  </react_native_1.Pressable>)}
              </react_native_1.Pressable>
            </react_native_1.View>

            {/* Visibility */}
            <react_native_1.View style={s.field}>
              <react_native_1.Text style={s.fieldLabel}>Who can see this?</react_native_1.Text>
              <react_native_1.View style={s.chipRow}>
                {VISIBILITIES.map(function (_a) {
            var value = _a.value, label = _a.label;
            return (<react_native_1.Pressable key={value} style={[s.chip, vis === value && s.chipOn]} onPress={function () { return setVis(value); }}>
                    <react_native_1.Text style={[s.chipText, vis === value && s.chipTextOn]}>{label}</react_native_1.Text>
                  </react_native_1.Pressable>);
        })}
              </react_native_1.View>
            </react_native_1.View>

            {/* Duration */}
            <react_native_1.View style={s.field}>
              <react_native_1.Text style={s.fieldLabel}>Expires in</react_native_1.Text>
              <react_native_1.View style={s.chipRow}>
                {DURATIONS.map(function (_a) {
            var hours = _a.hours, label = _a.label;
            return (<react_native_1.Pressable key={hours} style={[s.chip, expiresInHours === hours && s.chipOn]} onPress={function () { return setExpiresInHours(hours); }}>
                    <react_native_1.Text style={[s.chipText, expiresInHours === hours && s.chipTextOn]}>{label}</react_native_1.Text>
                  </react_native_1.Pressable>);
        })}
              </react_native_1.View>
            </react_native_1.View>

            {error && (<react_native_1.View style={s.errorBox}>
                <react_native_1.Text style={s.errorText}>{error}</react_native_1.Text>
              </react_native_1.View>)}
          </react_native_1.ScrollView>

          <react_native_1.View style={s.footer}>
            <react_native_1.Pressable style={[s.submitBtn, !canSubmit && s.submitDisabled]} onPress={handleSubmit} disabled={!canSubmit}>
              {submitting
            ? <react_native_1.ActivityIndicator size="small" color={tokens_1.color.onInk}/>
            : <react_native_1.Text style={s.submitText}>Share Highlight</react_native_1.Text>}
            </react_native_1.Pressable>
          </react_native_1.View>
        </react_native_1.View>
      </react_native_1.KeyboardAvoidingView>

      {/* Place picker */}
      <GlobalPlacePicker_1.GlobalPlacePicker visible={placePickerOpen} title="Tag a Location" usedFor="highlight_location" onSelect={applyPlace} onClose={function () { return setPlacePickerOpen(false); }}/>

      {/* Filter editor — opens after media pick, before storing */}
      {filterEditorOpen && filterEditorAsset && (<MediaFilterEditor_1.MediaFilterEditor file={{
                uri: filterEditorAsset.uri,
                mimeType: (_d = filterEditorAsset.mimeType) !== null && _d !== void 0 ? _d : (filterEditorAsset.type === 'video' ? 'video/mp4' : 'image/jpeg'),
                width: (_e = filterEditorAsset.width) !== null && _e !== void 0 ? _e : null,
                height: (_f = filterEditorAsset.height) !== null && _f !== void 0 ? _f : null,
            }} mediaType={filterEditorAsset.type === 'video' || ((_g = filterEditorAsset.mimeType) !== null && _g !== void 0 ? _g : '').startsWith('video/') ? 'video' : 'image'} onApply={handleFilterApply} onCancel={function () {
                setFilterEditorOpen(false);
                setFilterEditorAsset(null);
            }}/>)}
    </react_native_1.Modal>);
}
var s = react_native_1.StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: 'rgba(17,17,15,0.45)' },
    sheet: __assign({ backgroundColor: tokens_1.color.paper, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '90%' }, tokens_1.shadow.float),
    grab: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: tokens_1.color.haze, marginTop: 10, marginBottom: 4 },
    head: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: tokens_1.space.lg, paddingVertical: 10 },
    headTitle: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink, flex: 1 }),
    closeBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: tokens_1.color.paperRaised, borderWidth: 1, borderColor: tokens_1.color.haze },
    scroll: { paddingHorizontal: tokens_1.space.lg, paddingBottom: tokens_1.space.lg, gap: tokens_1.space.md },
    field: { gap: 6 },
    fieldLabel: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: tokens_1.color.mute, letterSpacing: 0.8, textTransform: 'uppercase' },
    mediaBtns: { flexDirection: 'row', gap: tokens_1.space.md },
    mediaBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: tokens_1.color.paperRaised, borderWidth: 1.5, borderColor: tokens_1.color.haze, borderRadius: tokens_1.radius.md, paddingVertical: tokens_1.space.md },
    mediaBtnText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', color: tokens_1.color.ink }),
    mediaHint: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.faint, fontSize: 11 }),
    mediaPreviewWrap: { position: 'relative' },
    mediaPreview: { width: '100%', height: 220, borderRadius: tokens_1.radius.md, backgroundColor: tokens_1.color.haze },
    videoPlayOverlay: __assign(__assign({}, react_native_1.StyleSheet.absoluteFillObject), { alignItems: 'center', justifyContent: 'center', borderRadius: tokens_1.radius.md }),
    mediaRemove: { position: 'absolute', top: 8, right: 8, width: 28, height: 28, borderRadius: 14, backgroundColor: 'rgba(17,17,15,0.6)', alignItems: 'center', justifyContent: 'center' },
    durationBadge: { position: 'absolute', bottom: 8, left: 8, backgroundColor: 'rgba(17,17,15,0.6)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: tokens_1.radius.sm },
    durationText: { fontFamily: 'Courier', fontSize: 11, color: '#fff', fontWeight: '700' },
    input: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, backgroundColor: tokens_1.color.paperRaised, borderWidth: 1, borderColor: tokens_1.color.haze, borderRadius: tokens_1.radius.md, paddingHorizontal: tokens_1.space.md, paddingVertical: 10 }),
    multiline: { height: 80, paddingTop: 10 },
    locLabel: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.success, fontWeight: '600' }),
    locPickerBtn: {
        flexDirection: 'row', alignItems: 'center', gap: 8,
        borderWidth: 1, borderColor: tokens_1.color.haze, borderRadius: tokens_1.radius.md,
        backgroundColor: tokens_1.color.paperRaised, paddingHorizontal: tokens_1.space.md, paddingVertical: 12,
    },
    locPickerBtnActive: { borderColor: tokens_1.color.signal },
    locPickerText: __assign(__assign({ flex: 1 }, tokens_1.type.body), { color: tokens_1.color.ink }),
    locPickerPlaceholder: { color: tokens_1.color.faint },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    chip: { paddingHorizontal: tokens_1.space.md, paddingVertical: tokens_1.space.sm, borderRadius: tokens_1.radius.pill, borderWidth: 1, borderColor: tokens_1.color.haze, backgroundColor: tokens_1.color.paperRaised },
    chipOn: { backgroundColor: tokens_1.color.signal, borderColor: tokens_1.color.signal },
    chipText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', color: tokens_1.color.ink, fontSize: 12 }),
    chipTextOn: { color: tokens_1.color.onInk },
    errorBox: { backgroundColor: '#FEF2F2', borderRadius: tokens_1.radius.md, padding: tokens_1.space.md },
    errorText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, fontWeight: '600' }),
    footer: { paddingHorizontal: tokens_1.space.lg, paddingTop: tokens_1.space.md },
    submitBtn: { backgroundColor: tokens_1.color.ink, borderRadius: tokens_1.radius.md, paddingVertical: 14, alignItems: 'center' },
    submitDisabled: { opacity: 0.4 },
    submitText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.onInk }),
});
