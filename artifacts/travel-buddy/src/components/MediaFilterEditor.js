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
exports.MediaFilterEditor = MediaFilterEditor;
/**
 * MediaFilterEditor — full-screen filter editor for photos and videos.
 *
 * Props:
 *   file         — { uri, mimeType, width?, height? }
 *   mediaType    — 'image' | 'video'
 *   initialFilterId   — pre-selected filter (default 'original')
 *   initialIntensity  — pre-set intensity 0–100 (default from filter preset)
 *   onApply      — called with { uri, filterId, filterIntensity, mimeType }
 *   onCancel     — close without applying
 *
 * Photos: tapping Apply resizes via renderFilteredImage and returns the new URI.
 * Videos: tapping Apply returns the original URI + filter metadata (CSS-only).
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var slider_1 = require("@react-native-community/slider");
var lucide_react_native_1 = require("lucide-react-native");
var react_native_safe_area_context_1 = require("react-native-safe-area-context");
var tokens_1 = require("../theme/tokens");
var filters_1 = require("../lib/media/filters");
var renderFilteredImage_1 = require("../lib/media/renderFilteredImage");
var SCREEN_W = react_native_1.Dimensions.get('window').width;
function MediaFilterEditor(_a) {
    var _this = this;
    var file = _a.file, mediaType = _a.mediaType, _b = _a.initialFilterId, initialFilterId = _b === void 0 ? 'original' : _b, initialIntensity = _a.initialIntensity, onApply = _a.onApply, onCancel = _a.onCancel;
    var insets = (0, react_native_safe_area_context_1.useSafeAreaInsets)();
    var initialFilter = (0, filters_1.getMediaFilter)(initialFilterId);
    var _c = (0, react_1.useState)(initialFilter.id), selectedId = _c[0], setSelectedId = _c[1];
    var _d = (0, react_1.useState)(initialIntensity !== null && initialIntensity !== void 0 ? initialIntensity : initialFilter.defaultIntensity), intensity = _d[0], setIntensity = _d[1];
    var _e = (0, react_1.useState)(false), applying = _e[0], setApplying = _e[1];
    var _f = (0, react_1.useState)(null), applyError = _f[0], setApplyError = _f[1];
    var currentFilter = (0, filters_1.getMediaFilter)(selectedId);
    var cssFilter = (0, filters_1.buildCssFilter)(currentFilter, intensity);
    function handleFilterSelect(id) {
        setSelectedId(id);
        setApplyError(null);
        var f = (0, filters_1.getMediaFilter)(id);
        setIntensity(f.defaultIntensity);
    }
    function handleReset() {
        setSelectedId('original');
        setIntensity(100);
        setApplyError(null);
    }
    var handleApply = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var result, e_1;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (applying)
                        return [2 /*return*/];
                    setApplyError(null);
                    setApplying(true);
                    _b.label = 1;
                case 1:
                    _b.trys.push([1, 3, 4, 5]);
                    if (mediaType === 'video') {
                        onApply({
                            uri: file.uri,
                            filterId: selectedId,
                            filterIntensity: intensity,
                            mimeType: (_a = file.mimeType) !== null && _a !== void 0 ? _a : 'video/mp4',
                            processed: false,
                        });
                        return [2 /*return*/];
                    }
                    return [4 /*yield*/, (0, renderFilteredImage_1.renderFilteredImage)({
                            uri: file.uri,
                            filterId: selectedId,
                            intensity: intensity,
                        })];
                case 2:
                    result = _b.sent();
                    onApply({
                        uri: result.uri,
                        filterId: result.filterId,
                        filterIntensity: result.filterIntensity,
                        mimeType: result.mimeType,
                        processed: true,
                    });
                    return [3 /*break*/, 5];
                case 3:
                    e_1 = _b.sent();
                    setApplyError(e_1 instanceof Error ? e_1.message : 'Filter failed. You can post as Original.');
                    return [3 /*break*/, 5];
                case 4:
                    setApplying(false);
                    return [7 /*endfinally*/];
                case 5: return [2 /*return*/];
            }
        });
    }); }, [applying, mediaType, file, selectedId, intensity, onApply]);
    function handleApplyAsOriginal() {
        var _a;
        setApplyError(null);
        onApply({
            uri: file.uri,
            filterId: 'original',
            filterIntensity: 100,
            mimeType: (_a = file.mimeType) !== null && _a !== void 0 ? _a : 'image/jpeg',
            processed: false,
        });
    }
    var isOriginal = selectedId === 'original';
    return (<react_native_1.Modal visible animationType="slide" statusBarTranslucent onRequestClose={onCancel}>
      <react_native_1.View style={[s.container, { paddingTop: insets.top }]}>
        {/* Header */}
        <react_native_1.View style={s.header}>
          <react_native_1.Pressable style={s.headerBtn} onPress={onCancel} hitSlop={8}>
            <lucide_react_native_1.X size={20} color={tokens_1.color.onInk}/>
          </react_native_1.Pressable>
          <react_native_1.Text style={s.headerTitle}>Filters</react_native_1.Text>
          <react_native_1.Pressable style={[s.applyBtn, applying && s.applyBtnDisabled]} onPress={handleApply} disabled={applying}>
            {applying
            ? <react_native_1.ActivityIndicator size="small" color="#fff"/>
            : <><lucide_react_native_1.Check size={15} color="#fff"/><react_native_1.Text style={s.applyBtnText}>Apply</react_native_1.Text></>}
          </react_native_1.Pressable>
        </react_native_1.View>

        {/* Preview */}
        <react_native_1.View style={s.preview}>
          <react_native_1.Image source={{ uri: file.uri }} style={[
            react_native_1.StyleSheet.absoluteFill,
            cssFilter !== 'none' && react_native_1.Platform.OS === 'web'
                ? { filter: cssFilter }
                : undefined,
        ]} resizeMode="contain"/>
          {/* Native: CSS filter overlay using opacity-blended tinted view */}
          {cssFilter !== 'none' && react_native_1.Platform.OS !== 'web' && (<react_native_1.View style={s.nativeFilterOverlay} pointerEvents="none">
              <FilterOverlayNative filterId={selectedId} intensity={intensity}/>
            </react_native_1.View>)}
          {mediaType === 'video' && (<react_native_1.View style={s.videoTag} pointerEvents="none">
              <lucide_react_native_1.PlayCircle size={28} color="rgba(255,255,255,0.85)"/>
              <react_native_1.Text style={s.videoTagText}>Video filter preview</react_native_1.Text>
            </react_native_1.View>)}
          {applying && (<react_native_1.View style={s.bakingOverlay} pointerEvents="none">
              <react_native_1.ActivityIndicator size="large" color="#fff"/>
              <react_native_1.Text style={s.bakingText}>Applying filter…</react_native_1.Text>
            </react_native_1.View>)}
        </react_native_1.View>

        {/* Error banner */}
        {applyError && (<react_native_1.View style={s.errorRow}>
            <react_native_1.Text style={s.errorText} numberOfLines={2}>{applyError}</react_native_1.Text>
            <react_native_1.Pressable onPress={handleApplyAsOriginal}>
              <react_native_1.Text style={s.errorAction}>Post as Original</react_native_1.Text>
            </react_native_1.Pressable>
          </react_native_1.View>)}

        {/* Intensity slider */}
        <react_native_1.View style={s.sliderRow}>
          <react_native_1.Text style={s.sliderLabel}>Intensity</react_native_1.Text>
          <slider_1.default style={s.slider} minimumValue={0} maximumValue={100} step={1} value={intensity} onValueChange={setIntensity} minimumTrackTintColor={tokens_1.color.signal} maximumTrackTintColor={tokens_1.color.haze} thumbTintColor={tokens_1.color.onInk} disabled={isOriginal}/>
          <react_native_1.Text style={s.sliderValue}>{Math.round(intensity)}</react_native_1.Text>
        </react_native_1.View>

        {/* Filter carousel */}
        <react_native_1.View style={s.carouselWrap}>
          <react_native_1.ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.carousel}>
            {filters_1.mediaFilters.map(function (f) {
            var isSelected = f.id === selectedId;
            return (<react_native_1.Pressable key={f.id} style={[s.filterItem, isSelected && s.filterItemSelected]} onPress={function () { return handleFilterSelect(f.id); }}>
                  {/* Thumbnail with filter preview */}
                  <react_native_1.View style={s.thumb}>
                    <react_native_1.Image source={{ uri: file.uri }} style={[
                    s.thumbImage,
                    f.id !== 'original' && react_native_1.Platform.OS === 'web'
                        ? { filter: (0, filters_1.buildCssFilter)(f, f.defaultIntensity) }
                        : undefined,
                ]} resizeMode="cover"/>
                    {f.id !== 'original' && react_native_1.Platform.OS !== 'web' && (<react_native_1.View style={react_native_1.StyleSheet.absoluteFill} pointerEvents="none">
                        <FilterOverlayNative filterId={f.id} intensity={f.defaultIntensity}/>
                      </react_native_1.View>)}
                    {isSelected && (<react_native_1.View style={s.thumbSelected} pointerEvents="none">
                        <lucide_react_native_1.Check size={16} color="#fff"/>
                      </react_native_1.View>)}
                  </react_native_1.View>
                  <react_native_1.Text style={[s.filterName, isSelected && s.filterNameSelected]} numberOfLines={1}>
                    {f.name}
                  </react_native_1.Text>
                </react_native_1.Pressable>);
        })}
          </react_native_1.ScrollView>
        </react_native_1.View>

        {/* Reset button */}
        <react_native_1.View style={[s.footer, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          <react_native_1.Pressable style={[s.resetBtn, isOriginal && s.resetBtnDisabled]} onPress={handleReset} disabled={isOriginal}>
            <lucide_react_native_1.RotateCcw size={14} color={isOriginal ? tokens_1.color.faint : tokens_1.color.ink}/>
            <react_native_1.Text style={[s.resetText, isOriginal && s.resetTextDisabled]}>Reset to Original</react_native_1.Text>
          </react_native_1.Pressable>
        </react_native_1.View>
      </react_native_1.View>
    </react_native_1.Modal>);
}
/**
 * Native-platform filter overlay. Approximates CSS filter effects using a
 * semi-transparent tinted overlay. Not pixel-perfect but gives a visible
 * preview of the filter direction without requiring canvas or extra packages.
 */
