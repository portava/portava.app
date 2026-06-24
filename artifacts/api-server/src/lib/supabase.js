"use strict";
var _a, _b;
Object.defineProperty(exports, "__esModule", { value: true });
exports.isServiceClientReady = void 0;
exports._setTestServiceClient = _setTestServiceClient;
exports.getServiceClient = getServiceClient;
var supabase_js_1 = require("@supabase/supabase-js");
var supabaseUrl = (_a = process.env.SUPABASE_URL) !== null && _a !== void 0 ? _a : "";
var serviceRoleKey = (_b = process.env.SUPABASE_SERVICE_ROLE_KEY) !== null && _b !== void 0 ? _b : "";
exports.isServiceClientReady = Boolean(supabaseUrl && serviceRoleKey);
/**
 * Test-only hook — inject a fake service client so admin routes can be tested
 * without real Supabase credentials.  Must only be called from test files.
 */
var _testServiceClient = null;
function _setTestServiceClient(client) {
    _testServiceClient = client;
}
function getServiceClient() {
    if (_testServiceClient)
        return _testServiceClient;
    if (!exports.isServiceClientReady)
        return null;
    return (0, supabase_js_1.createClient)(supabaseUrl, serviceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false },
    });
}
