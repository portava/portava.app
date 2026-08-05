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
    var _e = (0, react_1.useState)(false), showPassword = _e[0], setShowPassword = _e[1];
    var _f = (0, react_1.useState)(false), busy = _f[0], setBusy = _f[1];
    var _g = (0, react_1.useState)(null), error = _g[0], setError = _g[1];
    var _h = (0, react_1.useState)(null), notice = _h[0], setNotice = _h[1];
    var isForgot = mode === 'forgot-password' || mode === 'forgot-username';
    // already signed in -> go to app
    (0, react_1.useEffect)(function () {
        if (isAuthed)
            expo_router_1.router.replace('/(tabs)');
    }, [isAuthed]);
    function switchMode(next) {
        setMode(next);
        setError(null);
        setNotice(null);
    }
    function submit() {
        return __awaiter(this, void 0, void 0, function () {
            var res, res, e_1, res, _a, e_2;
            var _b, _c;
            return __generator(this, function (_d) {
                switch (_d.label) {
                    case 0:
                        setError(null);
                        setNotice(null);
                        if (!supabase_1.isSupabaseConfigured) {
                            setError('Backend not configured. Add your Supabase keys to .env.');
                            return [2 /*return*/];
                        }
                        if (!email.trim()) {
                            setError(isForgot ? 'Enter your email.' : 'Enter your email and password.');
                            return [2 /*return*/];
                        }
                        if (!isForgot) return [3 /*break*/, 9];
                        setBusy(true);
                        _d.label = 1;
                    case 1:
                        _d.trys.push([1, 6, 7, 8]);
                        if (!(mode === 'forgot-password')) return [3 /*break*/, 3];
                        return [4 /*yield*/, (0, auth_1.requestPasswordReset)(email.trim())];
                    case 2:
                        res = _d.sent();
                        if (res.error) {
                            setError(res.error);
                            return [2 /*return*/];
                        }
                        setNotice('Password reset email sent — check your inbox (and spam folder).');
                        return [3 /*break*/, 5];
                    case 3: return [4 /*yield*/, (0, auth_1.lookupUsernameByEmail)(email.trim())];
                    case 4:
                        res = _d.sent();
                        if (res.error) {
                            setError(res.error);
                            return [2 /*return*/];
                        }
                        setNotice("Your username is @".concat(res.handle, "."));
                        _d.label = 5;
                    case 5: return [3 /*break*/, 8];
                    case 6:
                        e_1 = _d.sent();
                        setError((_b = e_1 === null || e_1 === void 0 ? void 0 : e_1.message) !== null && _b !== void 0 ? _b : 'Something went wrong.');
                        return [3 /*break*/, 8];
                    case 7:
                        setBusy(false);
                        return [7 /*endfinally*/];
                    case 8: return [2 /*return*/];
                    case 9:
                        if (!password) {
                            setError('Enter your email and password.');
                            return [2 /*return*/];
                        }
                        if (mode === 'signup' && password.length < 6) {
                            setError('Password must be at least 6 characters.');
                            return [2 /*return*/];
                        }
                        setBusy(true);
                        _d.label = 10;
                    case 10:
                        _d.trys.push([10, 15, 16, 17]);
                        if (!(mode === 'signin')) return [3 /*break*/, 12];
                        return [4 /*yield*/, (0, auth_1.signIn)(email.trim(), password)];
                    case 11:
                        _a = _d.sent();
                        return [3 /*break*/, 14];
                    case 12: return [4 /*yield*/, (0, auth_1.signUp)(email.trim(), password, { name: name.trim() || email.split('@')[0] })];
                    case 13:
                        _a = _d.sent();
                        _d.label = 14;
                    case 14:
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
                        return [3 /*break*/, 17];
                    case 15:
                        e_2 = _d.sent();
                        setError((_c = e_2 === null || e_2 === void 0 ? void 0 : e_2.message) !== null && _c !== void 0 ? _c : 'Something went wrong.');
                        return [3 /*break*/, 17];
                    case 16:
                        setBusy(false);
                        return [7 /*endfinally*/];
                    case 17: return [2 /*return*/];
                }
            });
        });
    }
    var submitLabel = mode === 'signin' ? 'Sign in'
        : mode === 'signup' ? 'Create account'
            : mode === 'forgot-password' ? 'Send reset link'
                : 'Find my username';
    return (<react_native_1.KeyboardAvoidingView style={{ flex: 1, backgroundColor: tokens_1.color.paper }} behavior={react_native_1.Platform.OS === 'ios' ? 'padding' : undefined}>
      <react_native_1.ScrollView contentContainerStyle={[s.wrap, { paddingTop: insets.top + tokens_1.space.xxxl, paddingBottom: insets.bottom + tokens_1.space.xl }]} keyboardShouldPersistTaps="handled">
        <react_native_1.View style={s.brand}>
          <react_native_1.Image source={require('../../assets/images/portava-icon.png')} style={s.logo} accessibilityLabel="Portava"/>
          <react_native_1.Text style={s.title}>Portava</react_native_1.Text>
          <react_native_1.Text style={s.tagline}>Explore. Connect. Belong.</react_native_1.Text>
        </react_native_1.View>

        <react_native_1.View style={s.card}>
          {!isForgot && (<react_native_1.View style={s.tabs}>
              <react_native_1.Pressable style={[s.tab, mode === 'signin' && s.tabOn]} onPress={function () { return switchMode('signin'); }}>
                <react_native_1.Text style={[s.tabText, mode === 'signin' && s.tabTextOn]}>Sign in</react_native_1.Text>
              </react_native_1.Pressable>
              <react_native_1.Pressable style={[s.tab, mode === 'signup' && s.tabOn]} onPress={function () { return switchMode('signup'); }}>
                <react_native_1.Text style={[s.tabText, mode === 'signup' && s.tabTextOn]}>Create account</react_native_1.Text>
              </react_native_1.Pressable>
            </react_native_1.View>)}

          {isForgot && (<react_native_1.Pressable onPress={function () { return switchMode('signin'); }} style={s.backBtn} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back to sign in">
              <lucide_react_native_1.ArrowLeft size={16} color={tokens_1.color.mute}/>
              <react_native_1.Text style={s.backText}>Back to sign in</react_native_1.Text>
            </react_native_1.Pressable>)}

          {mode === 'signup' ? (<react_native_1.View style={s.field}>
              <lucide_react_native_1.User size={17} color={tokens_1.color.faint}/>
              <react_native_1.TextInput style={s.input} placeholder="Your name" placeholderTextColor={tokens_1.color.faint} value={name} onChangeText={setName} autoCapitalize="words"/>
            </react_native_1.View>) : null}

          <react_native_1.View style={s.field}>
            <lucide_react_native_1.Mail size={17} color={tokens_1.color.faint}/>
            <react_native_1.TextInput style={s.input} placeholder="Email" placeholderTextColor={tokens_1.color.faint} value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email"/>
          </react_native_1.View>

          {!isForgot && (<react_native_1.View style={s.field}>
              <lucide_react_native_1.Lock size={17} color={tokens_1.color.faint}/>
              <react_native_1.TextInput style={s.input} placeholder="Password" placeholderTextColor={tokens_1.color.faint} value={password} onChangeText={setPassword} secureTextEntry={!showPassword} autoCapitalize="none"/>
              <react_native_1.Pressable onPress={function () { return setShowPassword(function (v) { return !v; }); }} hitSlop={8} accessibilityRole="button" accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}>
                {showPassword ? <lucide_react_native_1.EyeOff size={17} color={tokens_1.color.mute}/> : <lucide_react_native_1.Eye size={17} color={tokens_1.color.faint}/>}
              </react_native_1.Pressable>
            </react_native_1.View>)}

          {mode === 'signin' && (<react_native_1.View style={s.forgotRow}>
              <react_native_1.Pressable onPress={function () { return switchMode('forgot-password'); }} hitSlop={6}>
                <react_native_1.Text style={s.forgotLink}>Forgot password?</react_native_1.Text>
              </react_native_1.Pressable>
              <react_native_1.Text style={s.forgotSep}>·</react_native_1.Text>
              <react_native_1.Pressable onPress={function () { return switchMode('forgot-username'); }} hitSlop={6}>
                <react_native_1.Text style={s.forgotLink}>Forgot username?</react_native_1.Text>
              </react_native_1.Pressable>
            </react_native_1.View>)}

          {isForgot && !notice ? (<react_native_1.Text style={s.forgotHint}>
              {mode === 'forgot-password'
                ? "Enter your email and we'll send you a link to set a new password."
                : "Enter the email you signed up with and we'll show you your username."}
            </react_native_1.Text>) : null}

          {error ? <react_native_1.Text style={s.error}>{error}</react_native_1.Text> : null}
          {notice ? <react_native_1.Text style={s.notice}>{notice}</react_native_1.Text> : null}

          <react_native_1.Pressable style={[s.submit, busy ? s.submitBusy : null]} onPress={submit} disabled={busy}>
            {busy ? <react_native_1.ActivityIndicator color={tokens_1.color.onInk}/> : <react_native_1.Text style={s.submitText}>{submitLabel}</react_native_1.Text>}
          </react_native_1.Pressable>

          {!isForgot && (<react_native_1.Text style={s.switchHint} onPress={function () { return switchMode(mode === 'signin' ? 'signup' : 'signin'); }}>
              {mode === 'signin' ? "New here? Create an account" : 'Already have an account? Sign in'}
            </react_native_1.Text>)}
        </react_native_1.View>

        <react_native_1.Text style={s.legal}>By continuing you agree to travel kindly and respect fellow travelers.</react_native_1.Text>
      </react_native_1.ScrollView>
    </react_native_1.KeyboardAvoidingView>);
}
var s = react_native_1.StyleSheet.create({
    wrap: { flexGrow: 1, paddingHorizontal: tokens_1.space.lg, justifyContent: 'center', gap: tokens_1.space.xl },
    brand: { alignItems: 'center', gap: tokens_1.space.sm },
    logo: { width: 76, height: 76, borderRadius: 17 },
    title: __assign(__assign({}, tokens_1.type.hero), { color: tokens_1.color.ink, fontSize: 28 }),
    tagline: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    card: __assign({ backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.lg, borderWidth: 1, borderColor: tokens_1.color.haze, padding: tokens_1.space.lg, gap: tokens_1.space.md }, tokens_1.shadow.card),
    tabs: { flexDirection: 'row', backgroundColor: tokens_1.color.paper, borderRadius: tokens_1.radius.md, padding: 3, marginBottom: tokens_1.space.sm },
    tab: { flex: 1, paddingVertical: tokens_1.space.sm, borderRadius: tokens_1.radius.sm, alignItems: 'center' },
    tabOn: { backgroundColor: tokens_1.color.signal },
    tabText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', color: tokens_1.color.mute }),
    tabTextOn: { color: tokens_1.color.onInk },
    backBtn: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.xs, marginBottom: tokens_1.space.xs },
    backText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontWeight: '600' }),
    field: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm, borderWidth: 1, borderColor: tokens_1.color.haze, borderRadius: tokens_1.radius.md, paddingHorizontal: tokens_1.space.md, backgroundColor: tokens_1.color.paper },
    input: __assign(__assign({ flex: 1, paddingVertical: tokens_1.space.md }, tokens_1.type.body), { color: tokens_1.color.ink }),
    forgotRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: tokens_1.space.sm },
    forgotLink: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.deep, fontWeight: '600' }),
    forgotSep: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.faint }),
    forgotHint: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, textAlign: 'center' }),
    error: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, fontWeight: '600' }),
    notice: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.success, fontWeight: '600' }),
    submit: { backgroundColor: tokens_1.color.ink, borderRadius: tokens_1.radius.md, paddingVertical: tokens_1.space.md, alignItems: 'center', marginTop: tokens_1.space.xs },
    submitBusy: { opacity: 0.7 },
    submitText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.onInk }),
    switchHint: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, fontWeight: '600', textAlign: 'center', marginTop: tokens_1.space.xs }),
    legal: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.faint, fontSize: 11, textAlign: 'center', paddingHorizontal: tokens_1.space.lg }),
});