function FilterOverlayNative(_a) {
    var _b;
    var filterId = _a.filterId, intensity = _a.intensity;
    var filter = (0, filters_1.getMediaFilter)(filterId);
    if (filter.id === 'original')
        return null;
    var t = Math.max(0, Math.min(100, intensity)) / 100;
    var OVERLAY_COLORS = {
        wanderlust: "rgba(255,180,80,".concat((0.18 * t).toFixed(2), ")"),
        golden_hour: "rgba(255,160,40,".concat((0.25 * t).toFixed(2), ")"),
        deep_ocean: "rgba(30,100,200,".concat((0.22 * t).toFixed(2), ")"),
        mist: "rgba(220,215,205,".concat((0.3 * t).toFixed(2), ")"),
        polaroid: "rgba(255,240,200,".concat((0.12 * t).toFixed(2), ")"),
        noir: "rgba(0,0,0,".concat((0.0 * t).toFixed(2), ")"),
        safari: "rgba(180,140,60,".concat((0.2 * t).toFixed(2), ")"),
        vivid: "rgba(255,60,100,".concat((0.1 * t).toFixed(2), ")"),
        sunset: "rgba(255,100,30,".concat((0.22 * t).toFixed(2), ")"),
        arctic: "rgba(180,220,255,".concat((0.2 * t).toFixed(2), ")"),
        velvet: "rgba(30,0,40,".concat((0.3 * t).toFixed(2), ")"),
    };
    var overlayColor = (_b = OVERLAY_COLORS[filterId]) !== null && _b !== void 0 ? _b : "rgba(0,0,0,0)";
    return (<react_native_1.View style={[react_native_1.StyleSheet.absoluteFill, { backgroundColor: overlayColor }]} pointerEvents="none"/>);
}
var PREVIEW_H = SCREEN_W * 0.72;
var s = react_native_1.StyleSheet.create({
    container: { flex: 1, backgroundColor: '#0B0B0A' },
    header: {
        flexDirection: 'row', alignItems: 'center',
        paddingHorizontal: tokens_1.space.lg, paddingVertical: 10, gap: tokens_1.space.md,
    },
    headerBtn: {
        width: 36, height: 36, borderRadius: 18,
        alignItems: 'center', justifyContent: 'center',
        backgroundColor: 'rgba(255,255,255,0.12)',
    },
    headerTitle: __assign(__assign({}, tokens_1.type.heading), { color: '#fff', flex: 1, textAlign: 'center' }),
    applyBtn: {
        flexDirection: 'row', alignItems: 'center', gap: 5,
        backgroundColor: tokens_1.color.signal, borderRadius: tokens_1.radius.pill,
        paddingHorizontal: tokens_1.space.md, paddingVertical: 8,
    },
    applyBtnDisabled: { opacity: 0.5 },
    applyBtnText: __assign(__assign({}, tokens_1.type.small), { color: '#fff', fontWeight: '700' }),
    preview: {
        width: '100%', height: PREVIEW_H,
        backgroundColor: '#000',
        overflow: 'hidden',
    },
    nativeFilterOverlay: __assign({}, react_native_1.StyleSheet.absoluteFillObject),
    videoTag: {
        position: 'absolute', bottom: tokens_1.space.lg, left: 0, right: 0,
        alignItems: 'center', gap: 6,
    },
    videoTagText: {
        color: 'rgba(255,255,255,0.85)', fontSize: 12, fontWeight: '700',
        backgroundColor: 'rgba(0,0,0,0.45)', paddingHorizontal: 10, paddingVertical: 3,
        borderRadius: tokens_1.radius.sm,
    },
    bakingOverlay: __assign(__assign({}, react_native_1.StyleSheet.absoluteFillObject), { backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center', gap: tokens_1.space.sm }),
    bakingText: { color: '#fff', fontWeight: '600', fontSize: 14 },
    errorRow: {
        backgroundColor: '#3D0F0A', paddingHorizontal: tokens_1.space.lg, paddingVertical: 10,
        flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm,
    },
    errorText: __assign(__assign({}, tokens_1.type.small), { color: '#FF9B85', flex: 1 }),
    errorAction: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, fontWeight: '700', textDecorationLine: 'underline' }),
    sliderRow: {
        flexDirection: 'row', alignItems: 'center',
        paddingHorizontal: tokens_1.space.lg, paddingVertical: 8, gap: tokens_1.space.sm,
    },
    sliderLabel: __assign(__assign({}, tokens_1.type.small), { color: 'rgba(255,255,255,0.6)', width: 60 }),
    slider: { flex: 1 },
    sliderValue: __assign(__assign({}, tokens_1.type.small), { color: 'rgba(255,255,255,0.7)', width: 28, textAlign: 'right', fontFamily: 'Courier', fontSize: 12 }),
    carouselWrap: { paddingTop: 4 },
    carousel: { paddingHorizontal: tokens_1.space.lg, gap: tokens_1.space.sm, paddingBottom: 4 },
    filterItem: {
        alignItems: 'center', gap: 5,
        borderRadius: tokens_1.radius.sm,
        padding: 4,
        borderWidth: 2, borderColor: 'transparent',
    },
    filterItemSelected: { borderColor: tokens_1.color.signal },
    thumb: {
        width: 68, height: 68,
        borderRadius: tokens_1.radius.sm,
        overflow: 'hidden',
        backgroundColor: '#222',
    },
    thumbImage: { width: '100%', height: '100%' },
    thumbSelected: __assign(__assign({}, react_native_1.StyleSheet.absoluteFillObject), { backgroundColor: 'rgba(255,77,46,0.35)', alignItems: 'center', justifyContent: 'center' }),
    filterName: __assign(__assign({}, tokens_1.type.small), { color: 'rgba(255,255,255,0.6)', fontSize: 10, width: 68, textAlign: 'center' }),
    filterNameSelected: { color: tokens_1.color.signal, fontWeight: '700' },
    footer: {
        paddingHorizontal: tokens_1.space.lg, paddingTop: tokens_1.space.sm, alignItems: 'center',
        borderTopWidth: react_native_1.StyleSheet.hairlineWidth, borderTopColor: 'rgba(255,255,255,0.1)',
    },
    resetBtn: {
        flexDirection: 'row', alignItems: 'center', gap: 6,
        paddingHorizontal: tokens_1.space.lg, paddingVertical: 10,
        borderRadius: tokens_1.radius.pill, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
    },
    resetBtnDisabled: { borderColor: 'rgba(255,255,255,0.08)' },
    resetText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.onInk, fontWeight: '700' }),
    resetTextDisabled: { color: tokens_1.color.faint },
});
