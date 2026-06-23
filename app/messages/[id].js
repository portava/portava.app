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
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = Thread;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var lucide_react_native_1 = require("lucide-react-native");
var ScreenHeader_1 = require("../../src/components/ScreenHeader");
var cebu_1 = require("../../src/data/cebu");
var tokens_1 = require("../../src/theme/tokens");
function Thread() {
    var _a;
    var id = (0, expo_router_1.useLocalSearchParams)().id;
    var convo = (_a = cebu_1.conversations.find(function (c) { return c.id === id; })) !== null && _a !== void 0 ? _a : cebu_1.conversations[0];
    var other = convo.participants.find(function (p) { return p.id !== cebu_1.me.id; });
    var _b = (0, react_1.useState)([{ id: 'm1', mine: false, body: convo.lastMessage }]), msgs = _b[0], setMsgs = _b[1];
    var _c = (0, react_1.useState)(''), input = _c[0], setInput = _c[1];
    function send() {
        if (!input.trim())
            return;
        setMsgs(function (m) { return __spreadArray(__spreadArray([], m, true), [{ id: 'm' + Date.now(), mine: true, body: input.trim() }], false); });
        setInput('');
    }
    return (<react_native_1.KeyboardAvoidingView style={{ flex: 1, backgroundColor: tokens_1.color.paper }} behavior={react_native_1.Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScreenHeader_1.ScreenHeader title={other.name} back/>
      <react_native_1.ScrollView contentContainerStyle={{ padding: tokens_1.space.lg, gap: tokens_1.space.sm }}>
        {msgs.map(function (m) { return (<react_native_1.View key={m.id} style={[styles.bubble, m.mine ? styles.mine : styles.theirs]}>
            <react_native_1.Text style={[tokens_1.type.body, { color: m.mine ? tokens_1.color.onInk : tokens_1.color.ink }]}>{m.body}</react_native_1.Text>
          </react_native_1.View>); })}
      </react_native_1.ScrollView>
      <react_native_1.View style={styles.bar}>
        <react_native_1.TextInput style={styles.input} placeholder="Message" placeholderTextColor={tokens_1.color.faint} value={input} onChangeText={setInput} onSubmitEditing={send} returnKeyType="send"/>
        <react_native_1.Pressable style={styles.send} onPress={send}><lucide_react_native_1.Send size={18} color={tokens_1.color.onInk}/></react_native_1.Pressable>
      </react_native_1.View>
    </react_native_1.KeyboardAvoidingView>);
}
var styles = react_native_1.StyleSheet.create({
    bubble: { maxWidth: '80%', paddingHorizontal: tokens_1.space.lg, paddingVertical: tokens_1.space.md, borderRadius: tokens_1.radius.lg },
    mine: { alignSelf: 'flex-end', backgroundColor: tokens_1.color.ink, borderBottomRightRadius: 4 },
    theirs: { alignSelf: 'flex-start', backgroundColor: tokens_1.color.paperRaised, borderWidth: 1, borderColor: tokens_1.color.haze, borderBottomLeftRadius: 4 },
    bar: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm, padding: tokens_1.space.md, borderTopWidth: 1, borderTopColor: tokens_1.color.haze },
    input: __assign(__assign({ flex: 1 }, tokens_1.type.body), { color: tokens_1.color.ink, backgroundColor: tokens_1.color.paperRaised, borderWidth: 1, borderColor: tokens_1.color.haze, borderRadius: tokens_1.radius.pill, paddingHorizontal: tokens_1.space.lg, paddingVertical: tokens_1.space.md }),
    send: { width: 44, height: 44, borderRadius: 22, backgroundColor: tokens_1.color.signal, alignItems: 'center', justifyContent: 'center' },
});
