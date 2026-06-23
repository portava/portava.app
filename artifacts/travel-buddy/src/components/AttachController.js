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
exports.AttachControllerProvider = AttachControllerProvider;
exports.useAttach = useAttach;
var react_1 = require("react");
var react_native_1 = require("react-native");
var react_native_safe_area_context_1 = require("react-native-safe-area-context");
var lucide_react_native_1 = require("lucide-react-native");
var AttachmentStore_1 = require("../context/AttachmentStore");
var attachTargets_1 = require("../data/attachTargets");
var tokens_1 = require("../theme/tokens");
var AttachContext = (0, react_1.createContext)(null);
function AttachControllerProvider(_a) {
    var children = _a.children;
    var insets = (0, react_native_safe_area_context_1.useSafeAreaInsets)();
    var _b = (0, AttachmentStore_1.useAttachments)(), createAttachment = _b.createAttachment, isAttached = _b.isAttached;
    var _c = (0, react_1.useState)(false), open = _c[0], setOpen = _c[1];
    var _d = (0, react_1.useState)(null), source = _d[0], setSource = _d[1];
    var _e = (0, react_1.useState)('trip'), kind = _e[0], setKind = _e[1];
    var _f = (0, react_1.useState)(''), query = _f[0], setQuery = _f[1];
    var _g = (0, react_1.useState)(null), busyId = _g[0], setBusyId = _g[1];
    var _h = (0, react_1.useState)(null), error = _h[0], setError = _h[1];
    // toast
    var _j = (0, react_1.useState)(null), toast = _j[0], setToast = _j[1];
    var toastY = (0, react_1.useRef)(new react_native_1.Animated.Value(80)).current;
    var showToast = (0, react_1.useCallback)(function (msg) {
        setToast(msg);
        react_native_1.Animated.spring(toastY, { toValue: 0, useNativeDriver: true }).start();
        setTimeout(function () {
            react_native_1.Animated.timing(toastY, { toValue: 80, duration: 220, useNativeDriver: true }).start(function () { return setToast(null); });
        }, 2200);
    }, [toastY]);
    var openSheet = (0, react_1.useCallback)(function (src, k) {
        setSource(src);
        setKind(k);
        setQuery('');
        setError(null);
        setOpen(true);
    }, []);
    var targets = kind === 'trip' ? attachTargets_1.attachTripTargets : attachTargets_1.attachPlanTargets;
    var groupLabel = kind === 'trip' ? attachTargets_1.TRIP_GROUP_LABEL : attachTargets_1.PLAN_GROUP_LABEL;
    var filtered = query
        ? targets.filter(function (tg) { return tg.title.toLowerCase().includes(query.toLowerCase()); })
        : targets;
    var groups = Array.from(new Set(filtered.map(function (tg) { return tg.group; })));
    function attachTo(target) {
        return __awaiter(this, void 0, void 0, function () {
            var _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        if (!source)
                            return [2 /*return*/];
                        if (isAttached(source.id, target.id)) {
                            showToast('Already added to ' + target.title);
                            setOpen(false);
                            return [2 /*return*/];
                        }
                        setBusyId(target.id);
                        setError(null);
                        _b.label = 1;
                    case 1:
                        _b.trys.push([1, 3, 4, 5]);
                        return [4 /*yield*/, createAttachment(source, target)];
                    case 2:
                        _b.sent();
                        setOpen(false);
                        showToast("Added to ".concat(target.title));
                        return [3 /*break*/, 5];
                    case 3:
                        _a = _b.sent();
                        setError('Couldn’t add — please try again.');
                        return [3 /*break*/, 5];
                    case 4:
                        setBusyId(null);
                        return [7 /*endfinally*/];
                    case 5: return [2 /*return*/];
                }
            });
        });
    }
    return (<AttachContext.Provider value={{ open: openSheet }}>
      {children}

      <react_native_1.Modal visible={open} transparent animationType="slide" onRequestClose={function () { return setOpen(false); }}>
        <react_native_1.Pressable style={s.backdrop} onPress={function () { return setOpen(false); }}/>
        <react_native_1.View style={[s.sheet, { paddingBottom: insets.bottom + tokens_1.space.lg }]}>
          <react_native_1.View style={s.grab}/>
          <react_native_1.View style={s.head}>
            <react_native_1.Text style={s.title}>{kind === 'trip' ? 'Add to Trip' : 'Add to Plan'}</react_native_1.Text>
            <react_native_1.View style={{ flex: 1 }}/>
            <react_native_1.Pressable onPress={function () { return setOpen(false); }} hitSlop={tokens_1.layout.hitSlop} style={s.x}><lucide_react_native_1.X size={18} color={tokens_1.color.ink}/></react_native_1.Pressable>
          </react_native_1.View>

          {/* item preview */}
          {source ? (<react_native_1.View style={s.preview}>
              <react_native_1.View style={s.previewThumb}/>
              <react_native_1.View style={{ flex: 1 }}>
                <react_native_1.Text style={s.previewTitle} numberOfLines={1}>{source.title}</react_native_1.Text>
                <react_native_1.Text style={s.previewMeta} numberOfLines={1}>
                  {[source.category, source.city].filter(Boolean).join(' · ') || 'Item'}
                </react_native_1.Text>
              </react_native_1.View>
            </react_native_1.View>) : null}

          {/* search */}
          {targets.length > 4 ? (<react_native_1.View style={s.search}>
              <lucide_react_native_1.Search size={16} color={tokens_1.color.faint}/>
              <react_native_1.Text style={s.searchPlaceholder}>{query || "Search ".concat(kind === 'trip' ? 'trips' : 'plans', "\u2026")}</react_native_1.Text>
            </react_native_1.View>) : null}

          {error ? <react_native_1.Text style={s.error}>{error}</react_native_1.Text> : null}

          <react_native_1.ScrollView style={{ maxHeight: 320 }} contentContainerStyle={{ gap: tokens_1.space.sm }}>
            {groups.map(function (grp) {
            var _a;
            return (<react_native_1.View key={grp} style={{ gap: tokens_1.space.xs }}>
                <react_native_1.Text style={s.groupLabel}>{(_a = groupLabel[grp]) !== null && _a !== void 0 ? _a : grp}</react_native_1.Text>
                {filtered.filter(function (tg) { return tg.group === grp; }).map(function (target) {
                    var already = source ? isAttached(source.id, target.id) : false;
                    var busy = busyId === target.id;
                    return (<react_native_1.Pressable key={target.id} style={function (_a) {
                        var pressed = _a.pressed;
                        return [s.row, pressed && { opacity: tokens_1.layout.pressedOpacity }];
                    }} onPress={function () { return attachTo(target); }} disabled={busy}>
                      <react_native_1.View style={s.rowIcon}><lucide_react_native_1.MapPin size={16} color={tokens_1.color.deep}/></react_native_1.View>
                      <react_native_1.View style={{ flex: 1 }}>
                        <react_native_1.Text style={s.rowTitle} numberOfLines={1}>{target.title}</react_native_1.Text>
                        {target.subtitle ? <react_native_1.Text style={s.rowSub} numberOfLines={1}>{target.subtitle}</react_native_1.Text> : null}
                      </react_native_1.View>
                      {busy ? <react_native_1.ActivityIndicator size="small" color={tokens_1.color.signal}/>
                            : already ? <react_native_1.View style={s.added}><lucide_react_native_1.Check size={13} color={tokens_1.color.success}/><react_native_1.Text style={s.addedText}>Added</react_native_1.Text></react_native_1.View>
                                : <lucide_react_native_1.Plus size={18} color={tokens_1.color.signal}/>}
                    </react_native_1.Pressable>);
                })}
              </react_native_1.View>);
        })}

            {/* create new */}
            <react_native_1.Pressable style={function (_a) {
        var pressed = _a.pressed;
        return [s.createRow, pressed && { opacity: tokens_1.layout.pressedOpacity }];
    }} onPress={function () { setOpen(false); /* route to create flow */ }}>
              <react_native_1.View style={s.createIcon}><lucide_react_native_1.Plus size={18} color={tokens_1.color.onInk}/></react_native_1.View>
              <react_native_1.Text style={s.createText}>{kind === 'trip' ? 'Create New Trip' : 'Create New Plan'}</react_native_1.Text>
            </react_native_1.Pressable>
          </react_native_1.ScrollView>
        </react_native_1.View>
      </react_native_1.Modal>

      {/* toast */}
      {toast ? (<react_native_1.Animated.View style={[s.toast, { transform: [{ translateY: toastY }], bottom: insets.bottom + 84 }]} pointerEvents="none">
          <lucide_react_native_1.Check size={16} color={tokens_1.color.onInk}/>
          <react_native_1.Text style={s.toastText}>{toast}</react_native_1.Text>
        </react_native_1.Animated.View>) : null}
    </AttachContext.Provider>);
}
function useAttach() {
    var ctx = (0, react_1.useContext)(AttachContext);
    return ctx !== null && ctx !== void 0 ? ctx : { open: function () { } }; // safe no-op if provider missing
}
var s = react_native_1.StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: 'rgba(17,17,15,0.4)' },
    sheet: __assign({ position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: tokens_1.color.paper, borderTopLeftRadius: tokens_1.radius.lg, borderTopRightRadius: tokens_1.radius.lg, padding: tokens_1.space.lg, gap: tokens_1.space.md }, tokens_1.shadow.float),
    grab: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: tokens_1.color.haze },
    head: { flexDirection: 'row', alignItems: 'center' },
    title: __assign(__assign({}, tokens_1.type.title), { color: tokens_1.color.ink, fontSize: 19 }),
    x: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: tokens_1.color.paperRaised, borderWidth: 1, borderColor: tokens_1.color.haze },
    preview: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.md, backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, padding: tokens_1.space.sm },
    previewThumb: { width: 44, height: 44, borderRadius: tokens_1.radius.sm, backgroundColor: tokens_1.color.deep },
    previewTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink }),
    previewMeta: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
    search: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderColor: tokens_1.color.haze, borderRadius: tokens_1.radius.md, paddingHorizontal: tokens_1.space.md, paddingVertical: tokens_1.space.sm, backgroundColor: tokens_1.color.paperRaised },
    searchPlaceholder: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.faint }),
    error: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, fontWeight: '600' }),
    groupLabel: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: tokens_1.color.mute, letterSpacing: 1, marginTop: tokens_1.space.xs },
    row: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.md, backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, padding: tokens_1.space.md },
    rowIcon: { width: 34, height: 34, borderRadius: 17, backgroundColor: '#E2EDF0', alignItems: 'center', justifyContent: 'center' },
    rowTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 14 }),
    rowSub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
    added: { flexDirection: 'row', alignItems: 'center', gap: 3 },
    addedText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.success, fontWeight: '700', fontSize: 12 }),
    createRow: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.md, padding: tokens_1.space.md, borderRadius: tokens_1.radius.md, borderWidth: 1.5, borderStyle: 'dashed', borderColor: tokens_1.color.signal, marginTop: tokens_1.space.xs },
    createIcon: { width: 34, height: 34, borderRadius: 17, backgroundColor: tokens_1.color.signal, alignItems: 'center', justifyContent: 'center' },
    createText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.signal }),
    toast: __assign({ position: 'absolute', alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: tokens_1.color.ink, paddingHorizontal: tokens_1.space.lg, paddingVertical: tokens_1.space.md, borderRadius: tokens_1.radius.pill }, tokens_1.shadow.float),
    toastText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.onInk }),
});
