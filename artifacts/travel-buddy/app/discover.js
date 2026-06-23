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
exports.default = DiscoverScreen;
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var ScreenHeader_1 = require("../src/components/ScreenHeader");
var TravelerRow_1 = require("../src/components/TravelerRow");
var follows_1 = require("../src/services/follows");
var tokens_1 = require("../src/theme/tokens");
function DiscoverScreen() {
    var _this = this;
    var _a = (0, react_1.useState)(''), query = _a[0], setQuery = _a[1];
    var _b = (0, react_1.useState)([]), results = _b[0], setResults = _b[1];
    var _c = (0, react_1.useState)(false), loading = _c[0], setLoading = _c[1];
    var _d = (0, react_1.useState)(false), searched = _d[0], setSearched = _d[1];
    var debounceRef = (0, react_1.useRef)(null);
    var inputRef = (0, react_1.useRef)(null);
    var runSearch = (0, react_1.useCallback)(function (q) { return __awaiter(_this, void 0, void 0, function () {
        var res;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (!q.trim()) {
                        setResults([]);
                        setSearched(false);
                        setLoading(false);
                        return [2 /*return*/];
                    }
                    setLoading(true);
                    return [4 /*yield*/, (0, follows_1.searchUsers)(q.trim())];
                case 1:
                    res = _b.sent();
                    setLoading(false);
                    setSearched(true);
                    setResults((_a = res.data) !== null && _a !== void 0 ? _a : []);
                    return [2 /*return*/];
            }
        });
    }); }, []);
    (0, react_1.useEffect)(function () {
        if (debounceRef.current)
            clearTimeout(debounceRef.current);
        if (!query.trim()) {
            setResults([]);
            setSearched(false);
            setLoading(false);
            return;
        }
        setLoading(true);
        debounceRef.current = setTimeout(function () {
            runSearch(query);
        }, 300);
        return function () {
            if (debounceRef.current)
                clearTimeout(debounceRef.current);
        };
    }, [query, runSearch]);
    function handleClear() {
        var _a;
        setQuery('');
        setResults([]);
        setSearched(false);
        (_a = inputRef.current) === null || _a === void 0 ? void 0 : _a.focus();
    }
    var showEmpty = searched && !loading && results.length === 0;
    var showIdle = !searched && !loading && !query.trim();
    return (<react_native_1.View style={styles.root}>
      <ScreenHeader_1.ScreenHeader title="Find Travelers" back/>

      <react_native_1.KeyboardAvoidingView style={{ flex: 1 }} behavior={react_native_1.Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={0}>
        <react_native_1.View style={styles.searchRow}>
          <lucide_react_native_1.Search size={16} color={tokens_1.color.faint} style={styles.searchIcon}/>
          <react_native_1.TextInput ref={inputRef} style={styles.input} placeholder="Search by name or @username" placeholderTextColor={tokens_1.color.faint} value={query} onChangeText={setQuery} autoCapitalize="none" autoCorrect={false} returnKeyType="search" clearButtonMode="never"/>
          {query.length > 0 && (<react_native_1.Pressable onPress={handleClear} style={styles.clearBtn} hitSlop={8}>
              <lucide_react_native_1.X size={15} color={tokens_1.color.mute}/>
            </react_native_1.Pressable>)}
        </react_native_1.View>

        {loading && (<react_native_1.View style={styles.center}>
            <react_native_1.ActivityIndicator color={tokens_1.color.signal}/>
          </react_native_1.View>)}

        {!loading && showIdle && (<react_native_1.View style={styles.center}>
            <react_native_1.Text style={styles.idleIcon}>🌍</react_native_1.Text>
            <react_native_1.Text style={styles.idleTitle}>Find your next travel buddy</react_native_1.Text>
            <react_native_1.Text style={styles.idleSub}>Search by name or @username to discover travelers</react_native_1.Text>
          </react_native_1.View>)}

        {!loading && showEmpty && (<react_native_1.View style={styles.center}>
            <react_native_1.Text style={styles.idleIcon}>🔍</react_native_1.Text>
            <react_native_1.Text style={styles.idleTitle}>No travelers found</react_native_1.Text>
            <react_native_1.Text style={styles.idleSub}>Try a different name or @username</react_native_1.Text>
          </react_native_1.View>)}

        {!loading && results.length > 0 && (<react_native_1.FlatList data={results} keyExtractor={function (item) { return item.id; }} contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled" renderItem={function (_a) {
            var item = _a.item;
            return <TravelerRow_1.TravelerRow user={item}/>;
        }}/>)}
      </react_native_1.KeyboardAvoidingView>
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    root: {
        flex: 1,
        backgroundColor: tokens_1.color.paper,
    },
    searchRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginHorizontal: tokens_1.space.lg,
        marginVertical: tokens_1.space.md,
        backgroundColor: tokens_1.color.paperRaised,
        borderRadius: tokens_1.radius.md,
        borderWidth: 1,
        borderColor: tokens_1.color.haze,
        paddingHorizontal: tokens_1.space.md,
        height: 44,
    },
    searchIcon: {
        marginRight: tokens_1.space.sm,
    },
    input: {
        flex: 1,
        fontSize: 15,
        color: tokens_1.color.ink,
        height: '100%',
    },
    clearBtn: {
        padding: 4,
        marginLeft: tokens_1.space.sm,
    },
    list: {
        padding: tokens_1.space.lg,
        gap: tokens_1.space.sm,
    },
    center: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: tokens_1.space.xl,
        gap: tokens_1.space.sm,
        paddingBottom: 60,
    },
    idleIcon: {
        fontSize: 48,
        marginBottom: tokens_1.space.sm,
    },
    idleTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, textAlign: 'center' }),
    idleSub: {
        fontSize: 13,
        color: tokens_1.color.mute,
        textAlign: 'center',
        lineHeight: 18,
    },
});
