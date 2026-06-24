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
exports.SUPPORTED_LANGUAGES = void 0;
exports.default = LanguagePicker;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var lucide_react_native_1 = require("lucide-react-native");
var ScreenHeader_1 = require("../src/components/ScreenHeader");
var tokens_1 = require("../src/theme/tokens");
var LanguagePreferenceContext_1 = require("../src/context/LanguagePreferenceContext");
exports.SUPPORTED_LANGUAGES = [
    { code: 'en', name: 'English' },
    { code: 'es', name: 'Spanish' },
    { code: 'fr', name: 'French' },
    { code: 'de', name: 'German' },
    { code: 'ja', name: 'Japanese' },
    { code: 'ko', name: 'Korean' },
    { code: 'zh', name: 'Chinese (Simplified)' },
    { code: 'pt', name: 'Portuguese' },
    { code: 'it', name: 'Italian' },
    { code: 'ru', name: 'Russian' },
    { code: 'ar', name: 'Arabic' },
    { code: 'th', name: 'Thai' },
    { code: 'vi', name: 'Vietnamese' },
    { code: 'id', name: 'Indonesian' },
    { code: 'tl', name: 'Filipino' },
    { code: 'sv', name: 'Swedish' },
    { code: 'nl', name: 'Dutch' },
    { code: 'pl', name: 'Polish' },
    { code: 'tr', name: 'Turkish' },
    { code: 'hi', name: 'Hindi' },
];
function LanguagePicker() {
    var _this = this;
    var params = (0, expo_router_1.useLocalSearchParams)();
    var _a = (0, LanguagePreferenceContext_1.useLanguagePreference)(), ctxLanguage = _a.preferredLanguage, updateLanguage = _a.updateLanguage;
    var _b = (0, react_1.useState)(params.current || ctxLanguage || null), selected = _b[0], setSelected = _b[1];
    var _c = (0, react_1.useState)(''), query = _c[0], setQuery = _c[1];
    var _d = (0, react_1.useState)(false), saving = _d[0], setSaving = _d[1];
    var filtered = query.trim()
        ? exports.SUPPORTED_LANGUAGES.filter(function (l) {
            return l.name.toLowerCase().includes(query.toLowerCase()) ||
                l.code.toLowerCase().includes(query.toLowerCase());
        })
        : exports.SUPPORTED_LANGUAGES;
    var handleSelect = (0, react_1.useCallback)(function (code) { return __awaiter(_this, void 0, void 0, function () {
        var next, result;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    next = selected === code ? null : code;
                    setSelected(next);
                    setSaving(true);
                    return [4 /*yield*/, updateLanguage(next)];
                case 1:
                    result = _b.sent();
                    setSaving(false);
                    if (!result.ok) {
                        react_native_1.Alert.alert('Error', (_a = result.message) !== null && _a !== void 0 ? _a : 'Failed to save language preference. Please try again.');
                        setSelected(selected);
                        return [2 /*return*/];
                    }
                    expo_router_1.router.back();
                    return [2 /*return*/];
            }
        });
    }); }, [selected, updateLanguage]);
    return (<react_native_1.View style={{ flex: 1, backgroundColor: tokens_1.color.paper }}>
      <ScreenHeader_1.ScreenHeader title="Translation Language" back right={saving ? <react_native_1.ActivityIndicator size="small" color={tokens_1.color.signal}/> : undefined}/>

      <react_native_1.View style={styles.searchWrap}>
        <react_native_1.TextInput style={styles.search} value={query} onChangeText={setQuery} placeholder="Search languages…" placeholderTextColor={tokens_1.color.faint} autoCorrect={false} clearButtonMode="while-editing"/>
      </react_native_1.View>

      <react_native_1.Text style={styles.hint}>
        Incoming messages will be translated into your chosen language. Tap to select, tap again to clear.
      </react_native_1.Text>

      <react_native_1.FlatList data={filtered} keyExtractor={function (item) { return item.code; }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 40 }} renderItem={function (_a) {
            var item = _a.item;
            var active = selected === item.code;
            return (<react_native_1.Pressable style={function (_a) {
                var pressed = _a.pressed;
                return [styles.row, pressed && { opacity: 0.7 }];
            }} onPress={function () { return handleSelect(item.code); }}>
              <react_native_1.View style={{ flex: 1 }}>
                <react_native_1.Text style={[styles.langName, active && styles.langNameActive]}>{item.name}</react_native_1.Text>
                <react_native_1.Text style={styles.langCode}>{item.code}</react_native_1.Text>
              </react_native_1.View>
              {active && <lucide_react_native_1.Check size={18} color={tokens_1.color.deep} strokeWidth={2.5}/>}
            </react_native_1.Pressable>);
        }} ListEmptyComponent={<react_native_1.View style={styles.empty}>
            <react_native_1.Text style={styles.emptyText}>No languages match "{query}"</react_native_1.Text>
          </react_native_1.View>}/>
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    searchWrap: {
        paddingHorizontal: tokens_1.space.lg,
        paddingTop: tokens_1.space.md,
        paddingBottom: tokens_1.space.sm,
    },
    search: __assign(__assign({ backgroundColor: tokens_1.color.paperRaised, borderWidth: 1, borderColor: tokens_1.color.haze, borderRadius: tokens_1.radius.md, paddingHorizontal: tokens_1.space.md, paddingVertical: tokens_1.space.sm }, tokens_1.type.body), { color: tokens_1.color.ink, fontSize: 14 }),
    hint: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 12, lineHeight: 17, paddingHorizontal: tokens_1.space.lg, paddingBottom: tokens_1.space.md }),
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: tokens_1.space.lg,
        paddingVertical: tokens_1.space.md,
        borderBottomWidth: react_native_1.StyleSheet.hairlineWidth,
        borderBottomColor: tokens_1.color.haze,
        gap: tokens_1.space.md,
    },
    langName: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, fontSize: 15 }),
    langNameActive: { color: tokens_1.color.deep, fontWeight: '700' },
    langCode: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11, marginTop: 1 }),
    empty: { alignItems: 'center', paddingTop: 40 },
    emptyText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute }),
});
