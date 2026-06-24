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
exports.HighlightViewer = HighlightViewer;
/**
 * HighlightViewer — full-screen modal highlight player.
 *
 * Shows an ordered list of active highlights (for one user or multiple).
 * Features:
 *   - Segmented progress bar per item (5s for images; video duration for clips)
 *   - Tap right → next, tap left → prev
 *   - Like button, reply button, report, close
 *   - POST /highlights/:id/view on each item shown
 *   - Owner sees "👁 N" chip → opens HighlightViewersSheet
 *   - Videos play natively via expo-av; progress driven by onPlaybackStatusUpdate
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_av_1 = require("expo-av");
var filters_1 = require("../lib/media/filters");
var lucide_react_native_1 = require("lucide-react-native");
var react_native_safe_area_context_1 = require("react-native-safe-area-context");
var expo_router_1 = require("expo-router");
var Sharing = require("expo-sharing");
var tokens_1 = require("../theme/tokens");
var highlights_1 = require("../services/highlights");
var messaging_1 = require("../services/messaging");
var useHighlightRingState_1 = require("../hooks/useHighlightRingState");
var HighlightViewersSheet_1 = require("./HighlightViewersSheet");
var SCREEN_W = react_native_1.Dimensions.get('window').width;
var ITEM_DURATION_MS = 5000;
var HIT_SLOP = { top: 12, bottom: 12, left: 12, right: 12 };
function HighlightViewer(_a) {
    var _this = this;
    var _b, _c, _d, _e, _f, _g;
    var visible = _a.visible, highlights = _a.highlights, _h = _a.startIndex, startIndex = _h === void 0 ? 0 : _h, currentUserId = _a.currentUserId, onClose = _a.onClose, onHighlightChange = _a.onHighlightChange, onAddHighlight = _a.onAddHighlight, onDeleted = _a.onDeleted;
    var insets = (0, react_native_safe_area_context_1.useSafeAreaInsets)();
    var _j = (0, react_1.useState)(startIndex), index = _j[0], setIndex = _j[1];
    var _k = (0, react_1.useState)(0), progress = _k[0], setProgress = _k[1];
    var _l = (0, react_1.useState)(false), paused = _l[0], setPaused = _l[1];
    var _m = (0, react_1.useState)(highlights), localHighlights = _m[0], setLocalHighlights = _m[1];
    var _o = (0, react_1.useState)({}), likeMap = _o[0], setLikeMap = _o[1];
    var _p = (0, react_1.useState)(false), viewersOpen = _p[0], setViewersOpen = _p[1];
    var _q = (0, react_1.useState)(false), replyOpen = _q[0], setReplyOpen = _q[1];
    var _r = (0, react_1.useState)(''), replyText = _r[0], setReplyText = _r[1];
    var _s = (0, react_1.useState)(false), replying = _s[0], setReplying = _s[1];
    // Mute state for video highlights. As component state it survives index
    // changes, so the choice carries forward as highlights advance and persists
    // for the session (not reset when the viewer reopens).
    var _t = (0, react_1.useState)(false), isMuted = _t[0], setIsMuted = _t[1];
    var intervalRef = (0, react_1.useRef)(null);
    var videoRef = (0, react_1.useRef)(null);
    // goNextRef lets the stable handleVideoStatus callback call the latest goNext
    var goNextRef = (0, react_1.useRef)(function () { });
    var current = localHighlights[index];
    var isOwner = (current === null || current === void 0 ? void 0 : current.ownerId) === currentUserId;
    var isVideo = ((_b = current === null || current === void 0 ? void 0 : current.mediaType) !== null && _b !== void 0 ? _b : '').startsWith('video/');
    // Reset when visible/startIndex changes; mark all circle highlights read when viewer opens.
    (0, react_1.useEffect)(function () {
        if (visible) {
            setLocalHighlights(highlights);
            setIndex(startIndex);
            setProgress(0);
            setPaused(false);
            setReplyOpen(false);
            setReplyText('');
            var map = {};
            for (var _i = 0, highlights_2 = highlights; _i < highlights_2.length; _i++) {
                var h = highlights_2[_i];
                map[h.id] = { liked: h.likedByMe, count: h.likeCount };
            }
            setLikeMap(map);
            // Best-effort: advance the highlights_last_viewed_at cursor so the
            // Explore tab badge clears after the user opens any highlight viewer.
            (0, messaging_1.markHighlightsViewed)().catch(function () { });
        }
    }, [visible, startIndex, highlights]);
    // Mark viewed when item shown — both local ring state and server-side
    (0, react_1.useEffect)(function () {
        if (!visible || !current)
            return;
        (0, useHighlightRingState_1.markViewed)(current.id, current.expiresAt);
        (0, highlights_1.markHighlightViewed)(current.id);
    }, [visible, current === null || current === void 0 ? void 0 : current.id]);
    // Keep goNextRef current on every render so handleVideoStatus always calls
    // the latest version without a stale closure.
    goNextRef.current = goNext;
    // Progress timer — images only. Videos drive progress via onPlaybackStatusUpdate.
    (0, react_1.useEffect)(function () {
        if (!visible || paused || isVideo) {
            if (intervalRef.current)
                clearInterval(intervalRef.current);
            return;
        }
        if (intervalRef.current)
            clearInterval(intervalRef.current);
        setProgress(0);
        var tickMs = 50;
        intervalRef.current = setInterval(function () {
            setProgress(function (p) {
                var next = p + tickMs / ITEM_DURATION_MS;
                if (next >= 1) {
                    clearInterval(intervalRef.current);
                    goNextRef.current();
                    return 1;
                }
                return next;
            });
        }, tickMs);
        return function () { if (intervalRef.current)
            clearInterval(intervalRef.current); };
    }, [visible, index, paused, isVideo]);
    // Reset video progress when navigating to a new item
    (0, react_1.useEffect)(function () {
        if (isVideo)
            setProgress(0);
    }, [index, isVideo]);
    // Video playback status — drives progress bar and auto-advance for video items
    var handleVideoStatus = (0, react_1.useCallback)(function (status) {
        if (!status.isLoaded)
            return;
        var dur = status.durationMillis;
        if (dur && dur > 0) {
            setProgress(status.positionMillis / dur);
        }
        if (status.didJustFinish) {
            goNextRef.current();
        }
    }, []);
    function goNext() {
        if (index < localHighlights.length - 1) {
            var next = index + 1;
            setIndex(next);
            setProgress(0);
            onHighlightChange === null || onHighlightChange === void 0 ? void 0 : onHighlightChange(next);
        }
        else {
            onClose();
        }
    }
    function handleDelete() {
        return __awaiter(this, void 0, void 0, function () {
            var _this = this;
            return __generator(this, function (_a) {
                if (!current || !isOwner)
                    return [2 /*return*/];
                react_native_1.Alert.alert('Delete Highlight', 'Remove this highlight? This can\u2019t be undone.', [
                    { text: 'Cancel', style: 'cancel' },
                    {
                        text: 'Delete',
                        style: 'destructive',
                        onPress: function () { return __awaiter(_this, void 0, void 0, function () {
                            var ownerId, result, remaining;
                            var _a;
                            return __generator(this, function (_b) {
                                switch (_b.label) {
                                    case 0:
                                        ownerId = current.ownerId;
                                        return [4 /*yield*/, (0, highlights_1.deleteHighlight)(current.id)];
                                    case 1:
                                        result = _b.sent();
                                        if (!result.ok) {
                                            react_native_1.Alert.alert('Could not delete', (_a = result.message) !== null && _a !== void 0 ? _a : 'Please try again.');
                                            return [2 /*return*/];
                                        }
                                        (0, useHighlightRingState_1.invalidateHighlightCache)(ownerId);
                                        onDeleted === null || onDeleted === void 0 ? void 0 : onDeleted();
                                        remaining = localHighlights.filter(function (h) { return h.id !== current.id; });
                                        if (remaining.length === 0) {
                                            onClose();
                                        }
                                        else {
                                            setLocalHighlights(remaining);
                                            setIndex(function (i) { return Math.min(i, remaining.length - 1); });
                                            setProgress(0);
                                        }
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
    var toggleMute = (0, react_1.useCallback)(function () {
        setIsMuted(function (m) { return !m; });
    }, []);
    function goPrev() {
        if (index > 0) {
            var prev = index - 1;
            setIndex(prev);
            setProgress(0);
            onHighlightChange === null || onHighlightChange === void 0 ? void 0 : onHighlightChange(prev);
        }
    }
    var handleLike = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var prev, nextLiked, nextCount, r;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (!current)
                        return [2 /*return*/];
                    prev = (_a = likeMap[current.id]) !== null && _a !== void 0 ? _a : { liked: current.likedByMe, count: current.likeCount };
                    nextLiked = !prev.liked;
                    nextCount = Math.max(0, prev.count + (nextLiked ? 1 : -1));
                    setLikeMap(function (m) {
                        var _a;
                        return (__assign(__assign({}, m), (_a = {}, _a[current.id] = { liked: nextLiked, count: nextCount }, _a)));
                    });
                    return [4 /*yield*/, (0, highlights_1.toggleHighlightLike)(current.id, prev.liked)];
                case 1:
                    r = _b.sent();
                    if (r.ok && r.data) {
                        setLikeMap(function (m) {
                            var _a;
                            return (__assign(__assign({}, m), (_a = {}, _a[current.id] = { liked: r.data.likedByMe, count: r.data.likeCount }, _a)));
                        });
                    }
                    else {
                        setLikeMap(function (m) {
                            var _a;
                            return (__assign(__assign({}, m), (_a = {}, _a[current.id] = prev, _a)));
                        });
                    }
                    return [2 /*return*/];
            }
        });
    }); }, [current, likeMap]);
    function handleReply() {
        return __awaiter(this, void 0, void 0, function () {
            var r;
            var _a, _b;
            return __generator(this, function (_c) {
                switch (_c.label) {
                    case 0:
                        if (!current || !replyText.trim() || replying)
                            return [2 /*return*/];
                        setReplying(true);
                        _c.label = 1;
                    case 1:
                        _c.trys.push([1, , 3, 4]);
                        return [4 /*yield*/, (0, highlights_1.replyToHighlight)(current.id, replyText.trim())];
                    case 2:
                        r = _c.sent();
                        if (r.ok && ((_a = r.data) === null || _a === void 0 ? void 0 : _a.threadId)) {
                            setReplyOpen(false);
                            setReplyText('');
                            onClose();
                            expo_router_1.router.push("/messages/".concat(r.data.threadId));
                        }
                        else {
                            react_native_1.Alert.alert('Could not send reply', (_b = r.message) !== null && _b !== void 0 ? _b : 'Try again.');
                        }
                        return [3 /*break*/, 4];
                    case 3:
                        setReplying(false);
                        return [7 /*endfinally*/];
                    case 4: return [2 /*return*/];
                }
            });
        });
    }
    function handleReport() {
        if (!current)
            return;
        react_native_1.Alert.alert('Report Highlight', 'Why are you reporting this?', [
            { text: 'Inappropriate', onPress: function () { return (0, highlights_1.reportHighlight)(current.id, 'inappropriate').then(function () { return react_native_1.Alert.alert('Reported', 'Thank you.'); }); } },
            { text: 'Spam', onPress: function () { return (0, highlights_1.reportHighlight)(current.id, 'spam').then(function () { return react_native_1.Alert.alert('Reported', 'Thank you.'); }); } },
            { text: 'Cancel', style: 'cancel' },
        ]);
    }
    if (!visible || !current)
        return null;
    var likeState = (_c = likeMap[current.id]) !== null && _c !== void 0 ? _c : { liked: current.likedByMe, count: current.likeCount };
    var locLabel = [(_d = current.locationName) !== null && _d !== void 0 ? _d : current.locationCity, current.locationCountry].filter(Boolean).join(', ');
    var isVideoHighlight = ((_e = current.mediaType) !== null && _e !== void 0 ? _e : '').startsWith('video/');
    var hasFilter = current.filterId && current.filterId !== 'original';
    var shouldApplyFilter = isVideoHighlight && hasFilter;
    var cssFilter = shouldApplyFilter
        ? (0, filters_1.buildCssFilter)((0, filters_1.getMediaFilter)(current.filterId), (_f = current.filterIntensity) !== null && _f !== void 0 ? _f : 100)
        : 'none';
    return (<react_native_1.Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <react_native_1.View style={s.container}>
        {/* Media — native video player for clips, Image for photos */}
        {isVideo ? (<expo_av_1.Video key={current.id} ref={videoRef} source={{ uri: current.mediaUrl }} style={[
                react_native_1.StyleSheet.absoluteFill,
                shouldApplyFilter && react_native_1.Platform.OS === 'web' ? { filter: cssFilter } : undefined,
            ]} resizeMode={expo_av_1.ResizeMode.COVER} shouldPlay={!paused} isLooping={false} isMuted={isMuted} useNativeControls={false} onPlaybackStatusUpdate={handleVideoStatus}/>) : (<react_native_1.Image source={{ uri: current.mediaUrl }} style={react_native_1.StyleSheet.absoluteFill} resizeMode="cover"/>)}

        {/* Progress bars */}
        <react_native_1.View style={[s.progressRow, { marginTop: insets.top + 8 }]}>
          {localHighlights.map(function (h, i) { return (<react_native_1.View key={h.id} style={s.progressTrack}>
              <react_native_1.View style={[
                s.progressFill,
                { width: "".concat(i < index ? 100 : i === index ? Math.round(progress * 100) : 0, "%") },
            ]}/>
            </react_native_1.View>); })}
        </react_native_1.View>

        {/* Top row: author + close */}
        <react_native_1.View style={s.topRow}>
          {current.author && (<react_native_1.View style={s.authorRow}>
              <react_native_1.Image source={{ uri: (_g = current.author.avatarUrl) !== null && _g !== void 0 ? _g : undefined }} style={s.avatar}/>
              <react_native_1.View>
                <react_native_1.Text style={s.authorName}>{current.author.name}</react_native_1.Text>
                {locLabel ? <react_native_1.Text style={s.locText}>{locLabel}</react_native_1.Text> : null}
              </react_native_1.View>
              <react_native_1.View style={s.timeChip}>
                <react_native_1.Text style={s.timeText}>{fmtExpiry(current.expiresAt)}</react_native_1.Text>
              </react_native_1.View>
            </react_native_1.View>)}
          <react_native_1.View style={{ flex: 1 }}/>
          {isVideo && (<react_native_1.Pressable onPress={toggleMute} hitSlop={8} style={[s.closeBtn, s.muteBtn]} accessibilityRole="button" accessibilityLabel={isMuted ? 'Unmute video' : 'Mute video'}>
              {isMuted ? <lucide_react_native_1.VolumeX size={20} color="#fff"/> : <lucide_react_native_1.Volume2 size={20} color="#fff"/>}
            </react_native_1.Pressable>)}
          {isOwner && onAddHighlight && (<react_native_1.Pressable onPress={onAddHighlight} hitSlop={8} style={[s.closeBtn, s.addBtn]}>
              <lucide_react_native_1.Plus size={20} color="#fff"/>
            </react_native_1.Pressable>)}
          <react_native_1.Pressable onPress={onClose} hitSlop={8} style={s.closeBtn}>
            <lucide_react_native_1.X size={20} color="#fff"/>
          </react_native_1.Pressable>
        </react_native_1.View>

        {/* Tap zones */}
        <react_native_1.View style={s.tapZones} pointerEvents="box-none">
          <react_native_1.Pressable style={s.tapLeft} onPress={goPrev} onLongPress={function () { return setPaused(true); }} onPressOut={function () { return setPaused(false); }}/>
          <react_native_1.Pressable style={s.tapRight} onPress={goNext} onLongPress={function () { return setPaused(true); }} onPressOut={function () { return setPaused(false); }}/>
        </react_native_1.View>

        {/* Bottom: caption + actions */}
        <react_native_1.View style={[s.bottom, { paddingBottom: Math.max(insets.bottom, 24) }]}>
          {current.caption ? (<react_native_1.Text style={s.caption} numberOfLines={3}>{current.caption}</react_native_1.Text>) : null}

          {replyOpen && (<react_native_1.View style={s.replyRow}>
              <react_native_1.TextInput style={s.replyInput} placeholder="Send a reply…" placeholderTextColor="rgba(255,255,255,0.5)" value={replyText} onChangeText={setReplyText} autoFocus returnKeyType="send" onSubmitEditing={handleReply}/>
              <react_native_1.Pressable onPress={handleReply} disabled={replying || !replyText.trim()} style={s.replyBtn}>
                {replying
                ? <react_native_1.ActivityIndicator size="small" color="#fff"/>
                : <react_native_1.Text style={s.replyBtnText}>Send</react_native_1.Text>}
              </react_native_1.Pressable>
            </react_native_1.View>)}

          <react_native_1.View style={s.actions}>
            {!isOwner && (<react_native_1.Pressable onPress={handleLike} style={s.actionBtn} hitSlop={HIT_SLOP}>
                <lucide_react_native_1.Heart size={24} color={likeState.liked ? tokens_1.color.signal : '#fff'} fill={likeState.liked ? tokens_1.color.signal : 'transparent'}/>
                {likeState.count > 0 && <react_native_1.Text style={s.actionCount}>{likeState.count}</react_native_1.Text>}
              </react_native_1.Pressable>)}

            {!isOwner && !replyOpen && (<react_native_1.Pressable onPress={function () { return setReplyOpen(true); }} style={s.actionBtn} hitSlop={HIT_SLOP}>
                <lucide_react_native_1.MessageCircle size={24} color="#fff"/>
              </react_native_1.Pressable>)}

            {isOwner && (<react_native_1.Pressable onPress={function () { return setViewersOpen(true); }} style={s.actionBtn}>
                <lucide_react_native_1.Eye size={22} color="#fff"/>
                <react_native_1.Text style={s.actionCount}>{current.viewCount}</react_native_1.Text>
              </react_native_1.Pressable>)}

            {isOwner && (<react_native_1.Pressable onPress={handleDelete} style={s.actionBtn} hitSlop={HIT_SLOP}>
                <lucide_react_native_1.Trash2 size={20} color="rgba(255,255,255,0.7)"/>
              </react_native_1.Pressable>)}

            {!isOwner && (current.visibility === 'public' || current.visibility === 'travelers_nearby') && (<react_native_1.Pressable onPress={function () { return __awaiter(_this, void 0, void 0, function () {
                var available;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, Sharing.isAvailableAsync()];
                        case 1:
                            available = _a.sent();
                            if (!available) return [3 /*break*/, 3];
                            return [4 /*yield*/, Sharing.shareAsync(current.mediaUrl, { mimeType: current.mediaType })];
                        case 2:
                            _a.sent();
                            return [3 /*break*/, 4];
                        case 3:
                            react_native_1.Alert.alert('Sharing not available on this device');
                            _a.label = 4;
                        case 4: return [2 /*return*/];
                    }
                });
            }); }} style={s.actionBtn} hitSlop={HIT_SLOP}>
                <lucide_react_native_1.Share2 size={20} color="rgba(255,255,255,0.85)"/>
              </react_native_1.Pressable>)}

            {!isOwner && (<react_native_1.Pressable onPress={handleReport} style={s.actionBtn} hitSlop={HIT_SLOP}>
                <lucide_react_native_1.Flag size={20} color="rgba(255,255,255,0.7)"/>
              </react_native_1.Pressable>)}
          </react_native_1.View>
        </react_native_1.View>
      </react_native_1.View>

      <HighlightViewersSheet_1.HighlightViewersSheet visible={viewersOpen} highlightId={current.id} onClose={function () { return setViewersOpen(false); }}/>
    </react_native_1.Modal>);
}
function fmtExpiry(expiresAt) {
    var diff = Math.max(0, new Date(expiresAt).getTime() - Date.now());
    var hrs = Math.floor(diff / 3600000);
    var mins = Math.floor((diff % 3600000) / 60000);
    if (hrs > 0)
        return "".concat(hrs, "h left");
    return "".concat(mins, "m left");
}
var s = react_native_1.StyleSheet.create({
    container: { flex: 1, backgroundColor: '#000' },
    progressRow: {
        position: 'absolute',
        top: 0,
        left: tokens_1.space.md,
        right: tokens_1.space.md,
        flexDirection: 'row',
        gap: 3,
        zIndex: 10,
    },
    progressTrack: {
        flex: 1,
        height: 2.5,
        backgroundColor: 'rgba(255,255,255,0.3)',
        borderRadius: 2,
        overflow: 'hidden',
    },
    progressFill: {
        height: '100%',
        backgroundColor: '#fff',
        borderRadius: 2,
    },
    topRow: {
        position: 'absolute',
        left: tokens_1.space.md,
        right: tokens_1.space.md,
        top: 42,
        flexDirection: 'row',
        alignItems: 'center',
        zIndex: 10,
    },
    authorRow: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm, flex: 1 },
    avatar: { width: 36, height: 36, borderRadius: 18, borderWidth: 1.5, borderColor: '#fff', backgroundColor: '#333' },
    authorName: { color: '#fff', fontWeight: '700', fontSize: 14 },
    locText: { color: 'rgba(255,255,255,0.8)', fontSize: 11, marginTop: 1 },
    timeChip: { backgroundColor: 'rgba(17,17,15,0.5)', paddingHorizontal: 7, paddingVertical: 3, borderRadius: tokens_1.radius.sm },
    timeText: { color: '#fff', fontSize: 11, fontFamily: 'Courier', fontWeight: '700' },
    closeBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(17,17,15,0.4)' },
    addBtn: { marginRight: 8 },
    muteBtn: { marginRight: 8 },
    tapZones: __assign(__assign({}, react_native_1.StyleSheet.absoluteFillObject), { flexDirection: 'row', zIndex: 5 }),
    tapLeft: { flex: 1 },
    tapRight: { flex: 1 },
    bottom: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        padding: tokens_1.space.lg,
        gap: tokens_1.space.md,
        zIndex: 10,
        backgroundColor: 'rgba(0,0,0,0.0)',
    },
    caption: {
        color: '#fff',
        fontSize: 15,
        fontWeight: '500',
        lineHeight: 21,
        textShadowColor: 'rgba(0,0,0,0.7)',
        textShadowOffset: { width: 0, height: 1 },
        textShadowRadius: 3,
    },
    actions: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.lg },
    actionBtn: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    actionCount: { color: '#fff', fontSize: 13, fontWeight: '700' },
    replyRow: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm },
    replyInput: {
        flex: 1,
        color: '#fff',
        fontSize: 14,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.4)',
        borderRadius: tokens_1.radius.pill,
        paddingHorizontal: tokens_1.space.md,
        paddingVertical: 8,
        backgroundColor: 'rgba(17,17,15,0.4)',
    },
    replyBtn: { backgroundColor: tokens_1.color.signal, borderRadius: tokens_1.radius.pill, paddingHorizontal: tokens_1.space.md, paddingVertical: 8 },
    replyBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
});
