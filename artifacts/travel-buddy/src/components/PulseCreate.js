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
exports.PulseFilterSheet = PulseFilterSheet;
exports.UnifiedPostComposer = UnifiedPostComposer;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var ImagePicker = require("expo-image-picker");
var lucide_react_native_1 = require("lucide-react-native");
var react_native_safe_area_context_1 = require("react-native-safe-area-context");
var models_1 = require("../types/models");
var tokens_1 = require("../theme/tokens");
var usePosts_1 = require("../hooks/usePosts");
var media_1 = require("../services/media");
var SessionContext_1 = require("../context/SessionContext");
var location_1 = require("../services/location");
var HighlightComposer_1 = require("./HighlightComposer");
var MediaFilterEditor_1 = require("./MediaFilterEditor");
/* ── Types ── */
var POST_TYPES = [
    { id: 'post_update', label: 'Post Update', sub: 'Share what\'s happening.', icon: lucide_react_native_1.PenLine, iconColor: tokens_1.color.signal },
    { id: 'ask_question', label: 'Ask Question', sub: 'Ask travelers nearby.', icon: lucide_react_native_1.HelpCircle, iconColor: '#8B5CF6' },
    { id: 'share_moment', label: 'Share a Moment', sub: 'Capture a travel moment.', icon: lucide_react_native_1.Camera, iconColor: tokens_1.color.warn },
    { id: 'share_postcard', label: 'Share Postcard', sub: 'A photo from your trip.', icon: lucide_react_native_1.Mail, iconColor: tokens_1.color.deep },
    { id: 'share_hidden_gem', label: 'Hidden Gem', sub: 'Recommend a place.', icon: lucide_react_native_1.Gem, iconColor: tokens_1.color.success },
    { id: 'share_food_spot', label: 'Food Spot', sub: 'Local food recommendation.', icon: lucide_react_native_1.UtensilsCrossed, iconColor: '#F97316' },
    { id: 'share_highlight', label: 'Highlight', sub: 'Photo or video up to 10s.', icon: lucide_react_native_1.Video, iconColor: '#E91E8C' },
];
var TYPE_CATEGORY = {
    post_update: 'tip',
    ask_question: 'question',
    share_moment: 'activity',
    share_postcard: 'activity',
    share_hidden_gem: 'activity',
    share_food_spot: 'food',
    share_highlight: 'highlight',
};
var SUBMIT_LABEL = {
    post_update: 'Post Update',
    ask_question: 'Ask Question',
    share_moment: 'Share Moment',
    share_postcard: 'Share Postcard',
    share_hidden_gem: 'Share Hidden Gem',
    share_food_spot: 'Share Food Spot',
    share_highlight: 'Share Highlight',
};
/** Types that bypass the standard post form and open a dedicated composer. */
var DEDICATED_COMPOSERS = {
    share_highlight: true,
};
function needsPlace(t) { return t === 'share_hidden_gem' || t === 'share_food_spot'; }
function requiresMedia(t) { return t === 'share_postcard'; }
function requiresPhoto(t) { return t === 'share_postcard'; }
function photoLabel(t) {
    if (requiresMedia(t))
        return 'Add photo or video (required)';
    if (t === 'share_moment')
        return 'Add photo (recommended)';
    return 'Add photo (optional)';
}
function validate(type, text, placeName, media) {
    switch (type) {
        case 'post_update': return (!text.trim() && !media) ? 'Add text or a photo.' : null;
        case 'ask_question': return !text.trim() ? 'Type your question.' : null;
        case 'share_moment': return (!text.trim() && !media) ? 'Add text or a photo.' : null;
        case 'share_postcard': return !media ? 'Add a photo or video for your postcard.' : null;
        case 'share_hidden_gem': {
            if (!placeName.trim())
                return 'Enter a place name.';
            if (!text.trim())
                return 'Add a description.';
            return null;
        }
        case 'share_food_spot': {
            if (!placeName.trim())
                return 'Enter the name of the spot.';
            if (!text.trim())
                return 'Add a recommendation.';
            return null;
        }
        case 'share_highlight':
            // Handled by dedicated HighlightComposer — always "valid" here
            return null;
    }
}
/* ── Filter bottom sheet ── */
function PulseFilterSheet(_a) {
    var visible = _a.visible, active = _a.active, onToggle = _a.onToggle, onClear = _a.onClear, onClose = _a.onClose;
    return (<react_native_1.Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <react_native_1.Pressable style={fs.backdrop} onPress={onClose}/>
      <react_native_1.View style={fs.sheet}>
        <react_native_1.View style={fs.grab}/>
        <react_native_1.View style={fs.head}>
          <react_native_1.Text style={fs.title}>Filter Pulse</react_native_1.Text>
          <react_native_1.View style={{ flex: 1 }}/>
          {active.length > 0 && (<react_native_1.Pressable onPress={onClear} hitSlop={tokens_1.layout.hitSlop}><react_native_1.Text style={fs.clear}>Clear ({active.length})</react_native_1.Text></react_native_1.Pressable>)}
          <react_native_1.Pressable onPress={onClose} hitSlop={tokens_1.layout.hitSlop} style={fs.x}><lucide_react_native_1.X size={18} color={tokens_1.color.ink}/></react_native_1.Pressable>
        </react_native_1.View>
        <react_native_1.ScrollView contentContainerStyle={fs.chips}>
          {models_1.PULSE_FILTERS.map(function (f) {
            var on = active.includes(f);
            return (<react_native_1.Pressable key={f} style={[fs.chip, on && fs.chipOn]} onPress={function () { return onToggle(f); }}>
                {on ? <lucide_react_native_1.Check size={14} color={tokens_1.color.onInk}/> : null}
                <react_native_1.Text style={[fs.chipText, on && fs.chipTextOn]}>{f}</react_native_1.Text>
              </react_native_1.Pressable>);
        })}
        </react_native_1.ScrollView>
        <react_native_1.Pressable style={fs.apply} onPress={onClose}>
          <react_native_1.Text style={fs.applyText}>Show results</react_native_1.Text>
        </react_native_1.Pressable>
      </react_native_1.View>
    </react_native_1.Modal>);
}
/* ── Unified post composer ── */
function UnifiedPostComposer(_a) {
    var _b, _c, _d, _e, _f, _g;
    var visible = _a.visible, onClose = _a.onClose, onSuccess = _a.onSuccess;
    var insets = (0, react_native_safe_area_context_1.useSafeAreaInsets)();
    var _h = (0, usePosts_1.usePostActions)(), create = _h.create, submitting = _h.submitting;
    var signOut = (0, SessionContext_1.useSession)().signOut;
    var _j = (0, react_1.useState)(null), selectedType = _j[0], setSelectedType = _j[1];
    var _k = (0, react_1.useState)(''), text = _k[0], setText = _k[1];
    var _l = (0, react_1.useState)(''), placeName = _l[0], setPlaceName = _l[1];
    var _m = (0, react_1.useState)(null), media = _m[0], setMedia = _m[1];
    var _o = (0, react_1.useState)('public'), vis = _o[0], setVis = _o[1];
    var _p = (0, react_1.useState)({ source: 'none' }), loc = _p[0], setLoc = _p[1];
    var _q = (0, react_1.useState)(''), manualText = _q[0], setManualText = _q[1];
    var _r = (0, react_1.useState)(false), gpsBusy = _r[0], setGpsBusy = _r[1];
    var _s = (0, react_1.useState)(false), addToPassport = _s[0], setAddToPassport = _s[1];
    var _t = (0, react_1.useState)(null), error = _t[0], setError = _t[1];
    var _u = (0, react_1.useState)(false), highlightComposerOpen = _u[0], setHighlightComposerOpen = _u[1];
    var _v = (0, react_1.useState)(false), filterEditorOpen = _v[0], setFilterEditorOpen = _v[1];
    var _w = (0, react_1.useState)(null), filterEditorPending = _w[0], setFilterEditorPending = _w[1];
    var _x = (0, react_1.useState)('original'), filterId = _x[0], setFilterId = _x[1];
    var _y = (0, react_1.useState)(100), filterIntensity = _y[0], setFilterIntensity = _y[1];
    (0, react_1.useEffect)(function () {
        if (visible) {
            setSelectedType(null);
            setText('');
            setPlaceName('');
            setMedia(null);
            setVis('public');
            setLoc({ source: 'none' });
            setManualText('');
            setAddToPassport(false);
            setError(null);
            setHighlightComposerOpen(false);
            setFilterEditorOpen(false);
            setFilterEditorPending(null);
            setFilterId('original');
            setFilterIntensity(100);
        }
    }, [visible]);
    function pickMedia() {
        return __awaiter(this, void 0, void 0, function () {
            var perm, allowVideo, res, a, durationSec, picked, v;
            var _a, _b, _c;
            return __generator(this, function (_d) {
                switch (_d.label) {
                    case 0:
                        setError(null);
                        return [4 /*yield*/, ImagePicker.requestMediaLibraryPermissionsAsync()];
                    case 1:
                        perm = _d.sent();
                        if (!perm.granted) {
                            setError('Photo library permission required.');
                            return [2 /*return*/];
                        }
                        allowVideo = selectedType === 'share_postcard';
                        return [4 /*yield*/, ImagePicker.launchImageLibraryAsync({
                                mediaTypes: allowVideo ? ['images', 'videos'] : ['images'],
                                quality: 0.85,
                                videoMaxDuration: allowVideo ? 10 : undefined,
                            })];
                    case 2:
                        res = _d.sent();
                        if (res.canceled || !((_a = res.assets) === null || _a === void 0 ? void 0 : _a[0]))
                            return [2 /*return*/];
                        a = res.assets[0];
                        durationSec = a.duration != null ? a.duration / 1000 : null;
                        picked = {
                            uri: a.uri, mimeType: (_b = a.mimeType) !== null && _b !== void 0 ? _b : 'image/jpeg',
                            fileName: a.fileName, fileSize: (_c = a.fileSize) !== null && _c !== void 0 ? _c : null,
                            width: a.width, height: a.height, type: a.type,
                            duration: durationSec,
                        };
                        v = (0, media_1.validateMedia)(picked, selectedType === 'share_postcard' ? { maxVideoDurationSeconds: 10 } : undefined);
                        if (!v.ok) {
                            setError(v.message);
                            return [2 /*return*/];
                        }
                        if (selectedType === 'share_postcard' || selectedType === 'share_moment')
                            setAddToPassport(true);
                        setFilterEditorPending(picked);
                        setFilterEditorOpen(true);
                        return [2 /*return*/];
                }
            });
        });
    }
    var handleFilterApply = (0, react_1.useCallback)(function (result) {
        setFilterEditorOpen(false);
        if (filterEditorPending) {
            setMedia(__assign(__assign({}, filterEditorPending), { uri: result.uri }));
            setFilterId(result.filterId);
            setFilterIntensity(result.filterIntensity);
            setFilterEditorPending(null);
        }
    }, [filterEditorPending]);
    function useGps() {
        return __awaiter(this, void 0, void 0, function () {
            var gps, geo;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        setGpsBusy(true);
                        setError(null);
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, , 4, 5]);
                        return [4 /*yield*/, (0, location_1.getCurrentGps)()];
                    case 2:
                        gps = _a.sent();
                        if (!gps.granted || gps.lat == null || gps.lng == null) {
                            setError('Location unavailable — type one manually below.');
                            return [2 /*return*/];
                        }
                        return [4 /*yield*/, (0, location_1.reverseGeocode)(gps.lat, gps.lng)];
                    case 3:
                        geo = _a.sent();
                        setLoc({ source: 'gps', lat: gps.lat, lng: gps.lng, name: geo.name, city: geo.city, country: geo.country });
                        return [3 /*break*/, 5];
                    case 4:
                        setGpsBusy(false);
                        return [7 /*endfinally*/];
                    case 5: return [2 /*return*/];
                }
            });
        });
    }
    function applyManual() {
        var name = manualText.trim();
        setLoc(name ? { source: 'manual', name: name, city: null, country: null } : { source: 'none' });
    }
    var locLabel = loc.source === 'gps' ? "".concat((_c = (_b = loc.name) !== null && _b !== void 0 ? _b : loc.city) !== null && _c !== void 0 ? _c : 'Current location', " \u00B7 GPS")
        : loc.source === 'manual' ? "".concat(loc.name, " \u00B7 Manual")
            : null;
    function handleSubmit() {
        return __awaiter(this, void 0, void 0, function () {
            var vErr, mediaUrl, mediaType, up, cat, placePrefix, content, locationFields, autoPassport, res, msgs;
            var _a, _b, _c, _d, _e;
            return __generator(this, function (_f) {
                switch (_f.label) {
                    case 0:
                        if (!selectedType || submitting)
                            return [2 /*return*/];
                        setError(null);
                        vErr = validate(selectedType, text, placeName, media);
                        if (vErr) {
                            setError(vErr);
                            return [2 /*return*/];
                        }
                        mediaUrl = null;
                        mediaType = undefined;
                        if (!media) return [3 /*break*/, 5];
                        return [4 /*yield*/, (0, media_1.uploadMedia)(media)];
                    case 1:
                        up = _f.sent();
                        if (!(!up.ok || !up.url)) return [3 /*break*/, 4];
                        if (!(up.errorKind === 'unauthenticated')) return [3 /*break*/, 3];
                        return [4 /*yield*/, signOut()];
                    case 2:
                        _f.sent();
                        expo_router_1.router.replace('/(auth)/sign-in');
                        onClose();
                        return [2 /*return*/];
                    case 3:
                        setError((_a = up.message) !== null && _a !== void 0 ? _a : 'Media upload failed.');
                        return [2 /*return*/];
                    case 4:
                        mediaUrl = up.url;
                        mediaType = (_b = up.mediaType) !== null && _b !== void 0 ? _b : undefined;
                        _f.label = 5;
                    case 5:
                        cat = TYPE_CATEGORY[selectedType];
                        placePrefix = needsPlace(selectedType) && placeName.trim() ? "\uD83D\uDCCD ".concat(placeName.trim(), "\n") : '';
                        content = "[".concat(cat, "] ").concat(placePrefix).concat(text.trim()).trim();
                        locationFields = { locationSource: 'none' };
                        if (loc.source === 'gps') {
                            locationFields = {
                                locationSource: 'gps', locationName: loc.name, locationCity: loc.city,
                                locationCountry: loc.country, locationLat: loc.lat, locationLng: loc.lng,
                                userGpsLat: loc.lat, userGpsLng: loc.lng,
                            };
                        }
                        else if (loc.source === 'manual') {
                            locationFields = { locationSource: 'manual', locationName: loc.name, locationCity: loc.city, locationCountry: loc.country };
                        }
                        autoPassport = selectedType === 'share_postcard';
                        return [4 /*yield*/, create(__assign(__assign(__assign(__assign({ content: content, visibility: vis, mediaUrls: mediaUrl ? [mediaUrl] : [] }, (mediaType ? { mediaType: mediaType } : {})), { addToPassport: autoPassport || addToPassport }), locationFields), { filterId: filterId, filterIntensity: filterIntensity }))];
                    case 6:
                        res = _f.sent();
                        if (res.ok) {
                            onSuccess === null || onSuccess === void 0 ? void 0 : onSuccess();
                            onClose();
                            return [2 /*return*/];
                        }
                        if (!(res.errorKind === 'unauthenticated')) return [3 /*break*/, 8];
                        return [4 /*yield*/, signOut()];
                    case 7:
                        _f.sent();
                        expo_router_1.router.replace('/(auth)/sign-in');
                        onClose();
                        return [2 /*return*/];
                    case 8:
                        msgs = {
                            network_unreachable: 'Network unavailable. Try again.',
                            invalid_payload: 'Check your post and try again.',
                            config_error: 'Posting unavailable right now.',
                        };
                        setError((_e = (_d = msgs[(_c = res.errorKind) !== null && _c !== void 0 ? _c : '']) !== null && _d !== void 0 ? _d : res.message) !== null && _e !== void 0 ? _e : 'Could not post.');
                        return [2 /*return*/];
                }
            });
        });
    }
    // Highlight type: open dedicated composer immediately on type select
    function handleTypeSelect(id) {
        setSelectedType(id);
        setError(null);
        if (DEDICATED_COMPOSERS[id]) {
            setHighlightComposerOpen(true);
        }
    }
    var canSubmit = !!selectedType && !submitting &&
        !DEDICATED_COMPOSERS[selectedType] &&
        validate(selectedType, text, placeName, media) === null;
    return (<react_native_1.Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <react_native_1.KeyboardAvoidingView style={{ flex: 1 }} behavior={react_native_1.Platform.OS === 'ios' ? 'padding' : 'height'}>
        <react_native_1.Pressable style={uc.backdrop} onPress={onClose}/>

        <react_native_1.View style={[uc.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          {/* drag handle + header */}
          <react_native_1.View style={uc.grab}/>
          <react_native_1.View style={uc.head}>
            <react_native_1.Text style={uc.headTitle}>What are you sharing?</react_native_1.Text>
            <react_native_1.Pressable onPress={onClose} hitSlop={8} style={uc.closeBtn}>
              <lucide_react_native_1.X size={18} color={tokens_1.color.ink}/>
            </react_native_1.Pressable>
          </react_native_1.View>

          {/* type grid + form */}
          <react_native_1.ScrollView style={{ flex: 1 }} contentContainerStyle={uc.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            {/* 2-column type grid */}
            <react_native_1.View style={uc.grid}>
              {POST_TYPES.map(function (_a) {
            var id = _a.id, label = _a.label, sub = _a.sub, Icon = _a.icon, iconColor = _a.iconColor;
            var on = selectedType === id;
            return (<react_native_1.Pressable key={id} style={[uc.typeCard, on && uc.typeCardOn]} onPress={function () { return handleTypeSelect(id); }}>
                    <react_native_1.View style={[uc.typeIcon, on && { backgroundColor: iconColor + '20' }]}>
                      <Icon size={16} color={on ? iconColor : tokens_1.color.mute}/>
                    </react_native_1.View>
                    <react_native_1.Text style={[uc.typeLabel, on && { color: tokens_1.color.ink }]} numberOfLines={1}>{label}</react_native_1.Text>
                    <react_native_1.Text style={uc.typeSub} numberOfLines={1}>{sub}</react_native_1.Text>
                  </react_native_1.Pressable>);
        })}
            </react_native_1.View>

            {/* form fields — appear once type is selected */}
            {selectedType && (<react_native_1.View style={uc.form}>
                {/* place name — hidden gem / food spot only */}
                {needsPlace(selectedType) && (<react_native_1.View style={uc.field}>
                    <react_native_1.Text style={uc.fieldLabel}>
                      {selectedType === 'share_food_spot' ? 'Name of spot' : 'Place name'}{' '}
                      <react_native_1.Text style={{ color: tokens_1.color.signal }}>*</react_native_1.Text>
                    </react_native_1.Text>
                    <react_native_1.TextInput style={uc.input} placeholder={selectedType === 'share_food_spot' ? 'e.g. Larsian BBQ' : 'e.g. Tops Lookout'} placeholderTextColor={tokens_1.color.faint} value={placeName} onChangeText={setPlaceName} editable={!submitting}/>
                  </react_native_1.View>)}

                {/* text / description */}
                <react_native_1.View style={uc.field}>
                  <react_native_1.Text style={uc.fieldLabel}>
                    {selectedType === 'ask_question' ? 'Your question' :
                selectedType === 'share_hidden_gem' || selectedType === 'share_food_spot' ? 'Description' :
                    selectedType === 'share_postcard' ? 'Caption (optional)' :
                        'What\'s on your mind?'}
                  </react_native_1.Text>
                  <react_native_1.TextInput style={[uc.input, uc.multiline]} placeholder={selectedType === 'ask_question' ? 'What do you want to know?' :
                selectedType === 'share_hidden_gem' ? 'Why should travelers check this out?' :
                    selectedType === 'share_food_spot' ? 'What makes it worth trying?' :
                        selectedType === 'share_postcard' ? 'Add a caption…' :
                            'Share a tip, story, or update…'} placeholderTextColor={tokens_1.color.faint} multiline value={text} onChangeText={setText} editable={!submitting} textAlignVertical="top"/>
                </react_native_1.View>

                {/* photo picker */}
                <react_native_1.View style={uc.field}>
                  <react_native_1.Text style={uc.fieldLabel}>{photoLabel(selectedType)}</react_native_1.Text>
                  <react_native_1.Pressable style={uc.mediaPicker} onPress={pickMedia} disabled={submitting}>
                    {media ? (<react_native_1.View style={uc.mediaPreviewWrap}>
                        <react_native_1.Image source={{ uri: media.uri }} style={uc.mediaPreview} resizeMode="cover"/>
                        <react_native_1.Pressable style={uc.mediaRemove} onPress={function () { return setMedia(null); }} hitSlop={8}>
                          <lucide_react_native_1.X size={14} color="#fff"/>
                        </react_native_1.Pressable>
                      </react_native_1.View>) : (<react_native_1.View style={uc.mediaEmpty}>
                        <lucide_react_native_1.Camera size={22} color={tokens_1.color.mute}/>
                        <react_native_1.Text style={uc.mediaEmptyText}>Tap to add photo</react_native_1.Text>
                      </react_native_1.View>)}
                  </react_native_1.Pressable>
                </react_native_1.View>

                {/* add to passport toggle — for types that make sense */}
                {selectedType !== 'share_postcard' && (<react_native_1.View style={uc.toggleRow}>
                    <react_native_1.View style={{ flex: 1 }}>
                      <react_native_1.Text style={uc.toggleTitle}>Add to Passport</react_native_1.Text>
                      <react_native_1.Text style={uc.toggleSub}>Creates a postcard on your travel passport.</react_native_1.Text>
                    </react_native_1.View>
                    <react_native_1.Switch value={addToPassport} onValueChange={setAddToPassport} disabled={!media || submitting} trackColor={{ false: tokens_1.color.haze, true: tokens_1.color.signal }}/>
                  </react_native_1.View>)}

                {/* location */}
                <react_native_1.View style={uc.field}>
                  <react_native_1.Text style={uc.fieldLabel}>Location (optional)</react_native_1.Text>
                  <react_native_1.View style={uc.locRow}>
                    <react_native_1.Pressable style={uc.locBtn} onPress={useGps} disabled={gpsBusy || submitting}>
                      {gpsBusy
                ? <react_native_1.ActivityIndicator size="small" color={tokens_1.color.deep}/>
                : <lucide_react_native_1.Navigation size={14} color={tokens_1.color.deep}/>}
                      <react_native_1.Text style={uc.locBtnText}>Use GPS</react_native_1.Text>
                    </react_native_1.Pressable>
                  </react_native_1.View>
                  <react_native_1.View style={uc.manualRow}>
                    <lucide_react_native_1.MapPin size={14} color={tokens_1.color.mute}/>
                    <react_native_1.TextInput style={uc.manualInput} placeholder="Or type a place name" placeholderTextColor={tokens_1.color.faint} value={manualText} onChangeText={setManualText} onBlur={applyManual} onSubmitEditing={applyManual} editable={!submitting}/>
                    {manualText.trim() ? (<react_native_1.Pressable onPress={applyManual} hitSlop={8}><lucide_react_native_1.Check size={16} color={tokens_1.color.success}/></react_native_1.Pressable>) : null}
                  </react_native_1.View>
                  {locLabel && (<react_native_1.Text style={uc.locLabel}>{locLabel}</react_native_1.Text>)}
                </react_native_1.View>

                {/* visibility */}
                <react_native_1.View style={uc.field}>
                  <react_native_1.Text style={uc.fieldLabel}>Visibility</react_native_1.Text>
                  <react_native_1.View style={uc.chipRow}>
                    {['public', 'private'].map(function (v) { return (<react_native_1.Pressable key={v} style={[uc.visChip, vis === v && uc.visChipOn]} onPress={function () { return setVis(v); }}>
                        <react_native_1.Text style={[uc.visChipText, vis === v && uc.visChipTextOn]}>
                          {v.charAt(0).toUpperCase() + v.slice(1)}
                        </react_native_1.Text>
                      </react_native_1.Pressable>); })}
                  </react_native_1.View>
                </react_native_1.View>

                {error && (<react_native_1.View style={uc.errorBox}>
                    <react_native_1.Text style={uc.errorText}>{error}</react_native_1.Text>
                  </react_native_1.View>)}
              </react_native_1.View>)}

            {!selectedType && error && (<react_native_1.View style={[uc.errorBox, { marginTop: tokens_1.space.md }]}>
                <react_native_1.Text style={uc.errorText}>{error}</react_native_1.Text>
              </react_native_1.View>)}
          </react_native_1.ScrollView>

          {/* sticky submit — hidden for dedicated composers */}
          {selectedType && !DEDICATED_COMPOSERS[selectedType] && (<react_native_1.View style={uc.footer}>
              <react_native_1.Pressable style={[uc.submitBtn, !canSubmit && uc.submitBtnDisabled]} onPress={handleSubmit} disabled={!canSubmit}>
                {submitting
                ? <react_native_1.ActivityIndicator size="small" color={tokens_1.color.onInk}/>
                : <react_native_1.Text style={uc.submitText}>{SUBMIT_LABEL[selectedType]}</react_native_1.Text>}
              </react_native_1.Pressable>
            </react_native_1.View>)}
        </react_native_1.View>
      </react_native_1.KeyboardAvoidingView>

      {/* Dedicated Highlight Composer — slides in over the type-picker */}
      <HighlightComposer_1.HighlightComposer visible={highlightComposerOpen} onClose={function () {
            setHighlightComposerOpen(false);
            setSelectedType(null);
        }} onSuccess={function () {
            setHighlightComposerOpen(false);
            onSuccess === null || onSuccess === void 0 ? void 0 : onSuccess();
            onClose();
        }}/>

      {/* Filter editor — opens after media pick, before storing */}
      {filterEditorOpen && filterEditorPending && (<MediaFilterEditor_1.MediaFilterEditor file={{
                uri: filterEditorPending.uri,
                mimeType: (_d = filterEditorPending.mimeType) !== null && _d !== void 0 ? _d : 'image/jpeg',
                width: (_e = filterEditorPending.width) !== null && _e !== void 0 ? _e : null,
                height: (_f = filterEditorPending.height) !== null && _f !== void 0 ? _f : null,
            }} mediaType={((_g = filterEditorPending.mimeType) !== null && _g !== void 0 ? _g : '').startsWith('video/') ? 'video' : 'image'} onApply={handleFilterApply} onCancel={function () {
                setFilterEditorOpen(false);
                setFilterEditorPending(null);
            }}/>)}
    </react_native_1.Modal>);
}
/* ── styles ── */
var fs = react_native_1.StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: 'rgba(17,17,15,0.4)' },
    sheet: __assign({ position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: tokens_1.color.paper, borderTopLeftRadius: tokens_1.radius.lg, borderTopRightRadius: tokens_1.radius.lg, padding: tokens_1.space.lg, paddingBottom: tokens_1.space.xxl, gap: tokens_1.space.md }, tokens_1.shadow.float),
    grab: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: tokens_1.color.haze },
    head: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm },
    title: __assign(__assign({}, tokens_1.type.title), { color: tokens_1.color.ink, fontSize: 19 }),
    clear: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, fontWeight: '700' }),
    x: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: tokens_1.color.paperRaised, borderWidth: 1, borderColor: tokens_1.color.haze },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: tokens_1.space.sm },
    chip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: tokens_1.space.md, paddingVertical: tokens_1.space.sm, borderRadius: tokens_1.radius.pill, borderWidth: 1, borderColor: tokens_1.color.haze, backgroundColor: tokens_1.color.paperRaised },
    chipOn: { backgroundColor: tokens_1.color.signal, borderColor: tokens_1.color.signal },
    chipText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', color: tokens_1.color.ink }),
    chipTextOn: { color: tokens_1.color.onInk },
    apply: { backgroundColor: tokens_1.color.ink, borderRadius: tokens_1.radius.md, paddingVertical: tokens_1.space.md, alignItems: 'center' },
    applyText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.onInk }),
});
var uc = react_native_1.StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: 'rgba(17,17,15,0.45)' },
    sheet: __assign({ backgroundColor: tokens_1.color.paper, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '88%' }, tokens_1.shadow.float),
    grab: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: tokens_1.color.haze, marginTop: 10, marginBottom: 4 },
    head: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: tokens_1.space.lg, paddingVertical: 10 },
    headTitle: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink, flex: 1 }),
    closeBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: tokens_1.color.paperRaised, borderWidth: 1, borderColor: tokens_1.color.haze },
    scroll: { paddingHorizontal: tokens_1.space.lg, paddingBottom: tokens_1.space.lg },
    /* type grid — 2 columns */
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: tokens_1.space.md },
    typeCard: {
        width: '48.5%',
        backgroundColor: tokens_1.color.paperRaised,
        borderRadius: 12,
        borderWidth: 1.5,
        borderColor: tokens_1.color.haze,
        paddingHorizontal: 10,
        paddingVertical: 10,
        gap: 4,
    },
    typeCardOn: { borderColor: tokens_1.color.signal, backgroundColor: tokens_1.color.signal + '08' },
    typeIcon: {
        width: 30,
        height: 30,
        borderRadius: 8,
        backgroundColor: tokens_1.color.haze,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 2,
    },
    typeLabel: __assign(__assign({}, tokens_1.type.bodyStrong), { fontSize: 13, color: tokens_1.color.deep }),
    typeSub: __assign(__assign({}, tokens_1.type.small), { fontSize: 10, color: tokens_1.color.faint, lineHeight: 13 }),
    /* form */
    form: { gap: tokens_1.space.md },
    field: { gap: 6 },
    fieldLabel: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: tokens_1.color.mute, letterSpacing: 0.8, textTransform: 'uppercase' },
    input: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, backgroundColor: tokens_1.color.paperRaised, borderWidth: 1, borderColor: tokens_1.color.haze, borderRadius: tokens_1.radius.md, paddingHorizontal: tokens_1.space.md, paddingVertical: 10 }),
    multiline: { minHeight: 80, textAlignVertical: 'top', paddingTop: 10 },
    /* media */
    mediaPicker: {
        height: 120,
        borderRadius: tokens_1.radius.md,
        borderWidth: 1.5,
        borderStyle: 'dashed',
        borderColor: tokens_1.color.haze,
        backgroundColor: tokens_1.color.paperRaised,
        overflow: 'hidden',
    },
    mediaEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6 },
    mediaEmptyText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    mediaPreviewWrap: { flex: 1 },
    mediaPreview: { width: '100%', height: '100%' },
    mediaRemove: {
        position: 'absolute', top: 6, right: 6,
        width: 24, height: 24, borderRadius: 12,
        backgroundColor: 'rgba(0,0,0,0.6)',
        alignItems: 'center', justifyContent: 'center',
    },
    /* passport toggle */
    toggleRow: {
        flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.md,
        padding: tokens_1.space.md, borderRadius: tokens_1.radius.md,
        backgroundColor: tokens_1.color.paperRaised, borderWidth: 1, borderColor: tokens_1.color.haze,
    },
    toggleTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 13 }),
    toggleSub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, marginTop: 2 }),
    /* location */
    locRow: { flexDirection: 'row', gap: 8 },
    locBtn: {
        flexDirection: 'row', alignItems: 'center', gap: 6,
        paddingHorizontal: 12, paddingVertical: 8,
        borderRadius: tokens_1.radius.pill, borderWidth: 1, borderColor: tokens_1.color.haze, backgroundColor: tokens_1.color.paperRaised,
    },
    locBtnText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', color: tokens_1.color.deep }),
    manualRow: {
        flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6,
        borderWidth: 1, borderColor: tokens_1.color.haze, borderRadius: tokens_1.radius.md,
        paddingHorizontal: 10, paddingVertical: 2, backgroundColor: tokens_1.color.paper,
    },
    manualInput: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, flex: 1, paddingVertical: 8 }),
    locLabel: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.deep, fontWeight: '600', marginTop: 4 }),
    /* visibility */
    chipRow: { flexDirection: 'row', gap: 8 },
    visChip: {
        paddingHorizontal: 14, paddingVertical: 8,
        borderRadius: tokens_1.radius.pill, borderWidth: 1, borderColor: tokens_1.color.haze, backgroundColor: tokens_1.color.paperRaised,
    },
    visChipOn: { backgroundColor: tokens_1.color.ink, borderColor: tokens_1.color.ink },
    visChipText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', color: tokens_1.color.ink }),
    visChipTextOn: { color: tokens_1.color.onInk },
    /* error */
    errorBox: { backgroundColor: '#FEF2F2', borderRadius: tokens_1.radius.md, padding: tokens_1.space.md, borderWidth: 1, borderColor: '#FCA5A5' },
    errorText: __assign(__assign({}, tokens_1.type.small), { color: '#DC2626', fontWeight: '600' }),
    /* footer */
    footer: { paddingHorizontal: tokens_1.space.lg, paddingTop: 12, borderTopWidth: 1, borderTopColor: tokens_1.color.haze },
    submitBtn: {
        backgroundColor: tokens_1.color.signal,
        borderRadius: tokens_1.radius.pill,
        height: 48,
        alignItems: 'center',
        justifyContent: 'center',
    },
    submitBtnDisabled: { opacity: 0.45 },
    submitText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.onInk, fontSize: 15 }),
});
