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
exports.default = AiChat;
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var ScreenHeader_1 = require("../../src/components/ScreenHeader");
var ui_1 = require("../../src/components/ui");
var cebu_1 = require("../../src/data/cebu");
var tokens_1 = require("../../src/theme/tokens");
/** Mock assistant: social-first reply shape. Swap for API call later. */
function mockReply(prompt) {
    var rec = {
        id: 'r_' + Date.now(),
        bestPick: 'Base in Mactan, one night downtown',
        why: 'You picked beach + nightlife. Mactan covers beach and diving; Cebu City and IT Park cover the nights.',
        socialProof: 'Maya’s 6am Mactan post and Kojo’s IT Park loop are the most-saved this week.',
        tradeoff: 'Moalboal is stunning but ~3h each way — great as one day trip, not a base.',
        usedPostIds: ['p_1', 'p_2', 'p_5'],
        nextActions: [
            { label: 'Add to trip', kind: 'addTrip' },
            { label: 'Build itinerary', kind: 'buildItinerary' },
            { label: 'Ask community', kind: 'askCommunity' },
        ],
    };
    return { id: 'a_' + Date.now(), role: 'assistant', text: '', recommendation: rec };
}
function AiChat() {
    var _a = (0, react_1.useState)(cebu_1.aiOpening), msgs = _a[0], setMsgs = _a[1];
    var _b = (0, react_1.useState)(''), input = _b[0], setInput = _b[1];
    var scroll = (0, react_1.useRef)(null);
    function send() {
        if (!input.trim())
            return;
        var user = { id: 'u_' + Date.now(), role: 'user', text: input.trim() };
        var reply = mockReply(input.trim());
        setMsgs(function (m) { return __spreadArray(__spreadArray([], m, true), [user, reply], false); });
        setInput('');
        setTimeout(function () { var _a; return (_a = scroll.current) === null || _a === void 0 ? void 0 : _a.scrollToEnd({ animated: true }); }, 80);
    }
    return (<react_native_1.KeyboardAvoidingView style={{ flex: 1, backgroundColor: tokens_1.color.paper }} behavior={react_native_1.Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScreenHeader_1.ScreenHeader title="AI Buddy" back/>
      <react_native_1.ScrollView ref={scroll} contentContainerStyle={{ padding: tokens_1.space.lg, gap: tokens_1.space.md, paddingBottom: tokens_1.space.xl }}>
        {msgs.map(function (m) {
            return m.role === 'user' ? (<react_native_1.View key={m.id} style={styles.userBubble}><react_native_1.Text style={styles.userText}>{m.text}</react_native_1.Text></react_native_1.View>) : m.recommendation ? (<RecCard key={m.id} rec={m.recommendation}/>) : (<react_native_1.View key={m.id} style={styles.aiBubble}>
              <react_native_1.View style={styles.aiHead}><lucide_react_native_1.Sparkles size={15} color={tokens_1.color.signal}/><react_native_1.Text style={styles.aiHeadText}>AI BUDDY</react_native_1.Text></react_native_1.View>
              <react_native_1.Text style={styles.aiText}>{m.text}</react_native_1.Text>
            </react_native_1.View>);
        })}
      </react_native_1.ScrollView>
      <react_native_1.View style={styles.inputBar}>
        <react_native_1.TextInput style={styles.input} placeholder="Ask about Cebu, your saves, or a plan…" placeholderTextColor={tokens_1.color.faint} value={input} onChangeText={setInput} onSubmitEditing={send} returnKeyType="send"/>
        <react_native_1.Pressable style={styles.sendBtn} onPress={send}><lucide_react_native_1.Send size={18} color={tokens_1.color.onInk}/></react_native_1.Pressable>
      </react_native_1.View>
    </react_native_1.KeyboardAvoidingView>);
}
function RecCard(_a) {
    var rec = _a.rec;
    return (<react_native_1.View style={styles.rec}>
      <react_native_1.View style={styles.aiHead}><lucide_react_native_1.Sparkles size={15} color={tokens_1.color.signal}/><react_native_1.Text style={styles.aiHeadText}>BEST PICK</react_native_1.Text></react_native_1.View>
      <react_native_1.Text style={styles.recPick}>{rec.bestPick}</react_native_1.Text>
      <react_native_1.Text style={styles.recLabel}>Why</react_native_1.Text><react_native_1.Text style={styles.recBody}>{rec.why}</react_native_1.Text>
      <react_native_1.Text style={styles.recLabel}>Travelers are saying</react_native_1.Text><react_native_1.Text style={styles.recBody}>{rec.socialProof}</react_native_1.Text>
      {rec.tradeoff && (<><react_native_1.Text style={styles.recLabel}>Tradeoff</react_native_1.Text><react_native_1.Text style={styles.recBody}>{rec.tradeoff}</react_native_1.Text></>)}
      <react_native_1.View style={styles.usedRow}>
        <ui_1.Stamp label={"".concat(rec.usedPostIds.length, " posts used")} tone="deep"/>
      </react_native_1.View>
      <react_native_1.View style={styles.actions}>
        {rec.nextActions.map(function (a) { return (<react_native_1.Pressable key={a.kind} style={styles.actionBtn}><react_native_1.Text style={styles.actionText}>{a.label}</react_native_1.Text></react_native_1.Pressable>); })}
      </react_native_1.View>
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    userBubble: { alignSelf: 'flex-end', maxWidth: '82%', backgroundColor: tokens_1.color.ink, paddingHorizontal: tokens_1.space.lg, paddingVertical: tokens_1.space.md, borderRadius: tokens_1.radius.lg, borderBottomRightRadius: 4 },
    userText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.onInk }),
    aiBubble: { alignSelf: 'flex-start', maxWidth: '90%', backgroundColor: tokens_1.color.paperRaised, padding: tokens_1.space.lg, borderRadius: tokens_1.radius.lg, borderBottomLeftRadius: 4, borderWidth: 1, borderColor: tokens_1.color.haze },
    aiHead: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: tokens_1.space.sm },
    aiHeadText: __assign(__assign({}, tokens_1.type.stamp), { fontFamily: 'Courier', color: tokens_1.color.signal }),
    aiText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink }),
    rec: __assign(__assign({ backgroundColor: tokens_1.color.paperRaised, padding: tokens_1.space.lg, borderRadius: tokens_1.radius.lg, borderWidth: 1, borderColor: tokens_1.color.haze }, tokens_1.shadow.card), { gap: 4 }),
    recPick: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink, marginBottom: tokens_1.space.sm }),
    recLabel: __assign(__assign({}, tokens_1.type.stamp), { fontFamily: 'Courier', color: tokens_1.color.mute, marginTop: tokens_1.space.sm }),
    recBody: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink }),
    usedRow: { flexDirection: 'row', marginTop: tokens_1.space.md },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: tokens_1.space.sm, marginTop: tokens_1.space.md },
    actionBtn: { paddingHorizontal: tokens_1.space.md, paddingVertical: tokens_1.space.sm, borderRadius: tokens_1.radius.pill, backgroundColor: tokens_1.color.ink },
    actionText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', color: tokens_1.color.onInk }),
    inputBar: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm, padding: tokens_1.space.md, borderTopWidth: 1, borderTopColor: tokens_1.color.haze, backgroundColor: tokens_1.color.paper },
    input: __assign(__assign({ flex: 1 }, tokens_1.type.body), { color: tokens_1.color.ink, backgroundColor: tokens_1.color.paperRaised, borderWidth: 1, borderColor: tokens_1.color.haze, borderRadius: tokens_1.radius.pill, paddingHorizontal: tokens_1.space.lg, paddingVertical: tokens_1.space.md }),
    sendBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: tokens_1.color.signal, alignItems: 'center', justifyContent: 'center' },
});
