"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PassportShareCard = void 0;
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../theme/tokens");
exports.PassportShareCard = react_1.default.forwardRef(function (_a, ref) {
    var displayName = _a.displayName, username = _a.username, avatarUrl = _a.avatarUrl, tripCount = _a.tripCount, stampCount = _a.stampCount, tagline = _a.tagline;
    return (<react_native_1.View ref={ref} style={styles.card} collapsable={false}>
        {/* Header */}
        <react_native_1.View style={styles.header}>
          <react_native_1.View style={styles.brandRow}>
            <lucide_react_native_1.Plane size={14} color={tokens_1.color.onInk}/>
            <react_native_1.Text style={styles.brand}>TRAVEL BUDDY PASSPORT</react_native_1.Text>
          </react_native_1.View>
        </react_native_1.View>

        {/* Avatar */}
        <react_native_1.View style={styles.avatarWrap}>
          {avatarUrl ? (<react_native_1.Image source={{ uri: avatarUrl }} style={styles.avatar}/>) : (<react_native_1.View style={[styles.avatar, styles.avatarPlaceholder]}>
              <react_native_1.Text style={styles.avatarEmoji}>✈️</react_native_1.Text>
            </react_native_1.View>)}
        </react_native_1.View>

        {/* Name + handle */}
        <react_native_1.Text style={styles.displayName} numberOfLines={1}>
          {displayName !== null && displayName !== void 0 ? displayName : 'Traveler'}
        </react_native_1.Text>
        {username ? (<react_native_1.Text style={styles.handle}>@{username}</react_native_1.Text>) : null}
        {tagline ? (<react_native_1.Text style={styles.tagline} numberOfLines={2}>{tagline}</react_native_1.Text>) : null}

        {/* Stats */}
        <react_native_1.View style={styles.stats}>
          <react_native_1.View style={styles.statItem}>
            <lucide_react_native_1.Map size={16} color={tokens_1.color.onInkMute}/>
            <react_native_1.Text style={styles.statNum}>{tripCount}</react_native_1.Text>
            <react_native_1.Text style={styles.statLabel}>TRIPS</react_native_1.Text>
          </react_native_1.View>
          <react_native_1.View style={styles.statDivider}/>
          <react_native_1.View style={styles.statItem}>
            <lucide_react_native_1.Award size={16} color={tokens_1.color.onInkMute}/>
            <react_native_1.Text style={styles.statNum}>{stampCount}</react_native_1.Text>
            <react_native_1.Text style={styles.statLabel}>STAMPS</react_native_1.Text>
          </react_native_1.View>
        </react_native_1.View>

        {/* MRZ footer */}
        <react_native_1.View style={styles.footer}>
          <react_native_1.Text style={styles.mrzText}>TRAVEL BUDDY · SOCIAL PASSPORT</react_native_1.Text>
        </react_native_1.View>
      </react_native_1.View>);
});
exports.PassportShareCard.displayName = 'PassportShareCard';
var styles = react_native_1.StyleSheet.create({
    card: {
        width: 320,
        backgroundColor: tokens_1.color.ink,
        borderRadius: tokens_1.radius.lg,
        overflow: 'hidden',
        alignItems: 'center',
        paddingBottom: tokens_1.space.md,
    },
    header: {
        width: '100%',
        backgroundColor: 'rgba(255,255,255,0.08)',
        paddingVertical: tokens_1.space.md,
        paddingHorizontal: tokens_1.space.lg,
        alignItems: 'center',
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(255,255,255,0.12)',
    },
    brandRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.sm,
    },
    brand: {
        color: tokens_1.color.onInk,
        fontFamily: 'Courier',
        fontSize: 11,
        fontWeight: '700',
        letterSpacing: 1.5,
    },
    avatarWrap: {
        marginTop: tokens_1.space.xl,
        marginBottom: tokens_1.space.md,
        borderRadius: 52,
        borderWidth: 3,
        borderColor: 'rgba(255,255,255,0.25)',
        overflow: 'hidden',
    },
    avatar: {
        width: 88,
        height: 88,
        borderRadius: 44,
    },
    avatarPlaceholder: {
        backgroundColor: 'rgba(255,255,255,0.12)',
        alignItems: 'center',
        justifyContent: 'center',
    },
    avatarEmoji: { fontSize: 36 },
    displayName: {
        color: tokens_1.color.onInk,
        fontSize: 22,
        fontWeight: '800',
        letterSpacing: -0.3,
        textAlign: 'center',
        paddingHorizontal: tokens_1.space.lg,
    },
    handle: {
        color: tokens_1.color.onInkMute,
        fontFamily: 'Courier',
        fontSize: 13,
        marginTop: 3,
        textAlign: 'center',
    },
    tagline: {
        color: tokens_1.color.onInkMute,
        fontSize: 12,
        textAlign: 'center',
        paddingHorizontal: tokens_1.space.xl,
        marginTop: tokens_1.space.sm,
        lineHeight: 17,
    },
    stats: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: tokens_1.space.xl,
        marginHorizontal: tokens_1.space.xl,
        paddingVertical: tokens_1.space.md,
        borderRadius: tokens_1.radius.md,
        backgroundColor: 'rgba(255,255,255,0.08)',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.12)',
        width: 280,
        justifyContent: 'center',
    },
    statItem: {
        flex: 1,
        alignItems: 'center',
        gap: 3,
    },
    statDivider: {
        width: 1,
        height: 36,
        backgroundColor: 'rgba(255,255,255,0.15)',
    },
    statNum: {
        color: tokens_1.color.onInk,
        fontSize: 22,
        fontWeight: '800',
    },
    statLabel: {
        color: tokens_1.color.onInkMute,
        fontFamily: 'Courier',
        fontSize: 9,
        fontWeight: '700',
        letterSpacing: 1,
    },
    footer: {
        marginTop: tokens_1.space.lg,
        paddingHorizontal: tokens_1.space.lg,
        paddingTop: tokens_1.space.md,
        borderTopWidth: 1,
        borderTopColor: 'rgba(255,255,255,0.1)',
        width: '100%',
        alignItems: 'center',
    },
    mrzText: {
        color: 'rgba(250,249,246,0.3)',
        fontFamily: 'Courier',
        fontSize: 8,
        letterSpacing: 1,
        fontWeight: '700',
        textAlign: 'center',
    },
});
