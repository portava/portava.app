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
exports.CommentsSheet = CommentsSheet;
/**
 * CommentsSheet — bottom-sheet modal for viewing and adding comments.
 *
 * - Loads comments when opened
 * - Sticky input at the bottom, keyboard-aware
 * - Optimistically appends new comment while waiting for server
 * - Safe-area aware; does not clash with bottom nav
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var react_native_safe_area_context_1 = require("react-native-safe-area-context");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../theme/tokens");
var postEngagement_1 = require("../services/postEngagement");
function timeAgo(iso) {
    var s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 60)
        return 'just now';
    var m = Math.floor(s / 60);
    if (m < 60)
        return "".concat(m, "m");
    var h = Math.floor(m / 60);
    if (h < 24)
        return "".concat(h, "h");
    return "".concat(Math.floor(h / 24), "d");
}
function AvatarFallback(_a) {
    var name = _a.name, _b = _a.size, size = _b === void 0 ? 32 : _b;
    var initials = name
        .split(' ')
        .map(function (w) { var _a; return (_a = w[0]) !== null && _a !== void 0 ? _a : ''; })
        .slice(0, 2)
        .join('')
        .toUpperCase();
    return (<react_native_1.View style={{
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: tokens_1.color.deep,
            alignItems: 'center',
            justifyContent: 'center',
        }}>
      <react_native_1.Text style={{ fontSize: size * 0.38, fontWeight: '700', color: tokens_1.color.onInk }}>
        {initials}
      </react_native_1.Text>
    </react_native_1.View>);
}
function CommentItem(_a) {
    var comment = _a.comment, onDelete = _a.onDelete;
    var _b = (0, react_1.useState)(false), imgErr = _b[0], setImgErr = _b[1];
    return (<react_native_1.View style={s.commentRow}>
      {comment.author.avatarUrl && !imgErr ? (<react_native_1.Image source={{ uri: comment.author.avatarUrl }} style={s.avatar} onError={function () { return setImgErr(true); }}/>) : (<AvatarFallback name={comment.author.name} size={32}/>)}
      <react_native_1.View style={s.commentBody}>
        <react_native_1.View style={s.commentMeta}>
          <react_native_1.Text style={s.commentAuthor}>{comment.author.name}</react_native_1.Text>
          <react_native_1.Text style={s.commentTime}>{timeAgo(comment.createdAt)}</react_native_1.Text>
        </react_native_1.View>
        <react_native_1.Text style={s.commentText}>{comment.body}</react_native_1.Text>
      </react_native_1.View>
      {comment.canDelete && (<react_native_1.Pressable hitSlop={8} onPress={function () {
                return react_native_1.Alert.alert('Delete comment?', 'This cannot be undone.', [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Delete', style: 'destructive', onPress: function () { return onDelete(comment.id); } },
                ]);
            }} style={s.deleteBtn}>
          <lucide_react_native_1.Trash2 size={14} color={tokens_1.color.faint}/>
        </react_native_1.Pressable>)}
    </react_native_1.View>);
}
function CommentsSheet(_a) {
    var _this = this;
    var visible = _a.visible, postId = _a.postId, onClose = _a.onClose, onCountChange = _a.onCountChange;
    var insets = (0, react_native_safe_area_context_1.useSafeAreaInsets)();
    var _b = (0, react_1.useState)([]), comments = _b[0], setComments = _b[1];
    var _c = (0, react_1.useState)(false), loading = _c[0], setLoading = _c[1];
    var _d = (0, react_1.useState)(''), text = _d[0], setText = _d[1];
    var _e = (0, react_1.useState)(false), submitting = _e[0], setSubmitting = _e[1];
    var inputRef = (0, react_1.useRef)(null);
    var load = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var data;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    setLoading(true);
                    return [4 /*yield*/, (0, postEngagement_1.listComments)(postId)];
                case 1:
                    data = _a.sent();
                    setComments(data);
                    setLoading(false);
                    return [2 /*return*/];
            }
        });
    }); }, [postId]);
    (0, react_1.useEffect)(function () {
        if (visible) {
            load();
            setText('');
        }
    }, [visible, load]);
    var handleSubmit = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var trimmed, result;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    trimmed = text.trim();
                    if (!trimmed || submitting)
                        return [2 /*return*/];
                    if (trimmed.length > 1000) {
                        react_native_1.Alert.alert('Too long', 'Comments must be 1000 characters or fewer.');
                        return [2 /*return*/];
                    }
                    setSubmitting(true);
                    return [4 /*yield*/, (0, postEngagement_1.addComment)(postId, trimmed)];
                case 1:
                    result = _a.sent();
                    if (result) {
                        setText('');
                        setComments(function (prev) { return __spreadArray(__spreadArray([], prev, true), [result.comment], false); });
                        onCountChange(result.commentCount);
                    }
                    else {
                        react_native_1.Alert.alert('Could not post comment', 'Please try again.');
                    }
                    setSubmitting(false);
                    return [2 /*return*/];
            }
        });
    }); }, [text, submitting, postId, onCountChange]);
    var handleDelete = (0, react_1.useCallback)(function (commentId) { return __awaiter(_this, void 0, void 0, function () {
        var result;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, postEngagement_1.deleteComment)(postId, commentId)];
                case 1:
                    result = _a.sent();
                    if (result) {
                        setComments(function (prev) { return prev.filter(function (c) { return c.id !== commentId; }); });
                        onCountChange(result.commentCount);
                    }
                    return [2 /*return*/];
            }
        });
    }); }, [postId, onCountChange]);
    return (<react_native_1.Modal visible={visible} animationType="slide" transparent onRequestClose={onClose} statusBarTranslucent>
      <react_native_1.Pressable style={s.backdrop} onPress={onClose}/>
      <react_native_1.KeyboardAvoidingView behavior={react_native_1.Platform.OS === 'ios' ? 'padding' : 'height'} style={s.sheetWrapper} keyboardVerticalOffset={0}>
        <react_native_1.View style={[s.sheet, { paddingBottom: insets.bottom + tokens_1.space.sm }]}>
          {/* Header */}
          <react_native_1.View style={s.header}>
            <react_native_1.Text style={s.title}>Comments</react_native_1.Text>
            <react_native_1.Pressable onPress={onClose} hitSlop={10}>
              <lucide_react_native_1.X size={20} color={tokens_1.color.ink}/>
            </react_native_1.Pressable>
          </react_native_1.View>

          {/* Comments list */}
          {loading ? (<react_native_1.View style={s.center}>
              <react_native_1.ActivityIndicator color={tokens_1.color.signal}/>
            </react_native_1.View>) : (<react_native_1.FlatList data={comments} keyExtractor={function (c) { return c.id; }} renderItem={function (_a) {
                var item = _a.item;
                return (<CommentItem comment={item} onDelete={handleDelete}/>);
            }} ListEmptyComponent={<react_native_1.View style={s.center}>
                  <react_native_1.Text style={s.empty}>No comments yet. Start the conversation.</react_native_1.Text>
                </react_native_1.View>} contentContainerStyle={s.listContent} showsVerticalScrollIndicator={false} style={s.list} keyboardShouldPersistTaps="handled"/>)}

          {/* Input row */}
          <react_native_1.View style={s.inputRow}>
            <react_native_1.TextInput ref={inputRef} style={s.input} value={text} onChangeText={setText} placeholder="Add a comment…" placeholderTextColor={tokens_1.color.faint} multiline maxLength={1000} returnKeyType="default" blurOnSubmit={false}/>
            <react_native_1.Pressable style={[s.sendBtn, (!text.trim() || submitting) && s.sendBtnDisabled]} onPress={handleSubmit} disabled={!text.trim() || submitting} hitSlop={8}>
              {submitting ? (<react_native_1.ActivityIndicator size="small" color={tokens_1.color.onInk}/>) : (<lucide_react_native_1.SendHorizonal size={18} color={tokens_1.color.onInk}/>)}
            </react_native_1.Pressable>
          </react_native_1.View>
        </react_native_1.View>
      </react_native_1.KeyboardAvoidingView>
    </react_native_1.Modal>);
}
var s = react_native_1.StyleSheet.create({
    backdrop: __assign(__assign({}, react_native_1.StyleSheet.absoluteFillObject), { backgroundColor: 'rgba(17,17,15,0.45)' }),
    sheetWrapper: {
        flex: 1,
        justifyContent: 'flex-end',
    },
    sheet: __assign({ backgroundColor: tokens_1.color.paperRaised, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '88%', minHeight: 320 }, tokens_1.shadow.card),
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: tokens_1.space.lg,
        paddingTop: tokens_1.space.md,
        paddingBottom: tokens_1.space.sm,
        borderBottomWidth: 1,
        borderBottomColor: tokens_1.color.haze,
    },
    title: {
        fontSize: 16,
        fontWeight: '700',
        color: tokens_1.color.ink,
    },
    list: {
        flex: 1,
    },
    listContent: {
        flexGrow: 1,
        paddingHorizontal: tokens_1.space.lg,
        paddingVertical: tokens_1.space.md,
        gap: tokens_1.space.lg,
    },
    center: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: tokens_1.space.xxxl,
    },
    empty: {
        fontSize: 14,
        color: tokens_1.color.faint,
        textAlign: 'center',
        paddingHorizontal: tokens_1.space.xl,
    },
    commentRow: {
        flexDirection: 'row',
        gap: tokens_1.space.sm,
        alignItems: 'flex-start',
    },
    avatar: {
        width: 32,
        height: 32,
        borderRadius: 16,
        backgroundColor: tokens_1.color.haze,
    },
    commentBody: {
        flex: 1,
        gap: 3,
    },
    commentMeta: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.sm,
    },
    commentAuthor: {
        fontSize: 13,
        fontWeight: '700',
        color: tokens_1.color.ink,
    },
    commentTime: {
        fontSize: 11,
        color: tokens_1.color.faint,
    },
    commentText: {
        fontSize: 14,
        color: tokens_1.color.ink,
        lineHeight: 20,
    },
    deleteBtn: {
        paddingTop: 2,
        paddingLeft: tokens_1.space.sm,
    },
    inputRow: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        gap: tokens_1.space.sm,
        paddingHorizontal: tokens_1.space.lg,
        paddingTop: tokens_1.space.sm,
        borderTopWidth: 1,
        borderTopColor: tokens_1.color.haze,
    },
    input: {
        flex: 1,
        minHeight: 40,
        maxHeight: 100,
        borderWidth: 1.5,
        borderColor: tokens_1.color.haze,
        borderRadius: tokens_1.radius.md,
        paddingHorizontal: tokens_1.space.md,
        paddingTop: 10,
        paddingBottom: 10,
        fontSize: 14,
        color: tokens_1.color.ink,
        backgroundColor: tokens_1.color.paper,
    },
    sendBtn: {
        width: 40,
        height: 40,
        borderRadius: 20,
        backgroundColor: tokens_1.color.signal,
        alignItems: 'center',
        justifyContent: 'center',
    },
    sendBtnDisabled: {
        backgroundColor: tokens_1.color.haze,
    },
});
