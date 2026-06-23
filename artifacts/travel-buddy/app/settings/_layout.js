"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = SettingsLayout;
var expo_router_1 = require("expo-router");
function SettingsLayout() {
    return (<expo_router_1.Stack screenOptions={{ headerShown: false }}>
      <expo_router_1.Stack.Screen name="location"/>
    </expo_router_1.Stack>);
}
