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
exports.TelegraphActivityInviteCard = TelegraphActivityInviteCard;
/**
 * TelegraphActivityInviteCard — rendered for activity_invite messages.
 * Shows the activity title, proposed time, and accept/decline buttons.
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../theme/tokens");
function TelegraphActivityInviteCard(_a) {
    var activityTitle = _a.activityTitle, activityTime = _a.activityTime, _b = _a.inviteStatus, inviteStatus = _b === void 0 ? 'pending' : _b, isMine = _a.isMine, onAccept = _a.onAccept, onDecline = _a.onDecline;
    var resolved = inviteStatus !== 'pending';
    return (<react_native_1.View style={[styles.card, isMine && styles.cardMine]}>
      <react_native_1.View style={styles.row}>
        <lucide_react_native_1.CalendarCheck size={16} color={tokens_1.color.signal}/>
        <react_native_1.View style={{ flex: 1 }}>
          <react_native_1.Text style={styles.label}>Activity Invite</react_native_1.Text>
          <react_native_1.Text style={styles.title} numberOfLines={2}>{activityTitle}</react_native_1.Text>
          {activityTime ? (<react_native_1.Text style={styles.time}>
              {new Date(activityTime).toLocaleDateString(undefined, {
                weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
            })}
            </react_native_1.Text>) : null}
        </react_native_1.View>
      </react_native_1.View>

      {!isMine && !resolved && (<react_native_1.View style={styles.actions}>
          <react_native_1.Pressable style={[styles.btn, styles.declineBtn]} onPress={onDecline}>
            <lucide_react_native_1.X size={13} color={tokens_1.color.mute}/>
            <react_native_1.Text style={styles.declineTxt}>Decline</react_native_1.Text>
          </react_native_1.Pressable>
          <react_native_1.Pressable style={[styles.btn, styles.acceptBtn]} onPress={onAccept}>
            <lucide_react_native_1.Check size={13} color={tokens_1.color.onInk}/>
            <react_native_1.Text style={styles.acceptTxt}>Accept</react_native_1.Text>
          </react_native_1.Pressable>
        </react_native_1.View>)}

      {resolved && (<react_native_1.View style={styles.statusRow}>
          <react_native_1.Text style={[
                styles.statusText,
                inviteStatus === 'accepted' ? styles.accepted : styles.declined,
            ]}>
            {inviteStatus === 'accepted' ? '✓ Accepted' : '✗ Declined'}
          </react_native_1.Text>
        </react_native_1.View>)}
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    card: {
        backgroundColor: tokens_1.color.paperRaised,
        borderRadius: tokens_1.radius.lg,
        borderWidth: 1,
        borderColor: tokens_1.color.haze,
        padding: tokens_1.space.lg,
        gap: tokens_1.space.md,
        maxWidth: '85%',
        alignSelf: 'flex-start',
    },
    cardMine: { alignSelf: 'flex-end' },
    row: { flexDirection: 'row', gap: tokens_1.space.md, alignItems: 'flex-start' },
    label: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, fontWeight: '700', fontSize: 10, fontFamily: 'Courier', letterSpacing: 0.5 }),
    title: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, marginTop: 2 }),
    time: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, marginTop: 4 }),
    actions: { flexDirection: 'row', gap: tokens_1.space.sm },
    btn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: tokens_1.space.xs, paddingVertical: 8, borderRadius: tokens_1.radius.pill },
    declineBtn: { borderWidth: 1, borderColor: tokens_1.color.haze, backgroundColor: tokens_1.color.paper },
    acceptBtn: { backgroundColor: tokens_1.color.signal },
    declineTxt: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontWeight: '700' }),
    acceptTxt: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.onInk, fontWeight: '700' }),
    statusRow: { alignItems: 'flex-start' },
    statusText: __assign(__assign({}, tokens_1.type.small), { fontFamily: 'Courier', fontWeight: '700' }),
    accepted: { color: '#2E7D5B' },
    declined: { color: tokens_1.color.mute },
});
