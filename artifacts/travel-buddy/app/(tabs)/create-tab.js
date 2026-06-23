"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = CreateTab;
var expo_router_1 = require("expo-router");
// Placeholder route for the center stamp button. The tab press is intercepted
// in _layout to open the /create modal, so this only renders if reached directly.
function CreateTab() {
    return <expo_router_1.Redirect href="/create"/>;
}
