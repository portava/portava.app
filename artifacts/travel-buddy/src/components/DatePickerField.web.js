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
Object.defineProperty(exports, "__esModule", { value: true });
exports.DatePickerField = DatePickerField;
var react_1 = require("react");
var react_native_1 = require("react-native");
var tokens_1 = require("../theme/tokens");
function DatePickerField(_a) {
    var value = _a.value, onChange = _a.onChange, style = _a.style;
    return (<react_native_1.TextInput style={[dp.input, style]} value={value} onChangeText={onChange} placeholder="YYYY-MM-DD" placeholderTextColor={tokens_1.color.faint} keyboardType="numbers-and-punctuation"/>);
}
var dp = react_native_1.StyleSheet.create({
    input: __assign(__assign({ borderWidth: 1, borderColor: tokens_1.color.haze, borderRadius: tokens_1.radius.md, paddingHorizontal: tokens_1.space.md, paddingVertical: tokens_1.space.sm }, tokens_1.type.body), { color: tokens_1.color.ink, backgroundColor: tokens_1.color.paperRaised }),
});
