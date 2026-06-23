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
exports.TelegraphInboxScreen = TelegraphInboxScreen;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var lucide_react_native_1 = require("lucide-react-native");
var react_native_safe_area_context_1 = require("react-native-safe-area-context");
var useMessaging_1 = require("../hooks/useMessaging");
var SessionContext_1 = require("../context/SessionContext");
var blocks_1 = require("../services/blocks");
var HighlightRing_1 = require("./HighlightRing");
var HighlightViewer_1 = require("./HighlightViewer");
var useHighlightRingState_1 = require("../hooks/useHighlightRingState");
var tokens_1 = require("../theme/tokens");
var FILTERS = [
    { key: 'all', label: 'All' },
    { key: 'direct', label: 'Direct' },
    { key: 'trips', label: 'Trips' },
    { key: 'circles', label: 'Circles' },
    { key: 'unread', label: 'Unread' },
    { key: 'requests', label: 'Requests' },
];
function timeAgo(iso) {
    var diff = Date.now() - new Date(iso).getTime();
    var m = Math.floor(diff / 60000);
    if (m < 1)
        return 'now';
    if (m < 60)
        return "".concat(m, "m");
    var h = Math.floor(m / 60);
    if (h < 24)
        return "".concat(h, "h");
    var d = Math.floor(h / 24);
    if (d < 7)
        return "".concat(d, "d");
    return "".concat(Math.floor(d / 7), "w");
}
function navigateToThread(item) {
    var _a, _b, _c, _d;
    var title = item.threadType !== 'direct'
        ? ((_a = item.title) !== null && _a !== void 0 ? _a : '')
        : ((_c = (_b = item.otherMembers[0]) === null || _b === void 0 ? void 0 : _b.name) !== null && _c !== void 0 ? _c : '');
    var params = new URLSearchParams({ title: title, threadType: item.threadType });
    if (item.tripId)
        params.set('contextId', item.tripId);
    else if (item.circleOwnerId)
        params.set('contextId', item.circleOwnerId);
    if (item.threadType === 'direct' && ((_d = item.otherMembers[0]) === null || _d === void 0 ? void 0 : _d.id)) {
        params.set('otherUserId', item.otherMembers[0].id);
    }
    expo_router_1.router.push("/messages/".concat(item.id, "?").concat(params.toString()));
}
var TYPE_BADGE = {
    direct: { bg: '#E6EEF8', text: '#2B5EA7', label: 'Direct' },
    trip: { bg: '#E0EFEC', text: '#0A3D4A', label: 'Trip' },
    circle: { bg: '#F2EBE0', text: '#7A4C20', label: 'Circle' },
};
function TypeBadge(_a) {
    var threadType = _a.threadType;
    var cfg = TYPE_BADGE[threadType];
    if (!cfg)
        return null;
    return (<react_native_1.View style={[s.typeBadge, { backgroundColor: cfg.bg }]}>
      <react_native_1.Text style={[s.typeBadgeText, { color: cfg.text }]}>{cfg.label}</react_native_1.Text>
    </react_native_1.View>);
}
function SkeletonRow() {
    return (<react_native_1.View style={s.row}>
      <react_native_1.View style={[s.avatar, { backgroundColor: tokens_1.color.haze }]}/>
      <react_native_1.View style={{ flex: 1, gap: 7 }}>
        <react_native_1.View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <react_native_1.View style={{ height: 13, width: '50%', backgroundColor: tokens_1.color.haze, borderRadius: 6 }}/>
          <react_native_1.View style={{ height: 13, width: 44, backgroundColor: tokens_1.color.haze, borderRadius: 6 }}/>
        </react_native_1.View>
        <react_native_1.View style={{ height: 11, width: '78%', backgroundColor: tokens_1.color.haze, borderRadius: 6 }}/>
      </react_native_1.View>
    </react_native_1.View>);
}
function DmThreadAvatar(_a) {
    var _b, _c, _d;
    var item = _a.item, currentUserId = _a.currentUserId;
    var other = item.otherMembers[0];
    var ringState = (0, useHighlightRingState_1.useHighlightRingState)((_b = other === null || other === void 0 ? void 0 : other.id) !== null && _b !== void 0 ? _b : null);
    var _e = (0, react_1.useState)(false), viewerOpen = _e[0], setViewerOpen = _e[1];
    var inner = (other === null || other === void 0 ? void 0 : other.avatarUrl)
        ? <react_native_1.Image source={{ uri: other.avatarUrl }} style={s.avatar}/>
        : (<react_native_1.View style={[s.avatar, s.avatarPlaceholder]}>
        <react_native_1.Text style={s.avatarInitial}>{((_d = (_c = other === null || other === void 0 ? void 0 : other.name) === null || _c === void 0 ? void 0 : _c[0]) !== null && _d !== void 0 ? _d : '?').toUpperCase()}</react_native_1.Text>
      </react_native_1.View>);
    if (!(ringState === null || ringState === void 0 ? void 0 : ringState.hasActive))
        return inner;
    return (<>
      <HighlightRing_1.HighlightRing size={50} hasActive allViewed={ringState.allViewed} onPress={function () { return setViewerOpen(true); }}>
        {inner}
      </HighlightRing_1.HighlightRing>
      <HighlightViewer_1.HighlightViewer visible={viewerOpen} highlights={ringState.highlights} currentUserId={currentUserId !== null && currentUserId !== void 0 ? currentUserId : undefined} onClose={function () { return setViewerOpen(false); }}/>
    </>);
}
function ThreadAvatarIcon(_a) {
    var item = _a.item, currentUserId = _a.currentUserId;
    if (item.threadType === 'trip') {
        return (<react_native_1.View style={[s.avatar, s.groupAvatar, { backgroundColor: '#E0EFEC' }]}>
        <lucide_react_native_1.Globe size={22} color={tokens_1.color.deep}/>
      </react_native_1.View>);
    }
    if (item.threadType === 'circle') {
        return (<react_native_1.View style={[s.avatar, s.groupAvatar, { backgroundColor: '#F2EBE0' }]}>
        <lucide_react_native_1.Users size={22} color="#7A4C20"/>
      </react_native_1.View>);
    }
    return <DmThreadAvatar item={item} currentUserId={currentUserId}/>;
}
function ThreadRow(_a) {
    var _b, _c, _d, _e, _f, _g;
    var item = _a.item, userId = _a.userId;
    var isGroup = item.threadType !== 'direct';
    var displayName = isGroup
        ? ((_b = item.title) !== null && _b !== void 0 ? _b : (item.threadType === 'trip' ? 'Trip Chat' : 'Circle Chat'))
        : ((_d = (_c = item.otherMembers[0]) === null || _c === void 0 ? void 0 : _c.name) !== null && _d !== void 0 ? _d : 'Unknown');
    var lmp = item.lastMessagePreview;
    var isMine = (lmp === null || lmp === void 0 ? void 0 : lmp.senderId) === userId;
    var previewText = lmp ? (isMine ? lmp.body : ((_e = lmp.displayBody) !== null && _e !== void 0 ? _e : lmp.body)) : '';
    var lastAt = lmp === null || lmp === void 0 ? void 0 : lmp.createdAt;
    var isMuted = !!item.mutedAt;
    var unread = (_f = item.unreadCount) !== null && _f !== void 0 ? _f : 0;
    var isAi = (_g = item.isAiLastMessage) !== null && _g !== void 0 ? _g : ((lmp === null || lmp === void 0 ? void 0 : lmp.msgType) === 'ai_recommendation');
    return (<react_native_1.Pressable style={function (_a) {
        var pressed = _a.pressed;
        return [s.row, pressed && s.rowPressed];
    }} onPress={function () { return navigateToThread(item); }}>
      <ThreadAvatarIcon item={item} currentUserId={userId}/>

      <react_native_1.View style={{ flex: 1, gap: 3 }}>
        <react_native_1.View style={s.nameRow}>
          <react_native_1.View style={s.nameLeft}>
            <react_native_1.Text style={[s.name, unread > 0 && s.nameBold]} numberOfLines={1}>{displayName}</react_native_1.Text>
            {isMuted && <lucide_react_native_1.BellOff size={12} color={tokens_1.color.faint} style={{ marginLeft: 4 }}/>}
            <TypeBadge threadType={item.threadType}/>
          </react_native_1.View>
          <react_native_1.View style={s.nameMeta}>
            {unread > 0 && (<react_native_1.View style={s.unreadBubble}>
                <react_native_1.Text style={s.unreadText}>{unread > 99 ? '99+' : unread}</react_native_1.Text>
              </react_native_1.View>)}
            {lastAt ? <react_native_1.Text style={s.time}>{timeAgo(lastAt)}</react_native_1.Text> : null}
          </react_native_1.View>
        </react_native_1.View>

        {previewText ? (<react_native_1.View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            {isAi && (<react_native_1.View style={s.aiBadge}>
                <lucide_react_native_1.Bot size={9} color={tokens_1.color.onInk}/>
                <react_native_1.Text style={s.aiBadgeText}>AI</react_native_1.Text>
              </react_native_1.View>)}
            <react_native_1.Text style={[s.preview, unread > 0 && s.previewBold]} numberOfLines={1}>
              {previewText}
            </react_native_1.Text>
          </react_native_1.View>) : null}

        {item.tripCity ? (<react_native_1.View style={s.cityTag}>
            <react_native_1.Text style={s.cityTagText}>{item.tripCity}</react_native_1.Text>
          </react_native_1.View>) : null}
      </react_native_1.View>
    </react_native_1.Pressable>);
}
var FILTER_EMPTY = {
    all: 'Your Telegraph is quiet.',
    direct: 'No direct conversations yet.',
    trips: 'No trip chats yet.',
    circles: 'No circle chats yet.',
    unread: "You're all caught up.",
    requests: 'No pending requests.',
};
function EmptyState(_a) {
    var filter = _a.filter;
    return (<react_native_1.View style={s.emptyWrap}>
      <react_native_1.View style={s.emptyIcon}>
        <lucide_react_native_1.Zap size={28} color={tokens_1.color.signal}/>
      </react_native_1.View>
      <react_native_1.Text style={s.emptyTitle}>{FILTER_EMPTY[filter]}</react_native_1.Text>
      <react_native_1.Text style={s.emptyBody}>
        Start a conversation, join a trip, or share a Discovery card.
      </react_native_1.Text>
      <react_native_1.View style={s.emptyActions}>
        <react_native_1.Pressable style={s.emptyBtn} onPress={function () { return expo_router_1.router.push('/discover'); }}>
          <lucide_react_native_1.Compass size={15} color={tokens_1.color.signal}/>
          <react_native_1.Text style={s.emptyBtnText}>Find people</react_native_1.Text>
        </react_native_1.Pressable>
        <react_native_1.Pressable style={s.emptyBtn} onPress={function () { return expo_router_1.router.push('/(tabs)/discovery'); }}>
          <lucide_react_native_1.Globe size={15} color={tokens_1.color.signal}/>
          <react_native_1.Text style={s.emptyBtnText}>Explore Discovery</react_native_1.Text>
        </react_native_1.Pressable>
        <react_native_1.Pressable style={s.emptyBtn} onPress={function () { return expo_router_1.router.push('/discover'); }}>
          <lucide_react_native_1.MessageCirclePlus size={15} color={tokens_1.color.signal}/>
          <react_native_1.Text style={s.emptyBtnText}>Start Telegraph</react_native_1.Text>
        </react_native_1.Pressable>
      </react_native_1.View>
    </react_native_1.View>);
}
function TelegraphInboxScreen(_a) {
    var _b = _a.topInset, topInset = _b === void 0 ? 0 : _b;
    var insets = (0, react_native_safe_area_context_1.useSafeAreaInsets)();
    var _c = (0, SessionContext_1.useSession)(), isAuthed = _c.isAuthed, userId = _c.userId;
    var _d = (0, useMessaging_1.useMyThreads)(), threads = _d.data, loading = _d.loading, error = _d.error, reload = _d.reload;
    var _e = (0, useMessaging_1.useIncomingMessageRequests)(), requests = _e.data, reqLoading = _e.loading, reloadRequests = _e.reload, acceptRequest = _e.accept, declineRequest = _e.decline;
    var _f = (0, react_1.useState)(''), search = _f[0], setSearch = _f[1];
    var _g = (0, react_1.useState)('all'), filter = _g[0], setFilter = _g[1];
    var requestCount = requests.length;
    (0, expo_router_1.useFocusEffect)((0, react_1.useCallback)(function () {
        reload();
        reloadRequests();
    }, [reload, reloadRequests]));
    var filtered = threads.filter(function (th) {
        var _a, _b, _c, _d, _e, _f, _g;
        if (filter === 'direct' && th.threadType !== 'direct')
            return false;
        if (filter === 'trips' && th.threadType !== 'trip')
            return false;
        if (filter === 'circles' && th.threadType !== 'circle')
            return false;
        if (filter === 'unread' && !(th.unreadCount && th.unreadCount > 0))
            return false;
        if (filter === 'requests')
            return false;
        if (search) {
            var q = search.toLowerCase();
            var name_1 = th.threadType !== 'direct'
                ? ((_a = th.title) !== null && _a !== void 0 ? _a : '').toLowerCase()
                : ((_c = (_b = th.otherMembers[0]) === null || _b === void 0 ? void 0 : _b.name) !== null && _c !== void 0 ? _c : '').toLowerCase();
            var body = ((_e = (_d = th.lastMessagePreview) === null || _d === void 0 ? void 0 : _d.body) !== null && _e !== void 0 ? _e : '').toLowerCase();
            var displayBody = ((_g = (_f = th.lastMessagePreview) === null || _f === void 0 ? void 0 : _f.displayBody) !== null && _g !== void 0 ? _g : '').toLowerCase();
            if (!name_1.includes(q) && !body.includes(q) && !displayBody.includes(q))
                return false;
        }
        return true;
    });
    var pt = Math.max(insets.top, topInset);
    return (<react_native_1.View style={[s.screen, { paddingTop: pt }]}>
      <react_native_1.View style={s.header}>
        <react_native_1.View style={s.brandRow}>
          <react_native_1.View style={s.brandIcon}>
            <lucide_react_native_1.Zap size={14} color={tokens_1.color.onInk} fill={tokens_1.color.onInk}/>
          </react_native_1.View>
          <react_native_1.Text style={s.brandName}>Telegraph</react_native_1.Text>
        </react_native_1.View>
      </react_native_1.View>

      {!isAuthed ? (<react_native_1.View style={s.center}>
          <react_native_1.Text style={s.emptyBody}>Sign in to view your messages.</react_native_1.Text>
        </react_native_1.View>) : (<>
          <react_native_1.View style={s.searchWrap}>
            <lucide_react_native_1.Search size={16} color={tokens_1.color.faint} style={s.searchIcon}/>
            <react_native_1.TextInput style={s.searchInput} placeholder="Search Telegraph…" placeholderTextColor={tokens_1.color.faint} value={search} onChangeText={setSearch} clearButtonMode="while-editing" returnKeyType="search"/>
          </react_native_1.View>

          <react_native_1.ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chipsRow} style={s.chipsScroll}>
            {FILTERS.map(function (f) {
                var active = filter === f.key;
                var badge = f.key === 'requests' && requestCount > 0 ? requestCount : 0;
                return (<react_native_1.Pressable key={f.key} style={[s.chip, active && s.chipActive]} onPress={function () { return setFilter(f.key); }}>
                  <react_native_1.Text style={[s.chipText, active && s.chipTextActive]}>{f.label}</react_native_1.Text>
                  {badge > 0 && (<react_native_1.View style={s.chipBadge}>
                      <react_native_1.Text style={s.chipBadgeText}>{badge > 99 ? '99+' : badge}</react_native_1.Text>
                    </react_native_1.View>)}
                </react_native_1.Pressable>);
            })}
          </react_native_1.ScrollView>

          {error ? (<react_native_1.View style={s.center}><react_native_1.Text style={[s.emptyBody, { color: '#B33' }]}>{error}</react_native_1.Text></react_native_1.View>) : loading ? (<react_native_1.View style={{ paddingTop: tokens_1.space.sm }}>
              {[0, 1, 2, 3, 4, 5].map(function (i) { return <SkeletonRow key={i}/>; })}
            </react_native_1.View>) : filter === 'requests' ? (<RequestsPane requests={requests} loading={reqLoading} onAccept={acceptRequest} onDecline={declineRequest}/>) : filtered.length === 0 ? (<EmptyState filter={filter}/>) : (<react_native_1.FlatList data={filtered} keyExtractor={function (item) { return item.id; }} contentContainerStyle={{ paddingBottom: tokens_1.space.xxxl }} renderItem={function (_a) {
                var item = _a.item;
                return <ThreadRow item={item} userId={userId}/>;
            }} ItemSeparatorComponent={function () { return <react_native_1.View style={s.sep}/>; }}/>)}
        </>)}
    </react_native_1.View>);
}
// ── Request card ──────────────────────────────────────────────────────────────
function RequestCard(_a) {
    var _b, _c, _d;
    var request = _a.request, onAccept = _a.onAccept, onDecline = _a.onDecline;
    var _e = (0, react_1.useState)(false), accepting = _e[0], setAccepting = _e[1];
    var _f = (0, react_1.useState)(false), declining = _f[0], setDeclining = _f[1];
    var _g = (0, react_1.useState)(false), blocking = _g[0], setBlocking = _g[1];
    var busy = accepting || declining || blocking;
    function handleAccept() {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        setAccepting(true);
                        return [4 /*yield*/, onAccept()];
                    case 1:
                        _a.sent();
                        setAccepting(false);
                        return [2 /*return*/];
                }
            });
        });
    }
    function handleDecline() {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        setDeclining(true);
                        return [4 /*yield*/, onDecline()];
                    case 1:
                        _a.sent();
                        setDeclining(false);
                        return [2 /*return*/];
                }
            });
        });
    }
    function handleBlock() {
        return __awaiter(this, void 0, void 0, function () {
            var _this = this;
            var _a, _b;
            return __generator(this, function (_c) {
                if (!((_a = request.sender) === null || _a === void 0 ? void 0 : _a.id))
                    return [2 /*return*/];
                react_native_1.Alert.alert('Block this person?', "".concat((_b = request.sender.name) !== null && _b !== void 0 ? _b : 'This person', " won't be able to message you or see your profile."), [
                    { text: 'Cancel', style: 'cancel' },
                    {
                        text: 'Block',
                        style: 'destructive',
                        onPress: function () { return __awaiter(_this, void 0, void 0, function () {
                            return __generator(this, function (_a) {
                                switch (_a.label) {
                                    case 0:
                                        setBlocking(true);
                                        return [4 /*yield*/, (0, blocks_1.blockUser)(request.sender.id)];
                                    case 1:
                                        _a.sent();
                                        return [4 /*yield*/, onDecline()];
                                    case 2:
                                        _a.sent(); // remove from list after block
                                        setBlocking(false);
                                        return [2 /*return*/];
                                }
                            });
                        }); },
                    },
                ]);
                return [2 /*return*/];
            });
        });
    }
    function handleReport() {
        react_native_1.Alert.alert('Report', 'Thank you — our team will review this request.');
    }
    var sender = request.sender, previewText = request.previewText, createdAt = request.createdAt;
    var initial = ((_c = (_b = sender === null || sender === void 0 ? void 0 : sender.name) === null || _b === void 0 ? void 0 : _b[0]) !== null && _c !== void 0 ? _c : '?').toUpperCase();
    return (<react_native_1.View style={rc.card}>
      {/* Header: avatar + name + time */}
      <react_native_1.View style={rc.headerRow}>
        {(sender === null || sender === void 0 ? void 0 : sender.avatarUrl) ? (<react_native_1.Image source={{ uri: sender.avatarUrl }} style={rc.avatar}/>) : (<react_native_1.View style={[rc.avatar, rc.avatarFallback]}>
            <react_native_1.Text style={rc.avatarInitial}>{initial}</react_native_1.Text>
          </react_native_1.View>)}
        <react_native_1.View style={{ flex: 1 }}>
          <react_native_1.Text style={rc.name} numberOfLines={1}>{(_d = sender === null || sender === void 0 ? void 0 : sender.name) !== null && _d !== void 0 ? _d : 'Unknown'}</react_native_1.Text>
          {(sender === null || sender === void 0 ? void 0 : sender.handle) ? (<react_native_1.Text style={rc.handle}>@{sender.handle}</react_native_1.Text>) : null}
        </react_native_1.View>
        <react_native_1.Text style={rc.time}>{timeAgo(createdAt)}</react_native_1.Text>
      </react_native_1.View>

      {/* City / language metadata */}
      {((sender === null || sender === void 0 ? void 0 : sender.city) || (sender === null || sender === void 0 ? void 0 : sender.language)) ? (<react_native_1.View style={rc.metaRow}>
          {sender.city ? <react_native_1.Text style={rc.metaChip}>{sender.city}</react_native_1.Text> : null}
          {sender.language ? <react_native_1.Text style={rc.metaChip}>{sender.language.toUpperCase()}</react_native_1.Text> : null}
        </react_native_1.View>) : null}

      {/* Message preview */}
      {previewText ? (<react_native_1.Text style={rc.preview} numberOfLines={3}>{previewText}</react_native_1.Text>) : (<react_native_1.Text style={rc.previewEmpty}>No preview available.</react_native_1.Text>)}

      {/* Primary actions: Accept + Decline */}
      <react_native_1.View style={rc.primaryRow}>
        <react_native_1.Pressable style={[rc.btn, rc.btnAccept, busy && { opacity: 0.55 }]} onPress={handleAccept} disabled={busy}>
          {accepting
            ? <react_native_1.ActivityIndicator size="small" color={tokens_1.color.onInk} style={{ marginRight: 4 }}/>
            : <lucide_react_native_1.UserCheck size={14} color={tokens_1.color.onInk}/>}
          <react_native_1.Text style={rc.btnAcceptText}>Accept</react_native_1.Text>
        </react_native_1.Pressable>
        <react_native_1.Pressable style={[rc.btn, rc.btnDecline, busy && { opacity: 0.55 }]} onPress={handleDecline} disabled={busy}>
          {declining
            ? <react_native_1.ActivityIndicator size="small" color={tokens_1.color.mute} style={{ marginRight: 4 }}/>
            : <lucide_react_native_1.UserMinus size={14} color={tokens_1.color.mute}/>}
          <react_native_1.Text style={rc.btnDeclineText}>Decline</react_native_1.Text>
        </react_native_1.Pressable>
      </react_native_1.View>

      {/* Secondary actions: Block + Report */}
      <react_native_1.View style={rc.secondaryRow}>
        <react_native_1.Pressable style={rc.secondaryBtn} onPress={handleBlock} disabled={busy}>
          <lucide_react_native_1.ShieldOff size={13} color={tokens_1.color.faint}/>
          <react_native_1.Text style={rc.secondaryBtnText}>Block</react_native_1.Text>
        </react_native_1.Pressable>
        <react_native_1.Text style={rc.secondarySep}>·</react_native_1.Text>
        <react_native_1.Pressable style={rc.secondaryBtn} onPress={handleReport} disabled={busy}>
          <lucide_react_native_1.Flag size={13} color={tokens_1.color.faint}/>
          <react_native_1.Text style={rc.secondaryBtnText}>Report</react_native_1.Text>
        </react_native_1.Pressable>
      </react_native_1.View>
    </react_native_1.View>);
}
var rc = react_native_1.StyleSheet.create({
    card: {
        marginHorizontal: tokens_1.space.xl,
        marginTop: tokens_1.space.md,
        padding: tokens_1.space.md,
        backgroundColor: tokens_1.color.paperRaised,
        borderRadius: tokens_1.radius.lg,
        borderWidth: 1,
        borderColor: tokens_1.color.haze,
        gap: tokens_1.space.sm,
    },
    headerRow: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.md },
    avatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: tokens_1.color.haze, flexShrink: 0 },
    avatarFallback: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#E8E5DE' },
    avatarInitial: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 18 }),
    name: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontWeight: '700' }),
    handle: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 12, marginTop: 1 }),
    time: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.faint, fontSize: 11 }),
    metaRow: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
    metaChip: {
        fontSize: 11,
        fontWeight: '600',
        color: tokens_1.color.deep,
        backgroundColor: '#E0EFEC',
        paddingHorizontal: 7,
        paddingVertical: 2,
        borderRadius: tokens_1.radius.sm,
        overflow: 'hidden',
    },
    preview: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute, lineHeight: 19, fontSize: 13 }),
    previewEmpty: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.faint, fontStyle: 'italic', fontSize: 12 }),
    primaryRow: { flexDirection: 'row', gap: tokens_1.space.sm, marginTop: 2 },
    btn: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 5,
        paddingVertical: 9,
        borderRadius: tokens_1.radius.md,
        borderWidth: 1,
    },
    btnAccept: { backgroundColor: tokens_1.color.signal, borderColor: tokens_1.color.signal },
    btnAcceptText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.onInk, fontWeight: '700', fontSize: 13 }),
    btnDecline: { backgroundColor: tokens_1.color.paper, borderColor: tokens_1.color.haze },
    btnDeclineText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute, fontWeight: '600', fontSize: 13 }),
    secondaryRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
    secondarySep: { color: tokens_1.color.faint, fontSize: 13 },
    secondaryBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4, paddingHorizontal: 6 },
    secondaryBtnText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.faint, fontSize: 12 }),
});
// ── Requests pane ─────────────────────────────────────────────────────────────
function RequestsPane(_a) {
    var _this = this;
    var requests = _a.requests, loading = _a.loading, onAccept = _a.onAccept, onDecline = _a.onDecline;
    if (loading) {
        return (<react_native_1.View style={s.center}>
        <react_native_1.ActivityIndicator color={tokens_1.color.signal}/>
      </react_native_1.View>);
    }
    if (requests.length === 0) {
        return (<react_native_1.View style={s.center}>
        <react_native_1.Text style={s.emptyTitle}>No pending requests</react_native_1.Text>
        <react_native_1.Text style={s.emptyBody}>
          Message requests from people you don't know yet will appear here.
        </react_native_1.Text>
      </react_native_1.View>);
    }
    // Dedup by requestId in case the API returns duplicates
    var seen = new Set();
    var uniqueRequests = requests.filter(function (r) {
        if (seen.has(r.requestId))
            return false;
        seen.add(r.requestId);
        return true;
    });
    return (<react_native_1.FlatList data={uniqueRequests} keyExtractor={function (item) { return item.requestId; }} contentContainerStyle={{ paddingBottom: tokens_1.space.xxxl }} renderItem={function (_a) {
            var item = _a.item;
            return (<RequestCard request={item} onAccept={function () { return __awaiter(_this, void 0, void 0, function () {
                    var res, name_2, params;
                    var _a, _b, _c, _d;
                    return __generator(this, function (_e) {
                        switch (_e.label) {
                            case 0: return [4 /*yield*/, onAccept(item.requestId)];
                            case 1:
                                res = _e.sent();
                                if (res.ok && ((_a = res.data) === null || _a === void 0 ? void 0 : _a.threadId)) {
                                    name_2 = (_c = (_b = item.sender) === null || _b === void 0 ? void 0 : _b.name) !== null && _c !== void 0 ? _c : 'Chat';
                                    params = new URLSearchParams({
                                        title: name_2,
                                        threadType: 'direct',
                                    });
                                    if ((_d = item.sender) === null || _d === void 0 ? void 0 : _d.id)
                                        params.set('otherUserId', item.sender.id);
                                    expo_router_1.router.push("/messages/".concat(res.data.threadId, "?").concat(params.toString()));
                                }
                                return [2 /*return*/];
                        }
                    });
                }); }} onDecline={function () { return __awaiter(_this, void 0, void 0, function () { return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, onDecline(item.requestId)];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                }
            }); }); }}/>);
        }}/>);
}
var s = react_native_1.StyleSheet.create({
    screen: { flex: 1, backgroundColor: tokens_1.color.paper },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: tokens_1.space.xl },
    header: {
        paddingHorizontal: tokens_1.space.xl,
        paddingTop: tokens_1.space.md,
        paddingBottom: tokens_1.space.sm,
    },
    brandRow: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm },
    brandIcon: {
        width: 28,
        height: 28,
        borderRadius: 8,
        backgroundColor: tokens_1.color.signal,
        alignItems: 'center',
        justifyContent: 'center',
    },
    brandName: { fontSize: 22, fontWeight: '800', color: tokens_1.color.ink, letterSpacing: -0.5 },
    searchWrap: {
        flexDirection: 'row',
        alignItems: 'center',
        marginHorizontal: tokens_1.space.xl,
        marginVertical: tokens_1.space.sm,
        backgroundColor: tokens_1.color.haze,
        borderRadius: 12,
        paddingHorizontal: tokens_1.space.md,
        height: 40,
    },
    searchIcon: { marginRight: tokens_1.space.sm },
    searchInput: __assign(__assign({ flex: 1, height: 40 }, tokens_1.type.body), { color: tokens_1.color.ink }),
    chipsScroll: { flexGrow: 0, marginBottom: tokens_1.space.sm },
    chipsRow: { paddingHorizontal: tokens_1.space.xl, gap: tokens_1.space.sm },
    chip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: tokens_1.space.md,
        paddingVertical: 6,
        borderRadius: 20,
        backgroundColor: tokens_1.color.haze,
    },
    chipActive: { backgroundColor: tokens_1.color.ink },
    chipText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontWeight: '500' }),
    chipTextActive: { color: tokens_1.color.onInk },
    chipBadge: {
        minWidth: 16,
        height: 16,
        borderRadius: 8,
        backgroundColor: tokens_1.color.signal,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 3,
    },
    chipBadgeText: { fontSize: 10, fontWeight: '700', color: tokens_1.color.onInk },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.md,
        paddingHorizontal: tokens_1.space.xl,
        paddingVertical: tokens_1.space.md,
    },
    rowPressed: { opacity: 0.6 },
    avatar: { width: 50, height: 50, borderRadius: 25, backgroundColor: tokens_1.color.haze, flexShrink: 0 },
    groupAvatar: { borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
    avatarPlaceholder: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#E8E5DE' },
    avatarInitial: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink }),
    nameRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: tokens_1.space.sm },
    nameLeft: { flexDirection: 'row', alignItems: 'center', flex: 1, gap: 5, flexShrink: 1 },
    nameMeta: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 },
    name: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, flexShrink: 1 }),
    nameBold: { fontWeight: '700' },
    time: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.faint, fontSize: 11 }),
    typeBadge: {
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 6,
    },
    typeBadgeText: { fontSize: 10, fontWeight: '600', letterSpacing: 0.2 },
    unreadBubble: {
        minWidth: 18,
        height: 18,
        borderRadius: 9,
        backgroundColor: tokens_1.color.signal,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 4,
    },
    unreadText: { fontSize: 10, fontWeight: '700', color: tokens_1.color.onInk },
    preview: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, flex: 1 }),
    previewBold: { color: tokens_1.color.ink, fontWeight: '600' },
    aiBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
        paddingHorizontal: 5,
        paddingVertical: 2,
        borderRadius: 5,
        backgroundColor: tokens_1.color.signal,
    },
    aiBadgeText: { fontSize: 9, fontWeight: '700', color: tokens_1.color.onInk, letterSpacing: 0.3 },
    cityTag: {
        alignSelf: 'flex-start',
        paddingHorizontal: 7,
        paddingVertical: 2,
        borderRadius: 6,
        backgroundColor: '#E0EFEC',
        marginTop: 1,
    },
    cityTagText: { fontSize: 10, color: tokens_1.color.deep, fontWeight: '500' },
    sep: { height: 1, backgroundColor: tokens_1.color.haze, marginHorizontal: tokens_1.space.xl, opacity: 0.5 },
    emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: tokens_1.space.xl, gap: tokens_1.space.md },
    emptyIcon: {
        width: 56,
        height: 56,
        borderRadius: 16,
        backgroundColor: '#FEF0ED',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: tokens_1.space.sm,
    },
    emptyTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, textAlign: 'center' }),
    emptyBody: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute, textAlign: 'center', lineHeight: 20 }),
    emptyActions: { gap: tokens_1.space.sm, marginTop: tokens_1.space.sm, width: '100%' },
    emptyBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.sm,
        paddingHorizontal: tokens_1.space.lg,
        paddingVertical: tokens_1.space.md,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: tokens_1.color.haze,
        backgroundColor: tokens_1.color.paperRaised,
    },
    emptyBtnText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink }),
});
