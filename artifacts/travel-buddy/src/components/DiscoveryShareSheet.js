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
Object.defineProperty(exports, "__esModule", { value: true });
exports.DiscoveryShareSheet = DiscoveryShareSheet;
/**
 * DiscoveryShareSheet — bottom sheet for sending a Discovery item to a Telegraph thread.
 *
 * Usage: open with an item payload (title, category, city, blurb, sourceId, sourceType).
 * The user picks a recent thread and optionally adds a caption.
 * Sends the card as msgType='system', subtype='discovery_card'.
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var expo_router_1 = require("expo-router");
var tokens_1 = require("../theme/tokens");
var messaging_1 = require("../services/messaging");
function ThreadRow(_a) {
    var _b, _c, _d;
    var thread = _a.thread, selected = _a.selected, onPress = _a.onPress;
    var isDirect = thread.threadType === 'direct';
    var other = thread.otherMembers[0];
    var displayName = (_b = thread.title) !== null && _b !== void 0 ? _b : (isDirect && other ? other.name : 'Chat');
    var avatarUrl = isDirect && other ? other.avatarUrl : null;
    var initials = (_d = (_c = displayName[0]) === null || _c === void 0 ? void 0 : _c.toUpperCase()) !== null && _d !== void 0 ? _d : '?';
    return (<react_native_1.Pressable style={[s.threadRow, selected && s.threadRowSelected]} onPress={onPress}>
      {avatarUrl ? (<react_native_1.Image source={{ uri: avatarUrl }} style={s.avatar}/>) : (<react_native_1.View style={[s.avatarFallback, selected && s.avatarFallbackSelected]}>
          {thread.threadType === 'trip' ? (<lucide_react_native_1.Globe size={14} color={selected ? tokens_1.color.onInk : tokens_1.color.signal}/>) : thread.threadType === 'circle' ? (<lucide_react_native_1.Users size={14} color={selected ? tokens_1.color.onInk : tokens_1.color.signal}/>) : (<react_native_1.Text style={[s.avatarInitial, selected && { color: tokens_1.color.onInk }]}>{initials}</react_native_1.Text>)}
        </react_native_1.View>)}
      <react_native_1.View style={{ flex: 1 }}>
        <react_native_1.Text style={[s.threadName, selected && s.threadNameSelected]} numberOfLines={1}>
          {displayName}
        </react_native_1.Text>
        <react_native_1.Text style={s.threadSub} numberOfLines={1}>
          {thread.threadType === 'trip' ? 'Trip chat' : thread.threadType === 'circle' ? 'Circle' : 'Direct message'}
        </react_native_1.Text>
      </react_native_1.View>
      {selected && (<react_native_1.View style={s.checkBadge}>
          <react_native_1.Text style={s.checkText}>✓</react_native_1.Text>
        </react_native_1.View>)}
    </react_native_1.Pressable>);
}
function DiscoveryShareSheet(_a) {
    var visible = _a.visible, item = _a.item, onClose = _a.onClose;
    var _b = (0, react_1.useState)([]), threads = _b[0], setThreads = _b[1];
    var _c = (0, react_1.useState)(false), loadingThreads = _c[0], setLoadingThreads = _c[1];
    var _d = (0, react_1.useState)(null), selectedId = _d[0], setSelectedId = _d[1];
    var _e = (0, react_1.useState)(''), caption = _e[0], setCaption = _e[1];
    var _f = (0, react_1.useState)(false), sending = _f[0], setSending = _f[1];
    (0, react_1.useEffect)(function () {
        if (!visible)
            return;
        setSelectedId(null);
        setCaption('');
        setLoadingThreads(true);
        (0, messaging_1.getMyThreads)()
            .then(function (res) {
            if (res.ok && res.data) {
                setThreads(res.data.threads.slice(0, 15));
            }
        })
            .catch(function () { })
            .finally(function () { return setLoadingThreads(false); });
    }, [visible]);
    function handleSend() {
        return __awaiter(this, void 0, void 0, function () {
            var payload, res, _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        if (!selectedId || !item)
                            return [2 /*return*/];
                        setSending(true);
                        _b.label = 1;
                    case 1:
                        _b.trys.push([1, 3, 4, 5]);
                        payload = {
                            sourceId: item.sourceId,
                            sourceType: item.sourceType,
                            title: item.title,
                            category: item.category,
                            city: item.city,
                            blurb: item.blurb,
                            imageUrl: item.imageUrl,
                            priceLevel: item.priceLevel,
                            caption: caption.trim() || undefined,
                        };
                        return [4 /*yield*/, (0, messaging_1.sendMessage)(selectedId, JSON.stringify(payload), { msgType: 'system', subtype: 'discovery_card' })];
                    case 2:
                        res = _b.sent();
                        if (res.ok) {
                            onClose();
                            react_native_1.Alert.alert('Sent!', 'Discovery place shared to your chat.');
                        }
                        else {
                            react_native_1.Alert.alert('Could not send', 'Something went wrong. Please try again.');
                        }
                        return [3 /*break*/, 5];
                    case 3:
                        _a = _b.sent();
                        react_native_1.Alert.alert('Could not send', 'Something went wrong. Please try again.');
                        return [3 /*break*/, 5];
                    case 4:
                        setSending(false);
                        return [7 /*endfinally*/];
                    case 5: return [2 /*return*/];
                }
            });
        });
    }
    return (<react_native_1.Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <react_native_1.Pressable style={s.overlay} onPress={onClose}/>
      <react_native_1.View style={s.sheet}>
        <react_native_1.View style={s.handle}/>

        {/* Header */}
        <react_native_1.View style={s.header}>
          <react_native_1.View style={s.headerLeft}>
            <react_native_1.View style={s.compassBadge}>
              <lucide_react_native_1.Compass size={14} color={tokens_1.color.onInk}/>
            </react_native_1.View>
            <react_native_1.Text style={s.title}>Share to Telegraph</react_native_1.Text>
          </react_native_1.View>
          <react_native_1.Pressable onPress={onClose} hitSlop={8}>
            <lucide_react_native_1.X size={18} color={tokens_1.color.mute}/>
          </react_native_1.Pressable>
        </react_native_1.View>

        {/* Item preview */}
        {item && (<react_native_1.View style={s.preview}>
            <react_native_1.View style={s.previewChip}>
              <react_native_1.Text style={s.previewChipText}>{item.category}</react_native_1.Text>
            </react_native_1.View>
            <react_native_1.Text style={s.previewTitle} numberOfLines={1}>{item.title}</react_native_1.Text>
            <react_native_1.View style={s.previewLocRow}>
              <lucide_react_native_1.MapPin size={11} color={tokens_1.color.mute}/>
              <react_native_1.Text style={s.previewLoc} numberOfLines={1}>{item.city}</react_native_1.Text>
            </react_native_1.View>
          </react_native_1.View>)}

        {/* Caption */}
        <react_native_1.TextInput style={s.captionInput} placeholder="Add a note (optional)…" placeholderTextColor={tokens_1.color.faint} value={caption} onChangeText={setCaption} maxLength={200} multiline/>

        {/* Thread list */}
        <react_native_1.Text style={s.sectionLabel}>CHOOSE A CHAT</react_native_1.Text>

        {/* New Telegraph option — always shown at the top */}
        <react_native_1.Pressable style={s.newThreadRow} onPress={function () {
            onClose();
            expo_router_1.router.push('/(tabs)/messages');
        }}>
          <react_native_1.View style={s.newThreadIcon}>
            <lucide_react_native_1.PlusCircle size={16} color={tokens_1.color.signal}/>
          </react_native_1.View>
          <react_native_1.View style={{ flex: 1 }}>
            <react_native_1.Text style={s.newThreadLabel}>New Telegraph</react_native_1.Text>
            <react_native_1.Text style={s.newThreadSub}>Start a new conversation</react_native_1.Text>
          </react_native_1.View>
        </react_native_1.Pressable>

        {loadingThreads ? (<react_native_1.View style={s.loadingRow}>
            <react_native_1.ActivityIndicator size="small" color={tokens_1.color.signal}/>
          </react_native_1.View>) : threads.length === 0 ? (<react_native_1.View style={s.loadingRow}>
            <lucide_react_native_1.MessageCircle size={24} color={tokens_1.color.faint}/>
            <react_native_1.Text style={s.emptyLabel}>No existing chats yet.</react_native_1.Text>
          </react_native_1.View>) : (<react_native_1.FlatList data={threads} keyExtractor={function (t) { return t.id; }} style={s.list} renderItem={function (_a) {
                var thread = _a.item;
                return (<ThreadRow thread={thread} selected={selectedId === thread.id} onPress={function () { return setSelectedId(thread.id); }}/>);
            }} ItemSeparatorComponent={function () { return <react_native_1.View style={{ height: 1, backgroundColor: tokens_1.color.haze }}/>; }}/>)}

        {/* Send button */}
        <react_native_1.Pressable style={[s.sendBtn, (!selectedId || sending) && s.sendBtnDisabled]} onPress={handleSend} disabled={!selectedId || sending}>
          {sending ? (<react_native_1.ActivityIndicator size="small" color={tokens_1.color.onInk}/>) : (<>
              <lucide_react_native_1.Send size={15} color={tokens_1.color.onInk}/>
              <react_native_1.Text style={s.sendLabel}>Send</react_native_1.Text>
            </>)}
        </react_native_1.Pressable>
      </react_native_1.View>
    </react_native_1.Modal>);
}
var s = react_native_1.StyleSheet.create({
    overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
    sheet: {
        backgroundColor: tokens_1.color.paperRaised,
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        paddingHorizontal: tokens_1.space.lg,
        paddingBottom: 40,
        paddingTop: tokens_1.space.sm,
        maxHeight: '85%',
    },
    handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: tokens_1.color.haze, alignSelf: 'center', marginBottom: tokens_1.space.md },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: tokens_1.space.md },
    headerLeft: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm },
    compassBadge: { width: 28, height: 28, borderRadius: 8, backgroundColor: tokens_1.color.signal, alignItems: 'center', justifyContent: 'center' },
    title: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontWeight: '700', fontSize: 16 }),
    preview: {
        backgroundColor: tokens_1.color.signal + '0A',
        borderRadius: tokens_1.radius.md,
        borderWidth: 1,
        borderColor: tokens_1.color.signal + '30',
        padding: tokens_1.space.md,
        gap: 4,
        marginBottom: tokens_1.space.md,
    },
    previewChip: { alignSelf: 'flex-start', backgroundColor: tokens_1.color.signal + '22', borderRadius: tokens_1.radius.pill, paddingHorizontal: 8, paddingVertical: 2 },
    previewChipText: __assign(__assign({}, tokens_1.type.stamp), { fontFamily: 'Courier', fontSize: 10, color: tokens_1.color.signal, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 }),
    previewTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontWeight: '700' }),
    previewLocRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
    previewLoc: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
    captionInput: __assign(__assign({ backgroundColor: tokens_1.color.paper, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, paddingHorizontal: tokens_1.space.md, paddingVertical: 10 }, tokens_1.type.body), { color: tokens_1.color.ink, minHeight: 42, maxHeight: 80, marginBottom: tokens_1.space.md }),
    sectionLabel: __assign(__assign({}, tokens_1.type.stamp), { fontFamily: 'Courier', fontSize: 10, color: tokens_1.color.mute, letterSpacing: 0.5, marginBottom: tokens_1.space.sm }),
    loadingRow: { alignItems: 'center', justifyContent: 'center', paddingVertical: tokens_1.space.xl, gap: tokens_1.space.sm },
    emptyLabel: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, textAlign: 'center', lineHeight: 18 }),
    list: { maxHeight: 220, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, marginBottom: tokens_1.space.md },
    threadRow: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.md, paddingHorizontal: tokens_1.space.md, paddingVertical: 12 },
    threadRowSelected: { backgroundColor: tokens_1.color.signal + '0A' },
    avatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: tokens_1.color.haze },
    avatarFallback: { width: 36, height: 36, borderRadius: 18, backgroundColor: tokens_1.color.haze, alignItems: 'center', justifyContent: 'center' },
    avatarFallbackSelected: { backgroundColor: tokens_1.color.signal + '22' },
    avatarInitial: { fontSize: 14, fontWeight: '700', color: tokens_1.color.signal },
    threadName: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 14 }),
    threadNameSelected: { color: tokens_1.color.signal },
    threadSub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11, marginTop: 1 }),
    checkBadge: { width: 20, height: 20, borderRadius: 10, backgroundColor: tokens_1.color.signal, alignItems: 'center', justifyContent: 'center' },
    checkText: { fontSize: 12, color: tokens_1.color.onInk, fontWeight: '700' },
    newThreadRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.md,
        paddingHorizontal: tokens_1.space.md,
        paddingVertical: 12,
        borderRadius: tokens_1.radius.md,
        borderWidth: 1,
        borderColor: tokens_1.color.signal + '40',
        backgroundColor: tokens_1.color.signal + '07',
        marginBottom: tokens_1.space.sm,
    },
    newThreadIcon: {
        width: 36,
        height: 36,
        borderRadius: 18,
        backgroundColor: tokens_1.color.signal + '15',
        alignItems: 'center',
        justifyContent: 'center',
    },
    newThreadLabel: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.signal, fontWeight: '700', fontSize: 14 }),
    newThreadSub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11, marginTop: 1 }),
    sendBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: tokens_1.space.sm,
        backgroundColor: tokens_1.color.signal,
        borderRadius: tokens_1.radius.md,
        paddingVertical: 14,
        marginTop: tokens_1.space.sm,
    },
    sendBtnDisabled: { opacity: 0.45 },
    sendLabel: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.onInk, fontWeight: '700', fontSize: 15 }),
});
