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
exports.default = SignIn;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var react_native_safe_area_context_1 = require("react-native-safe-area-context");
var lucide_react_native_1 = require("lucide-react-native");
var auth_1 = require("../../src/services/auth");
var SessionContext_1 = require("../../src/context/SessionContext");
var supabase_1 = require("../../src/lib/supabase");
var tokens_1 = require("../../src/theme/tokens");
function SignIn() {
    var insets = (0, react_native_safe_area_context_1.useSafeAreaInsets)();
    var isAuthed = (0, SessionContext_1.useSession)().isAuthed;
    var _a = (0, react_1.useState)('signin'), mode = _a[0], setMode = _a[1];
    var _b = (0, react_1.useState)(''), name = _b[0], setName = _b[1];
    var _c = (0, react_1.useState)(''), email = _c[0], setEmail = _c[1];
    var _d = (0, react_1.useState)(''), password = _d[0], setPassword = _d[1];
    var _e = (0, react_1.useState)(false), busy = _e[0], setBusy = _e[1];
    var _f = (0, react_1.useState)(null), error = _f[0], setError = _f[1];
    var _g = (0, react_1.useState)(null), notice = _g[0], setNotice = _g[1];
    // already signed in -> go to app
    (0, react_1.useEffect)(function () {
        if (isAuthed)
            expo_router_1.router.replace('/(tabs)');
    }, [isAuthed]);
    function submit() {
        return __awaiter(this, void 0, void 0, function () {
            var res, _a, e_1;
            var _b;
            return __generator(this, function (_c) {
                switch (_c.label) {
                    case 0:
                        setError(null);
                        setNotice(null);
                        if (!supabase_1.isSupabaseConfigured) {
                            setError('Backend not configured. Add your Supabase keys to .env.');
                            return [2 /*return*/];
                        }
                        if (!email.trim() || !password) {
                            setError('Enter your email and password.');
                            return [2 /*return*/];
                        }
                        if (mode === 'signup' && password.length < 6) {
                            setError('Password must be at least 6 characters.');
                            return [2 /*return*/];
                        }
                        setBusy(true);
                        _c.label = 1;
                    case 1:
                        _c.trys.push([1, 6, 7, 8]);
                        if (!(mode === 'signin')) return [3 /*break*/, 3];
                        return [4 /*yield*/, (0, auth_1.signIn)(email.trim(), password)];
                    case 2:
                        _a = _c.sent();
                        return [3 /*break*/, 5];
                    case 3: return [4 /*yield*/, (0, auth_1.signUp)(email.trim(), password, { name: name.trim() || email.split('@')[0] })];
                    case 4:
                        _a = _c.sent();
                        _c.label = 5;
                    case 5:
                        res = _a;
                        if (res.error) {
                            setError(res.error);
                            return [2 /*return*/];
                        }
                        if (mode === 'signup' && !res.userId) {
                            setNotice('Check your email to confirm your account, then sign in.');
                            setMode('signin');
                            return [2 /*return*/];
                        }
                        expo_router_1.router.replace('/(tabs)');
                        return [3 /*break*/, 8];
                    case 6:
                        e_1 = _c.sent();
                        setError((_b = e_1 === null || e_1 === void 0 ? void 0 : e_1.message) !== null && _b !== void 0 ? _b : 'Something went wrong.');
                        return [3 /*break*/, 8];
                    case 7:
                        setBusy(false);
                        return [7 /*endfinally*/];
                    case 8: return [2 /*return*/];
                }
            });
        });
    }
    return (<react_native_1.KeyboardAvoidingView style={{ flex: 1, backgroundColor: tokens_1.color.paper }} behavior={react_native_1.Platform.OS === 'ios' ? 'padding' : undefined}>
      <react_native_1.ScrollView contentContainerStyle={[s.wrap, { paddingTop: insets.top + tokens_1.space.xxxl, paddingBottom: insets.bottom + tokens_1.space.xl }]} keyboardShouldPersistTaps="handled">
        <react_native_1.View style={s.brand}>
          <react_native_1.View style={s.logo}><lucide_react_native_1.Plane size={26} color={tokens_1.color.onInk}/></react_native_1.View>
          <react_native_1.Text style={s.title}>Travel Buddy</react_native_1.Text>
          <react_native_1.Text style={s.tagline}>Your social travel passport</react_native_1.Text>
        </react_native_1.View>

        <react_native_1.View style={s.card}>
          <react_native_1.View style={s.tabs}>
            <react_native_1.Pressable style={[s.tab, mode === 'signin' && s.tabOn]} onPress={function () { setMode('signin'); setError(null); }}>
              <react_native_1.Text style={[s.tabText, mode === 'signin' && s.tabTextOn]}>Sign in</react_native_1.Text>
            </react_native_1.Pressable>
            <react_native_1.Pressable style={[s.tab, mode === 'signup' && s.tabOn]} onPress={function () { setMode('signup'); setError(null); }}>
              <react_native_1.Text style={[s.tabText, mode === 'signup' && s.tabTextOn]}>Create account</react_native_1.Text>
            </react_native_1.Pressable>
          </react_native_1.View>

          {mode === 'signup' ? (<react_native_1.View style={s.field}>
              <lucide_react_native_1.User size={17} color={tokens_1.color.faint}/>
              <react_native_1.TextInput style={s.input} placeholder="Your name" placeholderTextColor={tokens_1.color.faint} value={name} onChangeText={setName} autoCapitalize="words"/>
            </react_native_1.View>) : null}

          <react_native_1.View style={s.field}>
            <lucide_react_native_1.Mail size={17} color={tokens_1.color.faint}/>
            <react_native_1.TextInput style={s.input} placeholder="Email" placeholderTextColor={tokens_1.color.faint} value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email"/>
          </react_native_1.View>

          <react_native_1.View style={s.field}>
            <lucide_react_native_1.Lock size={17} color={tokens_1.color.faint}/>
            <react_native_1.TextInput style={s.input} placeholder="Password" placeholderTextColor={tokens_1.color.faint} value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none"/>
          </react_native_1.View>

          {error ? <react_native_1.Text style={s.error}>{error}</react_native_1.Text> : null}
          {notice ? <react_native_1.Text style={s.notice}>{notice}</react_native_1.Text> : null}

          <react_native_1.Pressable style={[s.submit, busy ? s.submitBusy : null]} onPress={submit} disabled={busy}>
            {busy ? <react_native_1.ActivityIndicator color={tokens_1.color.onInk}/> : <react_native_1.Text style={s.submitText}>{mode === 'signin' ? 'Sign in' : 'Create account'}</react_native_1.Text>}
          </react_native_1.Pressable>

          <react_native_1.Text style={s.switchHint} onPress={function () { return setMode(mode === 'signin' ? 'signup' : 'signin'); }}>
            {mode === 'signin' ? "New here? Create an account" : 'Already have an account? Sign in'}
          </react_native_1.Text>
        </react_native_1.View>

        <react_native_1.Text style={s.legal}>By continuing you agree to travel kindly and respect fellow travelers.</react_native_1.Text>
      </react_native_1.ScrollView>
    </react_native_1.KeyboardAvoidingView>);
}
var s = react_native_1.StyleSheet.create({
    wrap: { flexGrow: 1, paddingHorizontal: tokens_1.space.lg, justifyContent: 'center', gap: tokens_1.space.xl },
    brand: { alignItems: 'center', gap: tokens_1.space.sm },
    logo: __assign({ width: 56, height: 56, borderRadius: 28, backgroundColor: tokens_1.color.signal, alignItems: 'center', justifyContent: 'center' }, tokens_1.shadow.float),
    title: __assign(__assign({}, tokens_1.type.hero), { color: tokens_1.color.ink, fontSize: 28 }),
    tagline: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    card: __assign({ backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.lg, borderWidth: 1, borderColor: tokens_1.color.haze, padding: tokens_1.space.lg, gap: tokens_1.space.md }, tokens_1.shadow.card),
    tabs: { flexDirection: 'row', backgroundColor: tokens_1.color.paper, borderRadius: tokens_1.radius.md, padding: 3, marginBottom: tokens_1.space.sm },
    tab: { flex: 1, paddingVertical: tokens_1.space.sm, borderRadius: tokens_1.radius.sm, alignItems: 'center' },
    tabOn: { backgroundColor: tokens_1.color.signal },
    tabText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', color: tokens_1.color.mute }),
    tabTextOn: { color: tokens_1.color.onInk },
    field: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm, borderWidth: 1, borderColor: tokens_1.color.haze, borderRadius: tokens_1.radius.md, paddingHorizontal: tokens_1.space.md, backgroundColor: tokens_1.color.paper },
    input: __assign(__assign({ flex: 1, paddingVertical: tokens_1.space.md }, tokens_1.type.body), { color: tokens_1.color.ink }),
    error: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, fontWeight: '600' }),
    notice: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.success, fontWeight: '600' }),
    submit: { backgroundColor: tokens_1.color.ink, borderRadius: tokens_1.radius.md, paddingVertical: tokens_1.space.md, alignItems: 'center', marginTop: tokens_1.space.xs },
    submitBusy: { opacity: 0.7 },
    submitText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.onInk }),
    switchHint: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, fontWeight: '600', textAlign: 'center', marginTop: tokens_1.space.xs }),
    legal: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.faint, fontSize: 11, textAlign: 'center', paddingHorizontal: tokens_1.space.lg }),
});
