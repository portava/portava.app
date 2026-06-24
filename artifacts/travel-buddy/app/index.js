"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = Index;
var expo_router_1 = require("expo-router");
var react_native_1 = require("react-native");
var SessionContext_1 = require("../src/context/SessionContext");
var tokens_1 = require("../src/theme/tokens");
/**
 * Entry gate. While we resolve the session: spinner. Then:
 * - Supabase configured + not signed in -> sign-in screen
 * - signed in (or backend not configured -> mock fallback) -> the app
 */
function Index() {
    var _a = (0, SessionContext_1.useSession)(), isAuthed = _a.isAuthed, loading = _a.loading, configured = _a.configured;
    if (configured && loading) {
        return (<react_native_1.View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: tokens_1.color.paper }}>
        <react_native_1.ActivityIndicator color={tokens_1.color.signal}/>
      </react_native_1.View>);
    }
    // If backend isn't configured, fall back to the app on mock data (previous behavior).
    if (configured && !isAuthed) {
        return <expo_router_1.Redirect href="/(auth)/sign-in"/>;
    }
    return <expo_router_1.Redirect href="/(tabs)"/>;
}
