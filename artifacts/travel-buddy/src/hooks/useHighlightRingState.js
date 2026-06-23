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
exports.viewedHighlightIds = void 0;
exports.markViewed = markViewed;
exports.invalidateHighlightCache = invalidateHighlightCache;
exports.useHighlightRingState = useHighlightRingState;
/**
 * useHighlightRingState — fetches and caches active-highlight ring state for a user.
 *
 * Uses a module-level LRU-style cache (60 s TTL) so multiple cards showing the
 * same user don't hammer the API.
 *
 * Pass an incrementing `refreshKey` to force a cache-bust and immediate re-fetch
 * (e.g. after the owner creates a new highlight so the ring activates instantly).
 */
var react_1 = require("react");
var async_storage_1 = require("@react-native-async-storage/async-storage");
var highlights_1 = require("../services/highlights");
var CACHE_TTL_MS = 60000;
var cache = new Map();
var inFlight = new Set();
var STORAGE_KEY = '@highlight_viewed_ids_v1';
/**
 * In-memory set of viewed highlight IDs.
 * Populated on first import by `initViewedIds()` (which loads & prunes AsyncStorage).
 * Updated on every `markViewed()` call.
 */
exports.viewedHighlightIds = new Set();
/** Map persisted to AsyncStorage: id → ISO expiresAt string. */
var _persistedMap = {};
/** Promise that resolves once the persisted IDs have been loaded. */
var _initPromise = null;
/** Initialise from AsyncStorage — called once at module load. */
function initViewedIds() {
    var _this = this;
    if (_initPromise)
        return _initPromise;
    _initPromise = (function () { return __awaiter(_this, void 0, void 0, function () {
        var raw, stored, now, pruned, _i, _a, _b, id, expiresAt, _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    _d.trys.push([0, 4, , 5]);
                    return [4 /*yield*/, async_storage_1.default.getItem(STORAGE_KEY)];
                case 1:
                    raw = _d.sent();
                    stored = raw ? JSON.parse(raw) : {};
                    now = Date.now();
                    pruned = {};
                    for (_i = 0, _a = Object.entries(stored); _i < _a.length; _i++) {
                        _b = _a[_i], id = _b[0], expiresAt = _b[1];
                        if (new Date(expiresAt).getTime() > now) {
                            pruned[id] = expiresAt;
                            exports.viewedHighlightIds.add(id);
                        }
                    }
                    _persistedMap = pruned;
                    if (!(Object.keys(pruned).length !== Object.keys(stored).length)) return [3 /*break*/, 3];
                    return [4 /*yield*/, async_storage_1.default.setItem(STORAGE_KEY, JSON.stringify(pruned))];
                case 2:
                    _d.sent();
                    _d.label = 3;
                case 3: return [3 /*break*/, 5];
                case 4:
                    _c = _d.sent();
                    return [3 /*break*/, 5];
                case 5: return [2 /*return*/];
            }
        });
    }); })();
    return _initPromise;
}
// Kick off immediately so storage is ready before the first render.
initViewedIds();
/**
 * Mark a highlight as viewed.
 * Updates the in-memory set and persists id→expiresAt to AsyncStorage so
 * the ring stays muted across app restarts.
 *
 * @param id        Highlight ID.
 * @param expiresAt ISO-8601 expiry string from the Highlight object (optional;
 *                  if omitted the entry is still added in-memory but not persisted).
 */
function markViewed(id, expiresAt) {
    exports.viewedHighlightIds.add(id);
    if (!expiresAt)
        return;
    // Skip persistence if this id is already stored with the same expiry
    if (_persistedMap[id] === expiresAt)
        return;
    _persistedMap[id] = expiresAt;
    async_storage_1.default.setItem(STORAGE_KEY, JSON.stringify(_persistedMap)).catch(function () { });
}
function getCached(userId) {
    var entry = cache.get(userId);
    if (!entry)
        return null;
    if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
        cache.delete(userId);
        return null;
    }
    return entry.state;
}
function computeState(highlights) {
    var hasActive = highlights.length > 0;
    var allViewed = hasActive && highlights.every(function (h) { return exports.viewedHighlightIds.has(h.id); });
    return { hasActive: hasActive, allViewed: allViewed, highlights: highlights };
}
/** Invalidate the cache for a user (e.g. after creating a new highlight). */
function invalidateHighlightCache(userId) {
    cache.delete(userId);
}
/**
 * Hook: returns { hasActive, allViewed, highlights } for the given userId.
 * Returns null while loading. Safe to call with null userId (returns null immediately).
 *
 * Pass an incrementing `refreshKey` to force a cache-bust and immediate re-fetch.
 * Increment it (e.g. via setState(k => k + 1)) after a successful highlight creation
 * so the ring activates without waiting for the 60-second TTL to expire.
 */
function useHighlightRingState(userId, refreshKey) {
    var _this = this;
    if (refreshKey === void 0) { refreshKey = 0; }
    var _a = (0, react_1.useState)(function () {
        return userId ? getCached(userId) : null;
    }), state = _a[0], setState = _a[1];
    var userIdRef = (0, react_1.useRef)(userId);
    userIdRef.current = userId;
    (0, react_1.useEffect)(function () {
        if (!userId) {
            setState(null);
            return;
        }
        // A non-zero refreshKey means the caller explicitly requested a fresh fetch.
        // Bust the cache entry so the fetch below runs unconditionally.
        if (refreshKey > 0) {
            cache.delete(userId);
        }
        var cached = getCached(userId);
        if (cached) {
            // Re-compute allViewed with latest viewedIds
            setState(computeState(cached.highlights));
            return;
        }
        if (inFlight.has(userId))
            return;
        // Wait for the persisted IDs to finish loading before the first fetch so
        // computeState uses the full set and avoids a spurious "unviewed" flash.
        var run = function () { return __awaiter(_this, void 0, void 0, function () {
            var r, highlights, computed;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, initViewedIds()];
                    case 1:
                        _a.sent();
                        if (inFlight.has(userId))
                            return [2 /*return*/];
                        inFlight.add(userId);
                        _a.label = 2;
                    case 2:
                        _a.trys.push([2, , 4, 5]);
                        return [4 /*yield*/, (0, highlights_1.fetchUserHighlights)(userId)];
                    case 3:
                        r = _a.sent();
                        highlights = r.ok && r.data ? r.data : [];
                        computed = computeState(highlights);
                        cache.set(userId, { state: computed, fetchedAt: Date.now() });
                        if (userIdRef.current === userId)
                            setState(computed);
                        return [3 /*break*/, 5];
                    case 4:
                        inFlight.delete(userId);
                        return [7 /*endfinally*/];
                    case 5: return [2 /*return*/];
                }
            });
        }); };
        run();
    }, [userId, refreshKey]);
    return state;
}
