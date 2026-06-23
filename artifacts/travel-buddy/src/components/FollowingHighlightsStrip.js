"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FollowingHighlightsStrip = FollowingHighlightsStrip;
/**
 * FollowingHighlightsStrip — horizontal stories-style tray for the Explore tab.
 *
 * Shows avatars with gradient rings for followed users who have active highlights.
 * Tapping an avatar opens HighlightViewer for that user's highlights.
 * The ring mutes to grey once all highlights have been viewed in the current session.
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var HighlightRing_1 = require("./HighlightRing");
var HighlightViewer_1 = require("./HighlightViewer");
var tokens_1 = require("../theme/tokens");
var SessionContext_1 = require("../context/SessionContext");
var AVATAR_SIZE = 52;
function FollowingHighlightsStrip(_a) {
    var users = _a.users, sessionViewedIds = _a.sessionViewedIds, onMarkViewed = _a.onMarkViewed;
    var currentUserId = (0, SessionContext_1.useSession)().userId;
    var _b = (0, react_1.useState)(null), viewingUser = _b[0], setViewingUser = _b[1];
    if (users.length === 0)
        return null;
    var handleClose = function () {
        if (viewingUser) {
            onMarkViewed(viewingUser.highlights.map(function (h) { return h.id; }));
        }
        setViewingUser(null);
    };
    return (<react_native_1.View style={styles.wrapper}>
      <react_native_1.ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.content}>
        {users.map(function (u) {
            var _a, _b, _c, _d;
            var allViewed = u.highlights.every(function (h) { return h.viewedByMe || sessionViewedIds.has(h.id); });
            var label = (_b = (_a = u.handle) !== null && _a !== void 0 ? _a : u.name) !== null && _b !== void 0 ? _b : '';
            return (<react_native_1.Pressable key={u.userId} style={styles.item} onPress={function () { return setViewingUser(u); }} accessibilityRole="button" accessibilityLabel={"View ".concat(label, "'s highlights")}>
              <HighlightRing_1.HighlightRing hasActive allViewed={allViewed} size={AVATAR_SIZE}>
                {u.avatarUrl ? (<react_native_1.Image source={{ uri: u.avatarUrl }} style={styles.avatar}/>) : (<react_native_1.View style={[styles.avatar, styles.avatarFallback]}>
                    <react_native_1.Text style={styles.avatarInitial}>
                      {((_d = (_c = u.name) !== null && _c !== void 0 ? _c : u.handle) !== null && _d !== void 0 ? _d : '?')[0].toUpperCase()}
                    </react_native_1.Text>
                  </react_native_1.View>)}
              </HighlightRing_1.HighlightRing>
              <react_native_1.Text style={[styles.name, allViewed && styles.nameMuted]} numberOfLines={1}>
                {label}
              </react_native_1.Text>
            </react_native_1.Pressable>);
        })}
      </react_native_1.ScrollView>

      {viewingUser && (<HighlightViewer_1.HighlightViewer visible highlights={viewingUser.highlights} currentUserId={currentUserId !== null && currentUserId !== void 0 ? currentUserId : undefined} onClose={handleClose} onDeleted={handleClose}/>)}
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    wrapper: {
        borderBottomWidth: 1,
        borderBottomColor: tokens_1.color.haze,
        backgroundColor: tokens_1.color.paper,
    },
    content: {
        paddingHorizontal: tokens_1.space.lg,
        paddingVertical: tokens_1.space.md,
        gap: tokens_1.space.lg,
    },
    item: {
        alignItems: 'center',
        width: 64,
    },
    avatar: {
        width: AVATAR_SIZE,
        height: AVATAR_SIZE,
        borderRadius: AVATAR_SIZE / 2,
    },
    avatarFallback: {
        backgroundColor: tokens_1.color.haze,
        alignItems: 'center',
        justifyContent: 'center',
    },
    avatarInitial: {
        fontSize: 20,
        fontWeight: '700',
        color: tokens_1.color.mute,
    },
    name: {
        fontSize: 11,
        color: tokens_1.color.mute,
        marginTop: tokens_1.space.xs,
        maxWidth: 64,
        textAlign: 'center',
    },
    nameMuted: {
        color: tokens_1.color.faint,
    },
});
