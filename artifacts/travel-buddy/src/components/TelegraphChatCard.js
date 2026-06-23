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
exports.TelegraphChatCard = TelegraphChatCard;
/**
 * TelegraphChatCard — compact suggestion card shown in the chat tray.
 * Shows title, reason, category chip, optional location/time context,
 * and action buttons. Fails silently if any press handler throws.
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../theme/tokens");
var CATEGORY_COLORS = {
    food: '#F97316',
    nightlife: '#8B5CF6',
    beach: '#0EA5E9',
    attraction: '#10B981',
    transport: '#6B7280',
    meetup: tokens_1.color.signal,
    poll: '#EC4899',
    plan: '#F59E0B',
    availability: '#14B8A6',
    activity: '#6366F1',
};
var ACTION_LABELS = {
    add_to_plan: 'Add to Plan',
    create_meetup: 'Create Meetup',
    start_time_poll: 'Start Poll',
    view_place: 'View Ideas',
};
function TelegraphChatCard(_a) {
    var _b, _c;
    var suggestion = _a.suggestion, onDismiss = _a.onDismiss, onAction = _a.onAction;
    var _d = (0, react_1.useState)(false), acting = _d[0], setActing = _d[1];
    var chipColor = (_b = CATEGORY_COLORS[suggestion.category]) !== null && _b !== void 0 ? _b : CATEGORY_COLORS.activity;
    var actionLabel = (_c = ACTION_LABELS[suggestion.action_type]) !== null && _c !== void 0 ? _c : 'View';
    function handleAction() {
        return __awaiter(this, void 0, void 0, function () {
            var _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        if (acting)
                            return [2 /*return*/];
                        setActing(true);
                        _b.label = 1;
                    case 1:
                        _b.trys.push([1, 3, 4, 5]);
                        return [4 /*yield*/, onAction(suggestion)];
                    case 2:
                        _b.sent();
                        return [3 /*break*/, 5];
                    case 3:
                        _a = _b.sent();
                        return [3 /*break*/, 5];
                    case 4:
                        setActing(false);
                        return [7 /*endfinally*/];
                    case 5: return [2 /*return*/];
                }
            });
        });
    }
    return (<react_native_1.View style={styles.card}>
      {/* Header row */}
      <react_native_1.View style={styles.headerRow}>
        <react_native_1.View style={styles.zapBadge}>
          <lucide_react_native_1.Zap size={10} color={tokens_1.color.onInk} fill={tokens_1.color.onInk}/>
        </react_native_1.View>
        <react_native_1.Text style={styles.brandLabel}>Telegraph suggestion</react_native_1.Text>
        <react_native_1.View style={[styles.chip, { backgroundColor: chipColor + '22' }]}>
          <react_native_1.Text style={[styles.chipText, { color: chipColor }]}>
            {suggestion.category}
          </react_native_1.Text>
        </react_native_1.View>
        <react_native_1.Pressable style={styles.dismissBtn} onPress={function () { return onDismiss(suggestion.id); }} hitSlop={8}>
          <lucide_react_native_1.X size={14} color={tokens_1.color.mute}/>
        </react_native_1.Pressable>
      </react_native_1.View>

      {/* Title */}
      <react_native_1.Text style={styles.title} numberOfLines={2}>
        {suggestion.title}
      </react_native_1.Text>

      {/* Reason */}
      <react_native_1.Text style={styles.reason} numberOfLines={2}>
        {suggestion.reason}
      </react_native_1.Text>

      {/* Context row */}
      {(suggestion.location_context || suggestion.time_context) && (<react_native_1.View style={styles.contextRow}>
          {suggestion.location_context && (<react_native_1.View style={styles.contextItem}>
              <lucide_react_native_1.MapPin size={11} color={tokens_1.color.mute}/>
              <react_native_1.Text style={styles.contextText} numberOfLines={1}>
                {suggestion.location_context}
              </react_native_1.Text>
            </react_native_1.View>)}
          {suggestion.time_context && (<react_native_1.View style={styles.contextItem}>
              <lucide_react_native_1.Clock size={11} color={tokens_1.color.mute}/>
              <react_native_1.Text style={styles.contextText}>{suggestion.time_context}</react_native_1.Text>
            </react_native_1.View>)}
        </react_native_1.View>)}

      {/* Action button */}
      <react_native_1.Pressable style={[styles.actionBtn, acting && { opacity: 0.6 }]} onPress={handleAction} disabled={acting}>
        {acting ? (<react_native_1.ActivityIndicator size="small" color={tokens_1.color.onInk}/>) : (<react_native_1.Text style={styles.actionLabel}>{actionLabel}</react_native_1.Text>)}
      </react_native_1.Pressable>
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    card: {
        backgroundColor: tokens_1.color.paperRaised,
        borderRadius: tokens_1.radius.lg,
        borderWidth: 1,
        borderColor: tokens_1.color.signal + '33',
        padding: tokens_1.space.md,
        gap: 6,
    },
    headerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    zapBadge: {
        width: 16,
        height: 16,
        borderRadius: 4,
        backgroundColor: tokens_1.color.signal,
        alignItems: 'center',
        justifyContent: 'center',
    },
    brandLabel: __assign(__assign({}, tokens_1.type.stamp), { fontFamily: 'Courier', fontSize: 10, color: tokens_1.color.signal, letterSpacing: 0.3, flex: 1 }),
    chip: {
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 10,
    },
    chipText: {
        fontSize: 10,
        fontWeight: '600',
        fontFamily: 'Courier',
        textTransform: 'uppercase',
        letterSpacing: 0.3,
    },
    dismissBtn: {
        padding: 2,
    },
    title: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 14, fontWeight: '700', lineHeight: 18 }),
    reason: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 12, lineHeight: 16 }),
    contextRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 10,
        marginTop: 2,
    },
    contextItem: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 3,
    },
    contextText: __assign(__assign({}, tokens_1.type.stamp), { fontFamily: 'Courier', fontSize: 11, color: tokens_1.color.mute }),
    actionBtn: {
        marginTop: 4,
        backgroundColor: tokens_1.color.signal,
        borderRadius: tokens_1.radius.md,
        paddingVertical: 8,
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 34,
    },
    actionLabel: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.onInk, fontSize: 13, fontWeight: '700' }),
});
