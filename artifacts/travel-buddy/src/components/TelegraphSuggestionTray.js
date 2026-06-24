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
exports.TelegraphSuggestionTray = TelegraphSuggestionTray;
exports.clearTelegraphSuggestionsCache = clearTelegraphSuggestionsCache;
/**
 * TelegraphSuggestionTray — collapsible tray above the chat composer.
 *
 * - Fetches suggestions on mount and whenever a new message is sent.
 * - Loads cached suggestions from AsyncStorage on mount so they survive restarts.
 * - Shows a subtle "From earlier" label while serving cached suggestions.
 * - Renders 1–2 TelegraphChatCard components.
 * - When 3+ suggestions span 2+ categories, shows dynamic filter chips so the
 *   user can narrow the tray in-place (category facet; OR within the facet).
 * - Shows nothing when list is empty (no spinner, no error banner).
 * - Fails silently if the API errors.
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var async_storage_1 = require("@react-native-async-storage/async-storage");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../theme/tokens");
var TelegraphChatCard_1 = require("./TelegraphChatCard");
var telegraphChat_1 = require("../services/telegraphChat");
var MAX_CACHED = 10;
var CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Show the filter chip row only once there are enough cards to be worth narrowing. */
var MIN_SUGGESTIONS_FOR_FILTERS = 3;
/** Display labels for the category facet (suggestions only carry a raw `category`). */
var CATEGORY_LABELS = {
    food: 'Food',
    nightlife: 'Nightlife',
    beach: 'Beach',
    attraction: 'Attraction',
    transport: 'Transport',
    meetup: 'Meetup',
    poll: 'Time Poll',
    plan: 'Plan',
    availability: 'Availability',
    activity: 'Activity',
};
function labelFor(category) {
    var _a;
    return ((_a = CATEGORY_LABELS[category]) !== null && _a !== void 0 ? _a : category.charAt(0).toUpperCase() + category.slice(1));
}
function cacheKey(threadId) {
    return "telegraph_suggestions_".concat(threadId);
}
function readCache(threadId, tripEndDate) {
    return __awaiter(this, void 0, void 0, function () {
        var raw, entry, age, endMs, _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    _b.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, async_storage_1.default.getItem(cacheKey(threadId))];
                case 1:
                    raw = _b.sent();
                    if (!raw)
                        return [2 /*return*/, null];
                    entry = JSON.parse(raw);
                    age = Date.now() - entry.savedAt;
                    if (age > CACHE_TTL_MS) {
                        async_storage_1.default.removeItem(cacheKey(threadId)).catch(function () { });
                        return [2 /*return*/, null];
                    }
                    if (tripEndDate) {
                        endMs = new Date(tripEndDate).getTime();
                        if (!Number.isNaN(endMs) && Date.now() > endMs) {
                            async_storage_1.default.removeItem(cacheKey(threadId)).catch(function () { });
                            return [2 /*return*/, null];
                        }
                    }
                    return [2 /*return*/, entry.suggestions.length > 0 ? entry.suggestions : null];
                case 2:
                    _a = _b.sent();
                    return [2 /*return*/, null];
                case 3: return [2 /*return*/];
            }
        });
    });
}
function writeCache(threadId, suggestions) {
    return __awaiter(this, void 0, void 0, function () {
        var entry, _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    _b.trys.push([0, 2, , 3]);
                    entry = {
                        suggestions: suggestions.slice(0, MAX_CACHED),
                        savedAt: Date.now(),
                    };
                    return [4 /*yield*/, async_storage_1.default.setItem(cacheKey(threadId), JSON.stringify(entry))];
                case 1:
                    _b.sent();
                    return [3 /*break*/, 3];
                case 2:
                    _a = _b.sent();
                    return [3 /*break*/, 3];
                case 3: return [2 /*return*/];
            }
        });
    });
}
function clearCache(threadId) {
    return __awaiter(this, void 0, void 0, function () {
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    _b.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, async_storage_1.default.removeItem(cacheKey(threadId))];
                case 1:
                    _b.sent();
                    return [3 /*break*/, 3];
                case 2:
                    _a = _b.sent();
                    return [3 /*break*/, 3];
                case 3: return [2 /*return*/];
            }
        });
    });
}
function TelegraphSuggestionTray(_a) {
    var _this = this;
    var threadId = _a.threadId, lastSentMessage = _a.lastSentMessage, tripEndDate = _a.tripEndDate, onAddToPlan = _a.onAddToPlan, onCreateMeetup = _a.onCreateMeetup, onViewPlace = _a.onViewPlace;
    var _b = (0, react_1.useState)([]), suggestions = _b[0], setSuggestions = _b[1];
    var _c = (0, react_1.useState)(false), stale = _c[0], setStale = _c[1];
    var _d = (0, react_1.useState)([]), activeFilters = _d[0], setActiveFilters = _d[1];
    var prevMessage = (0, react_1.useRef)(undefined);
    var opacity = (0, react_1.useRef)(new react_native_1.Animated.Value(0)).current;
    var hasFreshLoad = (0, react_1.useRef)(false);
    var showTray = (0, react_1.useCallback)(function (cards) {
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
    }, [opacity]);
    var load = (0, react_1.useCallback)(function (msgText) { return __awaiter(_this, void 0, void 0, function () {
        var cards, _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    _b.trys.push([0, 6, , 7]);
                    return [4 /*yield*/, (0, telegraphChat_1.getTelegraphSuggestions)(threadId, msgText)];
                case 1:
                    cards = _b.sent();
                    hasFreshLoad.current = true;
                    setStale(false);
                    showTray(cards);
                    if (!(cards.length > 0)) return [3 /*break*/, 3];
                    return [4 /*yield*/, writeCache(threadId, cards)];
                case 2:
                    _b.sent();
                    return [3 /*break*/, 5];
                case 3: return [4 /*yield*/, clearCache(threadId)];
                case 4:
                    _b.sent();
                    _b.label = 5;
                case 5: return [3 /*break*/, 7];
                case 6:
                    _a = _b.sent();
                    return [3 /*break*/, 7];
                case 7: return [2 /*return*/];
            }
        });
    }); }, [threadId, showTray]);
    // On mount: load cache immediately, then fetch fresh in background
    (0, react_1.useEffect)(function () {
        var cancelled = false;
        (function () { return __awaiter(_this, void 0, void 0, function () {
            var cached;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, readCache(threadId, tripEndDate)];
                    case 1:
                        cached = _a.sent();
                        if (!cancelled && cached && !hasFreshLoad.current) {
                            setStale(true);
                            showTray(cached);
                        }
                        return [2 /*return*/];
                }
            });
        }); })();
        load();
        return function () {
            cancelled = true;
        };
    }, [load, threadId, tripEndDate, showTray]);
    // Reload when a new message is sent
    (0, react_1.useEffect)(function () {
        if (lastSentMessage && lastSentMessage !== prevMessage.current) {
            prevMessage.current = lastSentMessage;
            load(lastSentMessage);
        }
    }, [lastSentMessage, load]);
    // Distinct categories present in the current suggestions, in first-seen order.
    var categories = (0, react_1.useMemo)(function () {
        var seen = new Set();
        var out = [];
        for (var _i = 0, suggestions_1 = suggestions; _i < suggestions_1.length; _i++) {
            var s = suggestions_1[_i];
            if (!seen.has(s.category)) {
                seen.add(s.category);
                out.push(s.category);
            }
        }
        return out;
    }, [suggestions]);
    // Drop any active filter whose category is no longer present after a reload.
    (0, react_1.useEffect)(function () {
        setActiveFilters(function (prev) {
            var next = prev.filter(function (c) { return categories.includes(c); });
            return next.length === prev.length ? prev : next;
        });
    }, [categories]);
    // OR within the single category facet: a card matches if no filter is active
    // or its category is one of the selected ones.
    var visible = (0, react_1.useMemo)(function () {
        if (activeFilters.length === 0)
            return suggestions;
        var set = new Set(activeFilters);
        return suggestions.filter(function (s) { return set.has(s.category); });
    }, [suggestions, activeFilters]);
    var showFilters = categories.length >= 2 && suggestions.length >= MIN_SUGGESTIONS_FOR_FILTERS;
    var filtersActive = activeFilters.length > 0;
    function toggleFilter(category) {
        setActiveFilters(function (prev) {
            return prev.includes(category)
                ? prev.filter(function (c) { return c !== category; })
                : __spreadArray(__spreadArray([], prev, true), [category], false);
        });
    }
    function clearFilters() {
        setActiveFilters([]);
    }
    function handleDismiss(id) {
        return __awaiter(this, void 0, void 0, function () {
            var next;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        next = suggestions.filter(function (s) { return s.id !== id; });
                        setSuggestions(next);
                        if (!(next.length > 0)) return [3 /*break*/, 2];
                        return [4 /*yield*/, writeCache(threadId, next).catch(function () { })];
                    case 1:
                        _a.sent();
                        return [3 /*break*/, 4];
                    case 2: return [4 /*yield*/, clearCache(threadId).catch(function () { })];
                    case 3:
                        _a.sent();
                        _a.label = 4;
                    case 4: return [4 /*yield*/, (0, telegraphChat_1.dismissSuggestion)(threadId, id).catch(function () { })];
                    case 5:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        });
    }
    function handleAction(suggestion) {
        return __awaiter(this, void 0, void 0, function () {
            var _a, tripId, next, prefill, next, next, next;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        _a = suggestion.action_type;
                        switch (_a) {
                            case 'add_to_plan': return [3 /*break*/, 1];
                            case 'create_meetup': return [3 /*break*/, 8];
                            case 'start_time_poll': return [3 /*break*/, 14];
                            case 'view_place': return [3 /*break*/, 20];
                        }
                        return [3 /*break*/, 20];
                    case 1:
                        if (!onAddToPlan) return [3 /*break*/, 7];
                        return [4 /*yield*/, onAddToPlan(suggestion)];
                    case 2:
                        tripId = _b.sent();
                        if (!tripId) return [3 /*break*/, 7];
                        return [4 /*yield*/, (0, telegraphChat_1.addSuggestionToPlan)(threadId, suggestion.id, tripId, {
                                title: suggestion.title,
                            }).catch(function () { })];
                    case 3:
                        _b.sent();
                        next = suggestions.filter(function (s) { return s.id !== suggestion.id; });
                        setSuggestions(next);
                        if (!(next.length > 0)) return [3 /*break*/, 5];
                        return [4 /*yield*/, writeCache(threadId, next).catch(function () { })];
                    case 4:
                        _b.sent();
                        return [3 /*break*/, 7];
                    case 5: return [4 /*yield*/, clearCache(threadId).catch(function () { })];
                    case 6:
                        _b.sent();
                        _b.label = 7;
                    case 7: return [3 /*break*/, 25];
                    case 8: return [4 /*yield*/, (0, telegraphChat_1.getSuggestionMeetupPrefill)(threadId, suggestion.id).catch(function () { return null; })];
                    case 9:
                        prefill = _b.sent();
                        if (!(prefill && onCreateMeetup)) return [3 /*break*/, 13];
                        onCreateMeetup(prefill);
                        next = suggestions.filter(function (s) { return s.id !== suggestion.id; });
                        setSuggestions(next);
                        if (!(next.length > 0)) return [3 /*break*/, 11];
                        return [4 /*yield*/, writeCache(threadId, next).catch(function () { })];
                    case 10:
                        _b.sent();
                        return [3 /*break*/, 13];
                    case 11: return [4 /*yield*/, clearCache(threadId).catch(function () { })];
                    case 12:
                        _b.sent();
                        _b.label = 13;
                    case 13: return [3 /*break*/, 25];
                    case 14: return [4 /*yield*/, (0, telegraphChat_1.startTimePoll)(threadId, suggestion.id).catch(function () { })];
                    case 15:
                        _b.sent();
                        next = suggestions.filter(function (s) { return s.id !== suggestion.id; });
                        setSuggestions(next);
                        if (!(next.length > 0)) return [3 /*break*/, 17];
                        return [4 /*yield*/, writeCache(threadId, next).catch(function () { })];
                    case 16:
                        _b.sent();
                        return [3 /*break*/, 19];
                    case 17: return [4 /*yield*/, clearCache(threadId).catch(function () { })];
                    case 18:
                        _b.sent();
                        _b.label = 19;
                    case 19: return [3 /*break*/, 25];
                    case 20:
                        if (onViewPlace) {
                            onViewPlace(suggestion);
                        }
                        next = suggestions.filter(function (s) { return s.id !== suggestion.id; });
                        setSuggestions(next);
                        if (!(next.length > 0)) return [3 /*break*/, 22];
                        return [4 /*yield*/, writeCache(threadId, next).catch(function () { })];
                    case 21:
                        _b.sent();
                        return [3 /*break*/, 24];
                    case 22: return [4 /*yield*/, clearCache(threadId).catch(function () { })];
                    case 23:
                        _b.sent();
                        _b.label = 24;
                    case 24: return [3 /*break*/, 25];
                    case 25: return [2 /*return*/];
                }
            });
        });
    }
    if (suggestions.length === 0)
        return null;
    return (<react_native_1.Animated.View style={[styles.tray, { opacity: opacity }]}>
      {stale && (<react_native_1.View style={styles.staleRow}>
          <lucide_react_native_1.Clock size={tokens_1.icon.sm} color={tokens_1.color.faint}/>
          <react_native_1.Text style={styles.staleLabel}>From earlier</react_native_1.Text>
        </react_native_1.View>)}
      {showFilters && (<react_native_1.View style={styles.filterSection}>
          <react_native_1.ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterScroll} contentContainerStyle={styles.filterRow}>
            {categories.map(function (c) {
                var active = activeFilters.includes(c);
                return (<react_native_1.Pressable key={c} onPress={function () { return toggleFilter(c); }} hitSlop={6} style={[styles.chip, active ? styles.chipActive : styles.chipIdle]}>
                  <react_native_1.Text style={[
                        styles.chipText,
                        active ? styles.chipTextActive : styles.chipTextIdle,
                    ]}>
                    {labelFor(c)}
                  </react_native_1.Text>
                </react_native_1.Pressable>);
            })}
            {filtersActive && (<react_native_1.Pressable onPress={clearFilters} hitSlop={6} style={[styles.chip, styles.chipClear]}>
                <react_native_1.Text style={[styles.chipText, styles.chipClearText]}>Clear</react_native_1.Text>
              </react_native_1.Pressable>)}
          </react_native_1.ScrollView>
          {filtersActive && (<react_native_1.Text style={styles.countBadge}>
              {visible.length} of {suggestions.length}
            </react_native_1.Text>)}
        </react_native_1.View>)}
      {visible.map(function (s) { return (<TelegraphChatCard_1.TelegraphChatCard key={s.id} suggestion={s} onDismiss={handleDismiss} onAction={handleAction}/>); })}
    </react_native_1.Animated.View>);
}
/** Removes any cached suggestions for the given thread (call on thread delete). */
function clearTelegraphSuggestionsCache(threadId) {
    return clearCache(threadId);
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
    staleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.xs,
        marginBottom: -tokens_1.space.xs,
    },
    staleLabel: __assign(__assign({}, tokens_1.type.stamp), { color: tokens_1.color.faint, textTransform: 'uppercase' }),
    filterSection: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.sm,
    },
    filterScroll: {
        flex: 1,
    },
    filterRow: {
        gap: tokens_1.space.xs,
        alignItems: 'center',
        paddingRight: tokens_1.space.xs,
    },
    chip: {
        paddingHorizontal: tokens_1.space.sm,
        paddingVertical: 5,
        borderRadius: tokens_1.radius.sm,
        borderWidth: 1,
    },
    chipIdle: {
        backgroundColor: 'transparent',
        borderColor: tokens_1.color.haze,
    },
    chipActive: {
        backgroundColor: tokens_1.color.signal,
        borderColor: tokens_1.color.signal,
    },
    chipClear: {
        backgroundColor: 'transparent',
        borderColor: 'transparent',
        paddingHorizontal: tokens_1.space.xs,
    },
    chipText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '600' }),
    chipTextIdle: {
        color: tokens_1.color.mute,
    },
    chipTextActive: {
        color: tokens_1.color.onInk,
    },
    chipClearText: {
        color: tokens_1.color.signal,
        fontWeight: '700',
    },
    countBadge: __assign(__assign({}, tokens_1.type.stamp), { color: tokens_1.color.faint }),
});
