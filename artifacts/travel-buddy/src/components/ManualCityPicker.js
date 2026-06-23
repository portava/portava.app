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
exports.ManualCityPicker = ManualCityPicker;
/**
 * ManualCityPicker — bottom-sheet city selector.
 *
 * Shows a text input + quick-pick list of popular travel cities.
 * Calls setManualCity() from LocationContext on selection.
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../theme/tokens");
var LocationContext_1 = require("../context/LocationContext");
// ── Popular cities ────────────────────────────────────────────────────────────
var POPULAR = [
    { city: 'Bangkok', country: 'Thailand', emoji: '🇹🇭' },
    { city: 'Bali', country: 'Indonesia', emoji: '🇮🇩' },
    { city: 'Tokyo', country: 'Japan', emoji: '🇯🇵' },
    { city: 'Paris', country: 'France', emoji: '🇫🇷' },
    { city: 'Barcelona', country: 'Spain', emoji: '🇪🇸' },
    { city: 'New York', country: 'USA', emoji: '🇺🇸' },
    { city: 'London', country: 'UK', emoji: '🇬🇧' },
    { city: 'Singapore', country: 'Singapore', emoji: '🇸🇬' },
    { city: 'Istanbul', country: 'Turkey', emoji: '🇹🇷' },
    { city: 'Dubai', country: 'UAE', emoji: '🇦🇪' },
    { city: 'Cebu City', country: 'Philippines', emoji: '🇵🇭' },
    { city: 'Ho Chi Minh', country: 'Vietnam', emoji: '🇻🇳' },
    { city: 'Lisbon', country: 'Portugal', emoji: '🇵🇹' },
    { city: 'Mexico City', country: 'Mexico', emoji: '🇲🇽' },
    { city: 'Cape Town', country: 'South Africa', emoji: '🇿🇦' },
    { city: 'Amsterdam', country: 'Netherlands', emoji: '🇳🇱' },
    { city: 'Medellín', country: 'Colombia', emoji: '🇨🇴' },
    { city: 'Kuala Lumpur', country: 'Malaysia', emoji: '🇲🇾' },
];
function ManualCityPicker(_a) {
    var visible = _a.visible, onClose = _a.onClose, onSelect = _a.onSelect;
    var ctx = (0, LocationContext_1.useLocationContext)();
    var isVisible = visible !== null && visible !== void 0 ? visible : ctx.showCityPicker;
    var handleClose = onClose !== null && onClose !== void 0 ? onClose : ctx.closeCityPicker;
    var _b = (0, react_1.useState)(''), query = _b[0], setQuery = _b[1];
    var filtered = (0, react_1.useMemo)(function () {
        if (!query.trim())
            return POPULAR;
        var q = query.toLowerCase();
        return POPULAR.filter(function (c) { return c.city.toLowerCase().includes(q) || c.country.toLowerCase().includes(q); });
    }, [query]);
    function pick(city, country) {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!onSelect) return [3 /*break*/, 1];
                        onSelect(city, country);
                        return [3 /*break*/, 3];
                    case 1: return [4 /*yield*/, ctx.setManualCity(city, country)];
                    case 2:
                        _a.sent();
                        _a.label = 3;
                    case 3:
                        setQuery('');
                        handleClose();
                        return [2 /*return*/];
                }
            });
        });
    }
    function confirmCustom() {
        return __awaiter(this, void 0, void 0, function () {
            var trimmed;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        trimmed = query.trim();
                        if (!trimmed)
                            return [2 /*return*/];
                        return [4 /*yield*/, pick(trimmed, '')];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        });
    }
    return (<react_native_1.Modal visible={isVisible} transparent animationType="slide" onRequestClose={handleClose}>
      <react_native_1.KeyboardAvoidingView style={s.overlay} behavior={react_native_1.Platform.OS === 'ios' ? 'padding' : undefined}>
        <react_native_1.Pressable style={s.backdrop} onPress={handleClose}/>
        <react_native_1.View style={s.sheet}>
          {/* Header */}
          <react_native_1.View style={s.header}>
            <react_native_1.Text style={s.title}>Choose a City</react_native_1.Text>
            <react_native_1.Pressable style={s.closeBtn} onPress={handleClose} hitSlop={12}>
              <lucide_react_native_1.X size={18} color={tokens_1.color.mute}/>
            </react_native_1.Pressable>
          </react_native_1.View>

          {/* Search input */}
          <react_native_1.View style={s.searchRow}>
            <lucide_react_native_1.Search size={16} color={tokens_1.color.mute}/>
            <react_native_1.TextInput style={s.input} value={query} onChangeText={setQuery} placeholder="Search cities…" placeholderTextColor={tokens_1.color.faint} autoCapitalize="words" returnKeyType="done" onSubmitEditing={confirmCustom}/>
            {query.length > 0 && (<react_native_1.Pressable onPress={function () { return setQuery(''); }} hitSlop={8}>
                <lucide_react_native_1.X size={14} color={tokens_1.color.mute}/>
              </react_native_1.Pressable>)}
          </react_native_1.View>

          {/* Custom city confirm row */}
          {query.trim().length > 0 && !filtered.find(function (c) { return c.city.toLowerCase() === query.toLowerCase(); }) && (<react_native_1.Pressable style={s.customRow} onPress={confirmCustom}>
              <lucide_react_native_1.MapPin size={15} color={tokens_1.color.signal}/>
              <react_native_1.Text style={s.customText}>Use "<react_native_1.Text style={{ fontWeight: '700' }}>{query.trim()}</react_native_1.Text>"</react_native_1.Text>
            </react_native_1.Pressable>)}

          {/* City list */}
          <react_native_1.FlatList data={filtered} keyExtractor={function (item) { return item.city; }} style={s.list} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} renderItem={function (_a) {
            var item = _a.item;
            return (<react_native_1.Pressable style={function (_a) {
                var pressed = _a.pressed;
                return [s.row, pressed && s.rowPressed];
            }} onPress={function () { return pick(item.city, item.country); }}>
                <react_native_1.Text style={s.rowEmoji}>{item.emoji}</react_native_1.Text>
                <react_native_1.View style={s.rowText}>
                  <react_native_1.Text style={s.rowCity}>{item.city}</react_native_1.Text>
                  <react_native_1.Text style={s.rowCountry}>{item.country}</react_native_1.Text>
                </react_native_1.View>
                <lucide_react_native_1.MapPin size={14} color={tokens_1.color.faint}/>
              </react_native_1.Pressable>);
        }} ListEmptyComponent={<react_native_1.View style={s.empty}>
                <react_native_1.Text style={s.emptyText}>No matches. Type a city name above.</react_native_1.Text>
              </react_native_1.View>}/>
        </react_native_1.View>
      </react_native_1.KeyboardAvoidingView>
    </react_native_1.Modal>);
}
// ── Styles ────────────────────────────────────────────────────────────────────
var s = react_native_1.StyleSheet.create({
    overlay: {
        flex: 1,
        justifyContent: 'flex-end',
    },
    backdrop: __assign(__assign({}, react_native_1.StyleSheet.absoluteFillObject), { backgroundColor: 'rgba(17,17,15,0.45)' }),
    sheet: {
        backgroundColor: tokens_1.color.paper,
        borderTopLeftRadius: tokens_1.radius.lg,
        borderTopRightRadius: tokens_1.radius.lg,
        maxHeight: '80%',
        paddingBottom: 24,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: tokens_1.space.xl,
        paddingTop: tokens_1.space.lg,
        paddingBottom: tokens_1.space.md,
    },
    title: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink, flex: 1 }),
    closeBtn: {
        padding: tokens_1.space.xs,
    },
    searchRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.sm,
        marginHorizontal: tokens_1.space.xl,
        marginBottom: tokens_1.space.sm,
        backgroundColor: tokens_1.color.paperRaised,
        borderRadius: tokens_1.radius.md,
        paddingHorizontal: tokens_1.space.md,
        height: 44,
    },
    input: __assign(__assign({ flex: 1 }, tokens_1.type.body), { color: tokens_1.color.ink }),
    customRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.sm,
        paddingHorizontal: tokens_1.space.xl,
        paddingVertical: tokens_1.space.sm,
        backgroundColor: '#FFF5F2',
        marginHorizontal: tokens_1.space.xl,
        borderRadius: tokens_1.radius.md,
        marginBottom: tokens_1.space.xs,
    },
    customText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, flex: 1 }),
    list: {
        flex: 1,
        paddingHorizontal: tokens_1.space.xl,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.md,
        paddingVertical: 14,
        borderBottomWidth: react_native_1.StyleSheet.hairlineWidth,
        borderBottomColor: tokens_1.color.haze,
    },
    rowPressed: {
        backgroundColor: tokens_1.color.paperRaised,
    },
    rowEmoji: {
        fontSize: 22,
        width: 30,
        textAlign: 'center',
    },
    rowText: {
        flex: 1,
    },
    rowCity: __assign(__assign({}, tokens_1.type.body), { fontWeight: '600', color: tokens_1.color.ink }),
    rowCountry: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    empty: {
        padding: tokens_1.space.xl,
        alignItems: 'center',
    },
    emptyText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute }),
});
