"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = Create;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var PulseCreate_1 = require("../src/components/PulseCreate");
/**
 * /create — thin modal wrapper around UnifiedPostComposer.
 * Opened by the center POST stamp button in the tab bar (and the desktop
 * sidebar compose button). Renders the same bottom-sheet composer as the
 * "Post" pill in PulseHeader so all creation entry-points behave identically.
 */
function Create() {
    function dismiss() {
        if (expo_router_1.router.canGoBack()) {
            expo_router_1.router.back();
        }
        else {
            expo_router_1.router.replace('/(tabs)');
        }
    }
    return (<react_native_1.View style={{ flex: 1 }}>
      <PulseCreate_1.UnifiedPostComposer visible onClose={dismiss} onSuccess={dismiss}/>
    </react_native_1.View>);
}
