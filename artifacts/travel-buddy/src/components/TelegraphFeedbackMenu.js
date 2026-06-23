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
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.TelegraphFeedbackMenu = TelegraphFeedbackMenu;
/**
 * TelegraphFeedbackMenu — feedback controls for recommendation cards.
 * "More like this", "Less like this", "Not for me", "Save", "Dismiss"
 *
 * Auth token is obtained internally by the intelligence service.
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../theme/tokens");
var intelligence_1 = require("../services/intelligence");
var OPTIONS = [
    { label: 'More like this', signal: 'more_like_this', icon: lucide_react_native_1.ThumbsUp, tint: tokens_1.color.deep },
    { label: 'Less like this', signal: 'less_like_this', icon: lucide_react_native_1.ThumbsDown, tint: tokens_1.color.mute },
    { label: 'Not for me', signal: 'not_for_me', icon: lucide_react_native_1.X, tint: tokens_1.color.signal },
    { label: 'Save', signal: 'save', icon: lucide_react_native_1.Heart, tint: (_a = tokens_1.color.success) !== null && _a !== void 0 ? _a : tokens_1.color.deep },
    { label: 'Dismiss', signal: 'dismiss', icon: lucide_react_native_1.EyeOff, tint: tokens_1.color.mute },
];
function TelegraphFeedbackMenu(_a) {
    var recommendationId = _a.recommendationId, category = _a.category, tripId = _a.tripId, onDismiss = _a.onDismiss, onSave = _a.onSave;
    var _b = (0, react_1.useState)(false), open = _b[0], setOpen = _b[1];
    var _c = (0, react_1.useState)(null), sent = _c[0], setSent = _c[1];
    function handleSelect(option) {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        setOpen(false);
                        setSent(option.signal);
                        return [4 /*yield*/, (0, intelligence_1.sendFeedback)(recommendationId, category, option.signal, tripId)];
                    case 1:
                        _a.sent();
                        if (option.signal === 'dismiss' || option.signal === 'not_for_me') {
                            onDismiss === null || onDismiss === void 0 ? void 0 : onDismiss();
                        }
                        if (option.signal === 'save') {
                            onSave === null || onSave === void 0 ? void 0 : onSave();
                        }
                        return [2 /*return*/];
                }
            });
        });
    }
    if (sent && (sent === 'dismiss' || sent === 'not_for_me'))
        return null;
    return (<react_native_1.View>
      <react_native_1.Pressable style={s.trigger} onPress={function () { return setOpen(true); }} hitSlop={8}>
        <lucide_react_native_1.MoreHorizontal size={16} color={sent ? tokens_1.color.signal : tokens_1.color.mute}/>
      </react_native_1.Pressable>

      <react_native_1.Modal visible={open} transparent animationType="fade" onRequestClose={function () { return setOpen(false); }}>
        <react_native_1.Pressable style={s.overlay} onPress={function () { return setOpen(false); }}>
          <react_native_1.View style={s.sheet}>
            <react_native_1.Text style={s.sheetTitle}>Feedback</react_native_1.Text>
            {OPTIONS.map(function (opt) {
            var Icon = opt.icon;
            return (<react_native_1.Pressable key={opt.signal} style={function (_a) {
                var pressed = _a.pressed;
                return [s.row, pressed && { opacity: 0.7 }];
            }} onPress={function () { return handleSelect(opt); }}>
                  <Icon size={15} color={opt.tint}/>
                  <react_native_1.Text style={[s.rowLabel, { color: opt.tint }]}>{opt.label}</react_native_1.Text>
                </react_native_1.Pressable>);
        })}
            <react_native_1.Pressable style={s.cancelBtn} onPress={function () { return setOpen(false); }}>
              <react_native_1.Text style={s.cancelText}>Cancel</react_native_1.Text>
            </react_native_1.Pressable>
          </react_native_1.View>
        </react_native_1.Pressable>
      </react_native_1.Modal>
    </react_native_1.View>);
}
var s = react_native_1.StyleSheet.create({
    trigger: { padding: 4 },
    overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
    sheet: {
        backgroundColor: tokens_1.color.paperRaised,
        borderTopLeftRadius: tokens_1.radius.lg,
        borderTopRightRadius: tokens_1.radius.lg,
        padding: tokens_1.space.xl,
        paddingBottom: tokens_1.space.xxxl,
        gap: tokens_1.space.xs,
    },
    sheetTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, marginBottom: tokens_1.space.sm, fontSize: 14 }),
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.md,
        paddingVertical: tokens_1.space.md,
        borderBottomWidth: 1,
        borderBottomColor: tokens_1.color.haze,
    },
    rowLabel: __assign(__assign({}, tokens_1.type.body), { fontSize: 15 }),
    cancelBtn: { marginTop: tokens_1.space.md, alignItems: 'center', paddingVertical: tokens_1.space.md },
    cancelText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute }),
});
