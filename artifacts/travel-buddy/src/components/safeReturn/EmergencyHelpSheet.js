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
exports.EmergencyHelpSheet = EmergencyHelpSheet;
/**
 * EmergencyHelpSheet
 *
 * A calm bottom sheet with emergency options.
 * IMPORTANT: No action is automatic. Every action requires an explicit tap.
 * The app never auto-dials or auto-contacts anyone.
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../../theme/tokens");
var EMERGENCY_OPTIONS = [
    {
        id: 'call_emergency',
        icon: lucide_react_native_1.Phone,
        label: 'Call local emergency number',
        sub: 'Opens your dialer — you make the call.',
        color: tokens_1.color.signal,
        bg: '#FFF0EE',
    },
    {
        id: 'message_tc',
        icon: lucide_react_native_1.MessageCircle,
        label: 'Message Trusted Circle',
        sub: 'Send a message to your selected contacts.',
        color: tokens_1.color.deep,
        bg: '#EAF2F4',
    },
    {
        id: 'share_location',
        icon: lucide_react_native_1.MapPin,
        label: 'Share your location',
        sub: 'Opens Maps so you can send your pin.',
        color: '#7A4DBF',
        bg: '#F0EBF9',
    },
    {
        id: 'rideshare',
        icon: lucide_react_native_1.Car,
        label: 'Open Maps / Rideshare',
        sub: 'Find a safe route home.',
        color: '#2D7D46',
        bg: '#E6F4EA',
    },
    {
        id: 'contact_host',
        icon: lucide_react_native_1.Users,
        label: 'Contact trip host',
        sub: 'Message your trip host.',
        color: '#8B6914',
        bg: '#FBF5E6',
    },
    {
        id: 'contact_crew',
        icon: lucide_react_native_1.Users,
        label: 'Contact trip crew',
        sub: 'Reach out to your fellow travellers.',
        color: '#1A6B5C',
        bg: '#E4F2EF',
    },
];
function EmergencyHelpSheet(_a) {
    var visible = _a.visible, onClose = _a.onClose, onMessageTrustedCircle = _a.onMessageTrustedCircle, onContactHost = _a.onContactHost, onContactTripCrew = _a.onContactTripCrew;
    function handleOption(id) {
        switch (id) {
            case 'call_emergency':
                // Opens the dialer — user must tap to call. Never auto-dials.
                react_native_1.Linking.openURL('tel:112').catch(function () { });
                break;
            case 'message_tc':
                onMessageTrustedCircle === null || onMessageTrustedCircle === void 0 ? void 0 : onMessageTrustedCircle();
                break;
            case 'share_location':
                react_native_1.Linking.openURL('https://maps.google.com').catch(function () { });
                break;
            case 'rideshare':
                react_native_1.Linking.openURL('https://maps.google.com').catch(function () { });
                break;
            case 'contact_host':
                onContactHost === null || onContactHost === void 0 ? void 0 : onContactHost();
                break;
            case 'contact_crew':
                onContactTripCrew === null || onContactTripCrew === void 0 ? void 0 : onContactTripCrew();
                break;
        }
    }
    return (<react_native_1.Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <react_native_1.View style={styles.overlay}>
        <react_native_1.View style={styles.sheet}>
          <react_native_1.View style={styles.header}>
            <react_native_1.View style={styles.headerLeft}>
              <lucide_react_native_1.Shield size={20} color={tokens_1.color.signal}/>
              <react_native_1.Text style={styles.title}>Emergency Help</react_native_1.Text>
            </react_native_1.View>
            <react_native_1.Pressable onPress={onClose} hitSlop={12}><lucide_react_native_1.X size={22} color={tokens_1.color.mute}/></react_native_1.Pressable>
          </react_native_1.View>

          <react_native_1.Text style={styles.sub}>
            You're in control. Nothing happens automatically — every action below requires your tap.
          </react_native_1.Text>

          <react_native_1.ScrollView showsVerticalScrollIndicator={false}>
            {EMERGENCY_OPTIONS.map(function (opt) {
            var Icon = opt.icon;
            return (<react_native_1.Pressable key={opt.id} style={[styles.option, { backgroundColor: opt.bg, borderColor: opt.color + '40' }]} onPress={function () { return handleOption(opt.id); }}>
                  <react_native_1.View style={[styles.optionIcon, { backgroundColor: opt.color + '20' }]}>
                    <Icon size={20} color={opt.color}/>
                  </react_native_1.View>
                  <react_native_1.View style={{ flex: 1 }}>
                    <react_native_1.Text style={[styles.optionLabel, { color: opt.color }]}>{opt.label}</react_native_1.Text>
                    <react_native_1.Text style={styles.optionSub}>{opt.sub}</react_native_1.Text>
                  </react_native_1.View>
                </react_native_1.Pressable>);
        })}
          </react_native_1.ScrollView>

          <react_native_1.Pressable style={styles.closeBtn} onPress={onClose}>
            <react_native_1.Text style={styles.closeBtnText}>I'm okay — close</react_native_1.Text>
          </react_native_1.Pressable>
        </react_native_1.View>
      </react_native_1.View>
    </react_native_1.Modal>);
}
var styles = react_native_1.StyleSheet.create({
    overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
    sheet: {
        backgroundColor: tokens_1.color.paper, borderTopLeftRadius: tokens_1.radius.lg, borderTopRightRadius: tokens_1.radius.lg,
        padding: tokens_1.space.xl, paddingBottom: 40, maxHeight: '85%',
    },
    header: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: tokens_1.space.md,
    },
    headerLeft: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm },
    title: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 17 }),
    sub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 12, lineHeight: 18, marginBottom: tokens_1.space.lg }),
    option: {
        flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.md,
        borderRadius: tokens_1.radius.md, borderWidth: 1, padding: tokens_1.space.md, marginBottom: tokens_1.space.sm,
    },
    optionIcon: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
    optionLabel: __assign(__assign({}, tokens_1.type.bodyStrong), { fontSize: 14 }),
    optionSub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
    closeBtn: {
        backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md, padding: tokens_1.space.md,
        alignItems: 'center', marginTop: tokens_1.space.md, borderWidth: 1, borderColor: tokens_1.color.haze,
    },
    closeBtnText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 14 }),
});
