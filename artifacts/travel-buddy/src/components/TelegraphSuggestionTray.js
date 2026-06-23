"use strict";
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
exports.TelegraphSuggestionTray = TelegraphSuggestionTray;
/**
 * TelegraphSuggestionTray — collapsible tray above the chat composer.
 *
 * - Fetches suggestions on mount and whenever a new message is sent.
 * - Renders 1–2 TelegraphChatCard components.
 * - Shows nothing when list is empty (no spinner, no error banner).
 * - Fails silently if the API errors.
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var tokens_1 = require("../theme/tokens");
var TelegraphChatCard_1 = require("./TelegraphChatCard");
var telegraphChat_1 = require("../services/telegraphChat");
function TelegraphSuggestionTray(_a) {
    var _this = this;
    var threadId = _a.threadId, lastSentMessage = _a.lastSentMessage, onAddToPlan = _a.onAddToPlan, onCreateMeetup = _a.onCreateMeetup, onViewPlace = _a.onViewPlace;
    var _b = (0, react_1.useState)([]), suggestions = _b[0], setSuggestions = _b[1];
    var prevMessage = (0, react_1.useRef)(undefined);
    var opacity = (0, react_1.useRef)(new react_native_1.Animated.Value(0)).current;
    var load = (0, react_1.useCallback)(function (msgText) { return __awaiter(_this, void 0, void 0, function () {
        var cards, _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    _b.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, (0, telegraphChat_1.getTelegraphSuggestions)(threadId, msgText)];
                case 1:
                    cards = _b.sent();
                    setSuggestions(cards);
                    if (cards.length > 0) {
                        react_native_1.Animated.timing(opacity, {
                            toValue: 1,
                            duration: 200,
                            useNativeDriver: true,
                        }).start();
                    }
                    else {
                        opacity.setValue(0);
                    }
                    return [3 /*break*/, 3];
                case 2:
                    _a = _b.sent();
                    return [3 /*break*/, 3];
                case 3: return [2 /*return*/];
            }
        });
    }); }, [threadId, opacity]);
    // Initial load
    (0, react_1.useEffect)(function () {
        load();
    }, [load]);
    // Reload when a new message is sent
    (0, react_1.useEffect)(function () {
        if (lastSentMessage && lastSentMessage !== prevMessage.current) {
            prevMessage.current = lastSentMessage;
            load(lastSentMessage);
        }
    }, [lastSentMessage, load]);
    function handleDismiss(id) {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        setSuggestions(function (prev) { return prev.filter(function (s) { return s.id !== id; }); });
                        return [4 /*yield*/, (0, telegraphChat_1.dismissSuggestion)(threadId, id).catch(function () { })];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        });
    }
    function handleAction(suggestion) {
        return __awaiter(this, void 0, void 0, function () {
            var _a, tripId, prefill;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        _a = suggestion.action_type;
                        switch (_a) {
                            case 'add_to_plan': return [3 /*break*/, 1];
                            case 'create_meetup': return [3 /*break*/, 5];
                            case 'start_time_poll': return [3 /*break*/, 7];
                            case 'view_place': return [3 /*break*/, 9];
                        }
                        return [3 /*break*/, 9];
                    case 1:
                        if (!onAddToPlan) return [3 /*break*/, 4];
                        return [4 /*yield*/, onAddToPlan(suggestion)];
                    case 2:
                        tripId = _b.sent();
                        if (!tripId) return [3 /*break*/, 4];
                        return [4 /*yield*/, (0, telegraphChat_1.addSuggestionToPlan)(threadId, suggestion.id, tripId, {
                                title: suggestion.title,
                            }).catch(function () { })];
                    case 3:
                        _b.sent();
                        setSuggestions(function (prev) { return prev.filter(function (s) { return s.id !== suggestion.id; }); });
                        _b.label = 4;
                    case 4: return [3 /*break*/, 10];
                    case 5: return [4 /*yield*/, (0, telegraphChat_1.getSuggestionMeetupPrefill)(threadId, suggestion.id).catch(function () { return null; })];
                    case 6:
                        prefill = _b.sent();
                        if (prefill && onCreateMeetup) {
                            onCreateMeetup(prefill);
                            setSuggestions(function (prev) { return prev.filter(function (s) { return s.id !== suggestion.id; }); });
                        }
                        return [3 /*break*/, 10];
                    case 7: return [4 /*yield*/, (0, telegraphChat_1.startTimePoll)(threadId, suggestion.id).catch(function () { })];
                    case 8:
                        _b.sent();
                        setSuggestions(function (prev) { return prev.filter(function (s) { return s.id !== suggestion.id; }); });
                        return [3 /*break*/, 10];
                    case 9:
                        {
                            if (onViewPlace) {
                                onViewPlace(suggestion);
                            }
                            setSuggestions(function (prev) { return prev.filter(function (s) { return s.id !== suggestion.id; }); });
                            return [3 /*break*/, 10];
                        }
                        _b.label = 10;
                    case 10: return [2 /*return*/];
                }
            });
        });
    }
    if (suggestions.length === 0)
        return null;
    return (<react_native_1.Animated.View style={[styles.tray, { opacity: opacity }]}>
      {suggestions.map(function (s) { return (<TelegraphChatCard_1.TelegraphChatCard key={s.id} suggestion={s} onDismiss={handleDismiss} onAction={handleAction}/>); })}
    </react_native_1.Animated.View>);
}
var styles = react_native_1.StyleSheet.create({
    tray: {
        paddingHorizontal: tokens_1.space.md,
        paddingTop: tokens_1.space.sm,
        paddingBottom: 4,
        gap: tokens_1.space.sm,
        borderTopWidth: 1,
        borderTopColor: tokens_1.color.signal + '22',
        backgroundColor: tokens_1.color.paper,
    },
});
