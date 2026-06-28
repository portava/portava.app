"use strict";
var __rest = (this && this.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.KeyboardAwareScrollViewCompat = KeyboardAwareScrollViewCompat;
var react_native_keyboard_controller_1 = require("react-native-keyboard-controller");
var react_native_1 = require("react-native");
function KeyboardAwareScrollViewCompat(_a) {
    var children = _a.children, _b = _a.keyboardShouldPersistTaps, keyboardShouldPersistTaps = _b === void 0 ? "handled" : _b, props = __rest(_a, ["children", "keyboardShouldPersistTaps"]);
    if (react_native_1.Platform.OS === "web") {
        return (<react_native_1.ScrollView keyboardShouldPersistTaps={keyboardShouldPersistTaps} {...props}>
        {children}
      </react_native_1.ScrollView>);
    }
    return (<react_native_keyboard_controller_1.KeyboardAwareScrollView keyboardShouldPersistTaps={keyboardShouldPersistTaps} {...props}>
      {children}
    </react_native_keyboard_controller_1.KeyboardAwareScrollView>);
}
