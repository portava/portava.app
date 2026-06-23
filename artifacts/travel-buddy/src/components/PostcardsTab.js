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
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
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
exports.PostcardsTab = PostcardsTab;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../theme/tokens");
var INTEREST_LABEL = {
    nightlife: 'Nightlife', food: 'Food', beach: 'Beach', luxury: 'Luxury',
    culture: 'Culture', adventure: 'Adventure', wellness: 'Wellness',
    photography: 'Photography', backpacking: 'Backpacking', shopping: 'Shopping',
    business: 'Business', dating: 'Social', events: 'Events',
};
/* ────────────────────────────────────────────────────────── */
/* Action menu bottom sheet                                   */
/* ────────────────────────────────────────────────────────── */
function CardMenu(_a) {
    var _this = this;
    var _b;
    var card = _a.card, visible = _a.visible, onClose = _a.onClose, actions = _a.actions;
    var _c = (0, react_1.useState)(false), noteMode = _c[0], setNoteMode = _c[1];
    var _d = (0, react_1.useState)((_b = card.note) !== null && _b !== void 0 ? _b : ''), noteText = _d[0], setNoteText = _d[1];
    var isPinned = Boolean(card.pinnedAt);
    var isDeleting = actions.busy === card.id;
    var doPin = function () { return __awaiter(_this, void 0, void 0, function () { return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                onClose();
                return [4 /*yield*/, (isPinned ? actions.unpin(card.id) : actions.pin(card.id))];
            case 1:
                _a.sent();
                return [2 /*return*/];
        }
    }); }); };
    var doSaveNote = function () { return __awaiter(_this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, actions.editNote(card.id, noteText.trim() || null)];
                case 1:
                    _a.sent();
                    setNoteMode(false);
                    onClose();
                    return [2 /*return*/];
            }
        });
    }); };
    var doClearNote = function () { return __awaiter(_this, void 0, void 0, function () { return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, actions.clearNote(card.id)];
            case 1:
                _a.sent();
                setNoteMode(false);
                onClose();
                return [2 /*return*/];
        }
    }); }); };
    var doRemove = function () {
        onClose();
        react_native_1.Alert.alert('Remove from Passport', 'This hides the postcard from your Passport but keeps the original post.', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Remove', style: 'destructive', onPress: function () { return actions.remove(card.id); } },
        ]);
    };
    var doDelete = function () {
        onClose();
        react_native_1.Alert.alert('Delete post', 'This permanently deletes the original post and removes it from your Passport.', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Delete', style: 'destructive', onPress: function () { return actions.deletePostAndCard(card.id, card.postId); } },
        ]);
    };
    return (<react_native_1.Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <react_native_1.Pressable style={mn.overlay} onPress={onClose}/>
      <react_native_1.View style={mn.sheet}>
        {noteMode ? (<>
            <react_native_1.Text style={mn.sheetTitle}>Edit note</react_native_1.Text>
            <react_native_1.TextInput style={mn.noteInput} value={noteText} onChangeText={setNoteText} placeholder="Add a note to this postcard…" placeholderTextColor={tokens_1.color.faint} multiline maxLength={500} autoFocus/>
            <react_native_1.View style={mn.noteActions}>
              <react_native_1.Pressable style={mn.noteBtn} onPress={function () { return setNoteMode(false); }}><react_native_1.Text style={mn.noteBtnText}>Cancel</react_native_1.Text></react_native_1.Pressable>
              <react_native_1.Pressable style={[mn.noteBtn, mn.noteSave]} onPress={doSaveNote}><react_native_1.Text style={[mn.noteBtnText, { color: tokens_1.color.onInk }]}>Save</react_native_1.Text></react_native_1.Pressable>
            </react_native_1.View>
            {card.note && (<react_native_1.Pressable style={mn.clearNote} onPress={doClearNote}><react_native_1.Text style={mn.clearNoteText}>Clear note</react_native_1.Text></react_native_1.Pressable>)}
          </>) : (<>
            <react_native_1.View style={mn.handle}/>
            <react_native_1.Text style={mn.sheetTitle}>Postcard options</react_native_1.Text>
            {isDeleting && <react_native_1.ActivityIndicator style={{ marginVertical: tokens_1.space.sm }} color={tokens_1.color.signal}/>}
            <react_native_1.Pressable style={mn.item} onPress={function () { return setNoteMode(true); }}>
              <react_native_1.Text style={mn.itemText}>{card.note ? 'Edit note' : 'Add note'}</react_native_1.Text>
            </react_native_1.Pressable>
            {card.note ? (<react_native_1.Pressable style={mn.item} onPress={doClearNote}>
                <react_native_1.Text style={mn.itemText}>Clear note</react_native_1.Text>
              </react_native_1.Pressable>) : null}
            <react_native_1.Pressable style={mn.item} onPress={doPin}>
              <react_native_1.Text style={mn.itemText}>{isPinned ? 'Unpin postcard' : 'Pin to top'}</react_native_1.Text>
            </react_native_1.Pressable>
            <react_native_1.View style={mn.divider}/>
            <react_native_1.Pressable style={mn.item} onPress={doRemove}>
              <react_native_1.Text style={[mn.itemText, mn.danger]}>Remove from Passport</react_native_1.Text>
            </react_native_1.Pressable>
            <react_native_1.Pressable style={mn.item} onPress={doDelete}>
              <react_native_1.Text style={[mn.itemText, mn.danger]}>Delete post</react_native_1.Text>
            </react_native_1.Pressable>
            <react_native_1.Pressable style={[mn.item, mn.cancelItem]} onPress={onClose}>
              <react_native_1.Text style={mn.itemText}>Cancel</react_native_1.Text>
            </react_native_1.Pressable>
          </>)}
      </react_native_1.View>
    </react_native_1.Modal>);
}
/* ────────────────────────────────────────────────────────── */
/* Single postcard card                                        */
/* ────────────────────────────────────────────────────────── */
function PostcardCard(_a) {
    var _b;
    var card = _a.card, isOwner = _a.isOwner, actions = _a.actions;
    var _c = (0, react_1.useState)(false), menuOpen = _c[0], setMenuOpen = _c[1];
    var isPinned = Boolean(card.pinnedAt);
    var isVerified = card.locationVerified && card.stampEligible;
    var date = card.createdAt
        ? new Date(card.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
        : '';
    return (<react_native_1.View style={pc.card}>
      {/* media */}
      {card.mediaUrl ? (<react_native_1.Pressable onPress={function () { return card.postId && expo_router_1.router.push("/post/".concat(card.postId)); }}>
          <react_native_1.Image source={{ uri: card.mediaUrl }} style={pc.media} defaultSource={undefined}/>
        </react_native_1.Pressable>) : (<react_native_1.View style={[pc.media, pc.noMedia]}>
          <react_native_1.Text style={pc.noMediaText}>📷</react_native_1.Text>
        </react_native_1.View>)}

      {/* overlays */}
      {isPinned && (<react_native_1.View style={pc.pinBadge}>
          <lucide_react_native_1.Pin size={11} color={tokens_1.color.signal} fill={tokens_1.color.signal}/>
          <react_native_1.Text style={pc.pinText}>PINNED</react_native_1.Text>
        </react_native_1.View>)}
      {isOwner && actions && (<react_native_1.Pressable style={pc.menuBtn} onPress={function () { return setMenuOpen(true); }} hitSlop={8}>
          <lucide_react_native_1.MoreHorizontal size={18} color={tokens_1.color.ink}/>
        </react_native_1.Pressable>)}

      {/* body */}
      <react_native_1.View style={pc.body}>
        <react_native_1.View style={pc.metaRow}>
          {(card.locationCity || card.locationName) && (<react_native_1.View style={pc.locRow}>
              <lucide_react_native_1.MapPin size={11} color={tokens_1.color.deep}/>
              <react_native_1.Text style={pc.locText} numberOfLines={1}>
                {(_b = card.locationCity) !== null && _b !== void 0 ? _b : card.locationName}
                {card.locationCountry ? ", ".concat(card.locationCountry) : ''}
              </react_native_1.Text>
            </react_native_1.View>)}
          {date ? <react_native_1.Text style={pc.dateText}>{date}</react_native_1.Text> : null}
        </react_native_1.View>

        {(card.caption || card.note) ? (<react_native_1.Text style={pc.caption} numberOfLines={3}>
            {card.note ? "\"".concat(card.note, "\"") : card.caption}
          </react_native_1.Text>) : null}

        <react_native_1.View style={pc.badgeRow}>
          {isVerified ? (<react_native_1.View style={pc.verifiedBadge}>
              <lucide_react_native_1.ShieldCheck size={11} color={tokens_1.color.success}/>
              <react_native_1.Text style={pc.verifiedText}>GPS Verified</react_native_1.Text>
            </react_native_1.View>) : (<react_native_1.View style={pc.tagBadge}>
              <react_native_1.Text style={pc.tagText}>📍 Manual tag</react_native_1.Text>
            </react_native_1.View>)}
          {isOwner && (<react_native_1.View style={[pc.visLabel, card.visibility === 'public' ? pc.visPublic : pc.visPrivate]}>
              <react_native_1.Text style={pc.visText}>{card.visibility === 'public' ? 'Public' : card.visibility === 'trip_only' ? 'Trip' : 'Private'}</react_native_1.Text>
            </react_native_1.View>)}
        </react_native_1.View>
      </react_native_1.View>

      {isOwner && actions && (<CardMenu card={card} visible={menuOpen} onClose={function () { return setMenuOpen(false); }} actions={actions}/>)}
    </react_native_1.View>);
}
/* ────────────────────────────────────────────────────────── */
/* PostcardsTab                                               */
/* ────────────────────────────────────────────────────────── */
function PostcardsTab(_a) {
    var postcards = _a.postcards, isOwner = _a.isOwner, actions = _a.actions;
    if (postcards.length === 0) {
        return (<react_native_1.View style={pc.empty}>
        <react_native_1.Text style={pc.emptyIcon}>🌍</react_native_1.Text>
        <react_native_1.Text style={pc.emptyTitle}>No postcards yet</react_native_1.Text>
        <react_native_1.Text style={pc.emptySub}>
          {isOwner
                ? 'Create a photo post to start your Passport wall.'
                : "This traveler hasn't posted any postcards yet."}
        </react_native_1.Text>
        {isOwner && (<react_native_1.Pressable style={pc.emptyBtn} onPress={function () { return expo_router_1.router.push('/create'); }}>
            <react_native_1.Text style={pc.emptyBtnText}>Create first post</react_native_1.Text>
          </react_native_1.Pressable>)}
      </react_native_1.View>);
    }
    var pinned = postcards.find(function (c) { return c.pinnedAt; });
    var rest = postcards.filter(function (c) { return !c.pinnedAt; });
    var sorted = pinned ? __spreadArray([pinned], rest, true) : rest;
    return (<react_native_1.View style={pc.list}>
      {sorted.map(function (card) { return (<PostcardCard key={card.id} card={card} isOwner={isOwner} actions={actions}/>); })}
    </react_native_1.View>);
}
var pc = react_native_1.StyleSheet.create({
    card: __assign(__assign({ backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.lg, borderWidth: 1, borderColor: tokens_1.color.haze, overflow: 'hidden' }, tokens_1.shadow.card), { marginBottom: tokens_1.space.md }),
    media: { width: '100%', height: 220, backgroundColor: tokens_1.color.haze },
    noMedia: { alignItems: 'center', justifyContent: 'center' },
    noMediaText: { fontSize: 40 },
    pinBadge: {
        position: 'absolute', top: 10, left: 10,
        flexDirection: 'row', alignItems: 'center', gap: 4,
        backgroundColor: 'rgba(250,249,246,0.92)',
        borderRadius: tokens_1.radius.pill, paddingHorizontal: 8, paddingVertical: 4,
        borderWidth: 1, borderColor: tokens_1.color.signal,
    },
    pinText: { fontFamily: 'Courier', fontSize: 9, fontWeight: '700', color: tokens_1.color.signal, letterSpacing: 1 },
    menuBtn: {
        position: 'absolute', top: 10, right: 10,
        backgroundColor: 'rgba(250,249,246,0.92)',
        borderRadius: 20, padding: 6,
        borderWidth: 1, borderColor: tokens_1.color.haze,
    },
    body: { padding: tokens_1.space.md, gap: tokens_1.space.sm },
    metaRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: tokens_1.space.xs },
    locRow: { flexDirection: 'row', alignItems: 'center', gap: 4, flex: 1 },
    locText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.deep, fontFamily: 'Courier', fontWeight: '700', fontSize: 11 }),
    dateText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.faint, fontFamily: 'Courier', fontSize: 10 }),
    caption: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, lineHeight: 20 }),
    badgeRow: { flexDirection: 'row', gap: tokens_1.space.sm, alignItems: 'center', flexWrap: 'wrap' },
    verifiedBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#E3F1EA', borderRadius: tokens_1.radius.pill, paddingHorizontal: 8, paddingVertical: 3 },
    verifiedText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.success, fontWeight: '700', fontSize: 11 }),
    tagBadge: { backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.pill, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, borderColor: tokens_1.color.haze },
    tagText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
    visLabel: { borderRadius: tokens_1.radius.pill, paddingHorizontal: 8, paddingVertical: 3 },
    visPublic: { backgroundColor: '#E3F1EA' },
    visPrivate: { backgroundColor: '#FCE9E4' },
    visText: __assign(__assign({}, tokens_1.type.small), { fontSize: 11, fontWeight: '700', color: tokens_1.color.ink }),
    list: { paddingHorizontal: tokens_1.space.lg, paddingTop: tokens_1.space.md },
    empty: { paddingHorizontal: tokens_1.space.xl, paddingTop: tokens_1.space.xxxl, alignItems: 'center', gap: tokens_1.space.md },
    emptyIcon: { fontSize: 48 },
    emptyTitle: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink }),
    emptySub: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute, textAlign: 'center' }),
    emptyBtn: { backgroundColor: tokens_1.color.signal, paddingHorizontal: tokens_1.space.xl, paddingVertical: tokens_1.space.md, borderRadius: tokens_1.radius.pill },
    emptyBtnText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.onInk }),
});
var mn = react_native_1.StyleSheet.create({
    overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
    sheet: {
        backgroundColor: tokens_1.color.paper, borderTopLeftRadius: 24, borderTopRightRadius: 24,
        paddingHorizontal: tokens_1.space.lg, paddingBottom: 40, paddingTop: tokens_1.space.md,
        minHeight: 200,
    },
    handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: tokens_1.color.haze, alignSelf: 'center', marginBottom: tokens_1.space.md },
    sheetTitle: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink, marginBottom: tokens_1.space.md, textAlign: 'center' }),
    item: { paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: tokens_1.color.haze },
    itemText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, textAlign: 'center', fontWeight: '600' }),
    danger: { color: '#D93025' },
    cancelItem: { borderBottomWidth: 0, marginTop: tokens_1.space.sm },
    divider: { height: 1, backgroundColor: tokens_1.color.haze, marginVertical: tokens_1.space.xs },
    noteInput: __assign(__assign({ borderWidth: 1, borderColor: tokens_1.color.haze, borderRadius: tokens_1.radius.md, padding: tokens_1.space.md }, tokens_1.type.body), { color: tokens_1.color.ink, minHeight: 100, textAlignVertical: 'top', marginBottom: tokens_1.space.md }),
    noteActions: { flexDirection: 'row', gap: tokens_1.space.md, justifyContent: 'flex-end' },
    noteBtn: { paddingHorizontal: tokens_1.space.lg, paddingVertical: tokens_1.space.sm, borderRadius: tokens_1.radius.pill, borderWidth: 1, borderColor: tokens_1.color.haze },
    noteSave: { backgroundColor: tokens_1.color.signal, borderColor: tokens_1.color.signal },
    noteBtnText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink }),
    clearNote: { marginTop: tokens_1.space.md, alignItems: 'center' },
    clearNoteText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, textDecorationLine: 'underline' }),
});
