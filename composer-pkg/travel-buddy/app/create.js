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
exports.default = Create;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var ImagePicker = require("expo-image-picker");
var lucide_react_native_1 = require("lucide-react-native");
var ui_1 = require("../src/components/ui");
var tokens_1 = require("../src/theme/tokens");
var usePosts_1 = require("../src/hooks/usePosts");
var media_1 = require("../src/services/media");
var location_1 = require("../src/services/location");
var CATS = ['hotel', 'food', 'nightlife', 'beach', 'activity', 'transport', 'airport', 'visa', 'safety', 'tip', 'question'];
var VIS_OPTIONS = [
    { label: 'Public', value: 'public' },
    { label: 'Private', value: 'private' },
];
function Create() {
    var _a, _b;
    var _c = (0, react_1.useState)('beach'), cat = _c[0], setCat = _c[1];
    var _d = (0, react_1.useState)('public'), vis = _d[0], setVis = _d[1];
    var _e = (0, react_1.useState)(''), caption = _e[0], setCaption = _e[1];
    var _f = (0, react_1.useState)(null), media = _f[0], setMedia = _f[1];
    var _g = (0, react_1.useState)(true), addToPassport = _g[0], setAddToPassport = _g[1];
    var _h = (0, react_1.useState)({ source: 'none' }), loc = _h[0], setLoc = _h[1];
    var _j = (0, react_1.useState)(''), manualText = _j[0], setManualText = _j[1];
    var _k = (0, react_1.useState)(false), gpsBusy = _k[0], setGpsBusy = _k[1];
    var _l = (0, react_1.useState)(null), error = _l[0], setError = _l[1];
    var _m = (0, usePosts_1.usePostActions)(), create = _m.create, submitting = _m.submitting;
    var hasMedia = !!media;
    var canShare = hasMedia && !submitting; // media REQUIRED before submit
    function pickMedia() {
        return __awaiter(this, void 0, void 0, function () {
            var perm, res, a, picked, v;
            var _a, _b, _c;
            return __generator(this, function (_d) {
                switch (_d.label) {
                    case 0:
                        setError(null);
                        return [4 /*yield*/, ImagePicker.requestMediaLibraryPermissionsAsync()];
                    case 1:
                        perm = _d.sent();
                        if (!perm.granted) {
                            setError('Photo library permission is needed to add media.');
                            return [2 /*return*/];
                        }
                        return [4 /*yield*/, ImagePicker.launchImageLibraryAsync({
                                mediaTypes: ['images'],
                                quality: 0.85,
                            })];
                    case 2:
                        res = _d.sent();
                        if (res.canceled || !((_a = res.assets) === null || _a === void 0 ? void 0 : _a[0]))
                            return [2 /*return*/];
                        a = res.assets[0];
                        picked = {
                            uri: a.uri, mimeType: (_b = a.mimeType) !== null && _b !== void 0 ? _b : 'image/jpeg', fileName: a.fileName,
                            fileSize: (_c = a.fileSize) !== null && _c !== void 0 ? _c : null, width: a.width, height: a.height, type: a.type,
                        };
                        v = (0, media_1.validateMedia)(picked);
                        if (!v.ok) {
                            setError(v.message);
                            return [2 /*return*/];
                        }
                        setMedia(picked);
                        if (!addToPassport)
                            setAddToPassport(true); // default ON once media exists
                        return [2 /*return*/];
                }
            });
        });
    }
    function useCurrentLocation() {
        return __awaiter(this, void 0, void 0, function () {
            var gps, geo;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        setError(null);
                        setGpsBusy(true);
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, , 4, 5]);
                        return [4 /*yield*/, (0, location_1.getCurrentGps)()];
                    case 2:
                        gps = _a.sent();
                        if (!gps.granted || gps.lat == null || gps.lng == null) {
                            setError('Location not available — you can add a location manually instead.');
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
    function applyManualLocation() {
        var name = manualText.trim();
        if (!name) {
            setLoc({ source: 'none' });
            return;
        }
        setLoc({ source: 'manual', name: name, city: null, country: null });
    }
    function onShare() {
        return __awaiter(this, void 0, void 0, function () {
            var up, content, base, locationFields, res, messages;
            var _a, _b, _c, _d;
            return __generator(this, function (_e) {
                switch (_e.label) {
                    case 0:
                        if (!canShare) {
                            if (!hasMedia)
                                setError('Add a photo or video before sharing.');
                            return [2 /*return*/];
                        }
                        setError(null);
                        return [4 /*yield*/, (0, media_1.uploadMedia)(media)];
                    case 1:
                        up = _e.sent();
                        if (!up.ok || !up.url) {
                            setError((_a = up.message) !== null && _a !== void 0 ? _a : 'Media upload failed. Your post was not created.');
                            return [2 /*return*/];
                        }
                        content = "[".concat(cat, "] ").concat(caption.trim()).trim();
                        base = {
                            content: content,
                            visibility: vis,
                            mediaUrls: [up.url],
                            mediaType: up.mediaType,
                            addToPassport: addToPassport,
                        };
                        locationFields = { locationSource: 'none' };
                        if (loc.source === 'gps') {
                            locationFields = {
                                locationSource: 'gps',
                                locationName: loc.name, locationCity: loc.city, locationCountry: loc.country,
                                locationLat: loc.lat, locationLng: loc.lng,
                                userGpsLat: loc.lat, userGpsLng: loc.lng,
                            };
                        }
                        else if (loc.source === 'manual') {
                            locationFields = {
                                locationSource: 'manual',
                                locationName: loc.name, locationCity: loc.city, locationCountry: loc.country,
                            };
                        }
                        return [4 /*yield*/, create(__assign(__assign({}, base), locationFields))];
                    case 2:
                        res = _e.sent();
                        if (res.ok) {
                            expo_router_1.router.back();
                            return [2 /*return*/];
                        }
                        messages = {
                            unauthenticated: 'Please sign in to post.',
                            network_unreachable: 'Network unavailable. Try again.',
                            invalid_payload: 'Please check your post and try again.',
                            config_error: 'Posting is not available right now.',
                            not_member: 'You need to be a member to post here.',
                            forbidden: "You can't post here.",
                        };
                        setError((_d = (_c = messages[(_b = res.errorKind) !== null && _b !== void 0 ? _b : '']) !== null && _c !== void 0 ? _c : res.message) !== null && _d !== void 0 ? _d : 'Could not share your post.');
                        return [2 /*return*/];
                }
            });
        });
    }
    var locLabel = loc.source === 'gps'
        ? "".concat((_b = (_a = loc.name) !== null && _a !== void 0 ? _a : loc.city) !== null && _b !== void 0 ? _b : 'Current location', " \u00B7 GPS")
        : loc.source === 'manual'
            ? "".concat(loc.name, " \u00B7 Manual")
            : null;
    return (<react_native_1.View style={{ flex: 1, backgroundColor: tokens_1.color.paper }}>
      <react_native_1.View style={styles.head}>
        <react_native_1.Pressable onPress={function () { return expo_router_1.router.back(); }} hitSlop={8}><lucide_react_native_1.X size={24} color={tokens_1.color.ink}/></react_native_1.Pressable>
        <react_native_1.Text style={styles.title}>New post</react_native_1.Text>
        <react_native_1.View style={{ flex: 1 }}/>
        <react_native_1.Pressable style={[styles.post, !canShare && styles.postDisabled]} onPress={onShare} disabled={!canShare}>
          {submitting ? <react_native_1.ActivityIndicator size="small" color={tokens_1.color.onInk}/> : <react_native_1.Text style={styles.postText}>Share</react_native_1.Text>}
        </react_native_1.Pressable>
      </react_native_1.View>

      <react_native_1.ScrollView contentContainerStyle={{ padding: tokens_1.space.lg, gap: tokens_1.space.lg }} keyboardShouldPersistTaps="handled">
        {error ? <react_native_1.View style={styles.errorBox}><react_native_1.Text style={styles.errorText}>{error}</react_native_1.Text></react_native_1.View> : null}

        <react_native_1.Pressable style={styles.media} onPress={pickMedia}>
          {media ? (<react_native_1.Image source={{ uri: media.uri }} style={styles.preview} resizeMode="cover"/>) : (<>
              <lucide_react_native_1.Image size={28} color={tokens_1.color.mute}/>
              <react_native_1.Text style={styles.mediaText}>Add photo or video (required)</react_native_1.Text>
            </>)}
        </react_native_1.Pressable>

        <react_native_1.TextInput style={styles.caption} placeholder="Share a tip, review, question, or moment…" placeholderTextColor={tokens_1.color.faint} multiline value={caption} onChangeText={setCaption} editable={!submitting}/>

        <react_native_1.View style={styles.toggleRow}>
          <react_native_1.View style={{ flex: 1 }}>
            <react_native_1.Text style={styles.toggleTitle}>Add this post to my Passport</react_native_1.Text>
            <react_native_1.Text style={styles.toggleSub}>Creates a Passport postcard from this post.</react_native_1.Text>
          </react_native_1.View>
          <react_native_1.Switch value={addToPassport} onValueChange={setAddToPassport} disabled={!hasMedia}/>
        </react_native_1.View>

        <react_native_1.View>
          <react_native_1.Text style={styles.label}>Add location</react_native_1.Text>
          <react_native_1.View style={styles.locRow}>
            <react_native_1.Pressable style={styles.locBtn} onPress={useCurrentLocation} disabled={gpsBusy}>
              {gpsBusy ? <react_native_1.ActivityIndicator size="small" color={tokens_1.color.deep}/> : <lucide_react_native_1.Navigation size={16} color={tokens_1.color.deep}/>}
              <react_native_1.Text style={styles.locBtnText}>Use my current location</react_native_1.Text>
            </react_native_1.Pressable>
          </react_native_1.View>
          <react_native_1.View style={styles.manualRow}>
            <lucide_react_native_1.MapPin size={16} color={tokens_1.color.mute}/>
            <react_native_1.TextInput style={styles.manualInput} placeholder="Or type a place (manual)" placeholderTextColor={tokens_1.color.faint} value={manualText} onChangeText={setManualText} onBlur={applyManualLocation} onSubmitEditing={applyManualLocation} editable={!submitting}/>
            {manualText.trim() ? (<react_native_1.Pressable onPress={applyManualLocation} hitSlop={8}><lucide_react_native_1.Check size={18} color={tokens_1.color.success}/></react_native_1.Pressable>) : null}
          </react_native_1.View>

          {locLabel ? (<react_native_1.View style={styles.locState}>
              <react_native_1.Text style={styles.locStateText}>{locLabel}</react_native_1.Text>
              <react_native_1.Text style={styles.locStateHint}>
                {loc.source === 'gps'
                ? 'May earn a verified stamp if you are near this place.'
                : 'Manual location — not GPS verified.'}
              </react_native_1.Text>
            </react_native_1.View>) : null}
        </react_native_1.View>

        <react_native_1.View>
          <react_native_1.Text style={styles.label}>Category</react_native_1.Text>
          <react_native_1.View style={styles.wrap}>{CATS.map(function (c) { return <ui_1.Chip key={c} label={c} active={c === cat} onPress={function () { return setCat(c); }}/>; })}</react_native_1.View>
        </react_native_1.View>

        <react_native_1.View>
          <react_native_1.Text style={styles.label}>Visibility</react_native_1.Text>
          <react_native_1.View style={styles.wrap}>{VIS_OPTIONS.map(function (v) { return <ui_1.Chip key={v.value} label={v.label} active={v.value === vis} onPress={function () { return setVis(v.value); }}/>; })}</react_native_1.View>
        </react_native_1.View>
      </react_native_1.ScrollView>
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    head: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.md, padding: tokens_1.space.lg, paddingTop: tokens_1.space.xxl, borderBottomWidth: 1, borderBottomColor: tokens_1.color.haze },
    title: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink }),
    post: { backgroundColor: tokens_1.color.signal, paddingHorizontal: tokens_1.space.lg, paddingVertical: tokens_1.space.sm, borderRadius: tokens_1.radius.pill, minWidth: 64, alignItems: 'center' },
    postDisabled: { opacity: 0.5 },
    postText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '800', color: tokens_1.color.onInk }),
    media: { height: 200, borderRadius: tokens_1.radius.lg, borderWidth: 1.5, borderStyle: 'dashed', borderColor: tokens_1.color.haze, alignItems: 'center', justifyContent: 'center', gap: tokens_1.space.sm, backgroundColor: tokens_1.color.paperRaised, overflow: 'hidden' },
    preview: { width: '100%', height: '100%' },
    mediaText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute }),
    caption: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, minHeight: 80, textAlignVertical: 'top' }),
    toggleRow: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.md, padding: tokens_1.space.md, borderRadius: tokens_1.radius.md, backgroundColor: tokens_1.color.paperRaised, borderWidth: 1, borderColor: tokens_1.color.haze },
    toggleTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink }),
    toggleSub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, marginTop: 2 }),
    label: __assign(__assign({}, tokens_1.type.stamp), { fontFamily: 'Courier', color: tokens_1.color.mute, marginBottom: tokens_1.space.sm }),
    wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: tokens_1.space.sm },
    locRow: { flexDirection: 'row', gap: tokens_1.space.sm, marginBottom: tokens_1.space.sm },
    locBtn: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm, paddingHorizontal: tokens_1.space.md, paddingVertical: tokens_1.space.sm, borderRadius: tokens_1.radius.pill, borderWidth: 1, borderColor: tokens_1.color.haze, backgroundColor: tokens_1.color.paperRaised },
    locBtnText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', color: tokens_1.color.deep }),
    manualRow: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm, borderWidth: 1, borderColor: tokens_1.color.haze, borderRadius: tokens_1.radius.md, paddingHorizontal: tokens_1.space.md, paddingVertical: 2, backgroundColor: tokens_1.color.paper },
    manualInput: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, flex: 1, paddingVertical: tokens_1.space.sm }),
    locState: { marginTop: tokens_1.space.sm, padding: tokens_1.space.md, borderRadius: tokens_1.radius.md, backgroundColor: tokens_1.color.paperRaised, borderWidth: 1, borderColor: tokens_1.color.haze },
    locStateText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink }),
    locStateHint: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, marginTop: 2 }),
    errorBox: { backgroundColor: '#FDECEC', borderRadius: tokens_1.radius.md, padding: tokens_1.space.md, borderWidth: 1, borderColor: '#F5B5B5' },
    errorText: __assign(__assign({}, tokens_1.type.small), { color: '#B23B3B', fontWeight: '600' }),
});
