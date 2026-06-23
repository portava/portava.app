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
exports.DailyBriefCard = DailyBriefCard;
/**
 * DailyBriefCard — "Today's Brief" for accepted trip members.
 *
 * Shows: date, summary text, plan preview, open windows, suggestions,
 * meetup opportunities, warnings, quick-action buttons.
 * Expandable/collapsible. Renders access-denied + error states without crashing.
 *
 * Privacy: only shown to accepted members; non-members see a graceful state.
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../theme/tokens");
var intelligence_1 = require("../services/intelligence");
var TelegraphFeedbackMenu_1 = require("./TelegraphFeedbackMenu");
function DailyBriefCard(_a) {
    var _this = this;
    var _b, _c, _d, _e, _f, _g, _h, _j;
    var tripId = _a.tripId, date = _a.date, _k = _a.compact, compact = _k === void 0 ? false : _k, onGapDays = _a.onGapDays;
    var _l = (0, react_1.useState)(null), brief = _l[0], setBrief = _l[1];
    var _m = (0, react_1.useState)(null), access = _m[0], setAccess = _m[1];
    var _o = (0, react_1.useState)(true), loading = _o[0], setLoading = _o[1];
    var _p = (0, react_1.useState)(null), error = _p[0], setError = _p[1];
    var _q = (0, react_1.useState)(!compact), expanded = _q[0], setExpanded = _q[1];
    var _r = (0, react_1.useState)(false), refreshing = _r[0], setRefreshing = _r[1];
    var load = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var res, b;
        var _a, _b, _c, _d, _e, _f;
        return __generator(this, function (_g) {
            switch (_g.label) {
                case 0:
                    setLoading(true);
                    setError(null);
                    return [4 /*yield*/, (0, intelligence_1.fetchDailyBrief)(tripId, date)];
                case 1:
                    res = _g.sent();
                    setLoading(false);
                    if (!res.ok) {
                        setError("Could not load today's brief");
                        return [2 /*return*/];
                    }
                    setAccess((_b = (_a = res.data) === null || _a === void 0 ? void 0 : _a.access) !== null && _b !== void 0 ? _b : 'access_denied');
                    b = (_d = (_c = res.data) === null || _c === void 0 ? void 0 : _c.brief) !== null && _d !== void 0 ? _d : null;
                    setBrief(b);
                    if (((_e = b === null || b === void 0 ? void 0 : b.gapDays) === null || _e === void 0 ? void 0 : _e.length) && onGapDays) {
                        onGapDays(b.gapDays, (_f = b.destination) !== null && _f !== void 0 ? _f : '');
                    }
                    return [2 /*return*/];
            }
        });
    }); }, [tripId, date, onGapDays]);
    var handleRefresh = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var res, b;
        var _a, _b, _c, _d, _e, _f;
        return __generator(this, function (_g) {
            switch (_g.label) {
                case 0:
                    setRefreshing(true);
                    return [4 /*yield*/, (0, intelligence_1.refreshDailyBrief)(tripId, date)];
                case 1:
                    res = _g.sent();
                    setRefreshing(false);
                    if (!res.ok)
                        return [2 /*return*/]; // silently keep old brief on failure
                    setAccess((_b = (_a = res.data) === null || _a === void 0 ? void 0 : _a.access) !== null && _b !== void 0 ? _b : 'access_denied');
                    b = (_d = (_c = res.data) === null || _c === void 0 ? void 0 : _c.brief) !== null && _d !== void 0 ? _d : null;
                    setBrief(b);
                    if (((_e = b === null || b === void 0 ? void 0 : b.gapDays) === null || _e === void 0 ? void 0 : _e.length) && onGapDays) {
                        onGapDays(b.gapDays, (_f = b.destination) !== null && _f !== void 0 ? _f : '');
                    }
                    return [2 /*return*/];
            }
        });
    }); }, [tripId, date, onGapDays]);
    // Silent background re-fetch via the GET (cached) endpoint — used when the
    // app returns to the foreground. Keeps existing content visible; the server
    // returns the cached brief when it is still fresh, avoiding regeneration.
    // Distinct from handleRefresh which POSTs and forces cache invalidation.
    var backgroundRefetch = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var res, b;
        var _a, _b, _c, _d, _e, _f;
        return __generator(this, function (_g) {
            switch (_g.label) {
                case 0:
                    setRefreshing(true);
                    return [4 /*yield*/, (0, intelligence_1.fetchDailyBrief)(tripId, date)];
                case 1:
                    res = _g.sent();
                    setRefreshing(false);
                    if (!res.ok)
                        return [2 /*return*/]; // silently keep old brief on failure
                    setAccess((_b = (_a = res.data) === null || _a === void 0 ? void 0 : _a.access) !== null && _b !== void 0 ? _b : 'access_denied');
                    b = (_d = (_c = res.data) === null || _c === void 0 ? void 0 : _c.brief) !== null && _d !== void 0 ? _d : null;
                    setBrief(b);
                    if (((_e = b === null || b === void 0 ? void 0 : b.gapDays) === null || _e === void 0 ? void 0 : _e.length) && onGapDays) {
                        onGapDays(b.gapDays, (_f = b.destination) !== null && _f !== void 0 ? _f : '');
                    }
                    return [2 /*return*/];
            }
        });
    }); }, [tripId, date, onGapDays]);
    (0, react_1.useEffect)(function () { load(); }, [load]);
    // Re-fetch silently when the app returns to the foreground so users always
    // see a fresh brief rather than a stale card from hours ago.
    // Uses backgroundRefetch (GET) so server caching is respected and existing
    // content stays visible during the in-flight request.
    var appStateRef = (0, react_1.useRef)(react_native_1.AppState.currentState);
    (0, react_1.useEffect)(function () {
        var sub = react_native_1.AppState.addEventListener('change', function (nextState) {
            var prev = appStateRef.current;
            appStateRef.current = nextState;
            if ((prev === 'background' || prev === 'inactive') && nextState === 'active') {
                backgroundRefetch();
            }
        });
        return function () { return sub.remove(); };
    }, [backgroundRefetch]);
    if (loading) {
        return (<react_native_1.View style={s.wrap}>
        <react_native_1.View style={s.loadRow}>
          <react_native_1.ActivityIndicator size="small" color={tokens_1.color.signal}/>
          <react_native_1.Text style={s.loadText}>Loading today's brief…</react_native_1.Text>
        </react_native_1.View>
      </react_native_1.View>);
    }
    if (error) {
        return (<react_native_1.View style={s.wrap}>
        <react_native_1.Text style={s.errorText}>{error}</react_native_1.Text>
        <react_native_1.Pressable style={s.retryBtn} onPress={load}><react_native_1.Text style={s.retryText}>Retry</react_native_1.Text></react_native_1.Pressable>
      </react_native_1.View>);
    }
    if (access === 'access_denied' || !brief) {
        return (<react_native_1.View style={s.wrap}>
        <react_native_1.View style={s.deniedRow}>
          <lucide_react_native_1.Zap size={13} color={tokens_1.color.mute}/>
          <react_native_1.Text style={s.deniedText}>Today's Brief is only available to accepted trip members.</react_native_1.Text>
        </react_native_1.View>
      </react_native_1.View>);
    }
    if (compact) {
        return <CompactBriefCard brief={brief} tripId={tripId}/>;
    }
    return (<react_native_1.View style={s.wrap}>
      {/* Header */}
      <react_native_1.Pressable style={s.header} onPress={function () { return setExpanded(function (e) { return !e; }); }}>
        <react_native_1.View style={s.headerLeft}>
          <react_native_1.View style={s.icon}>
            {brief.briefType === 'general'
            ? <lucide_react_native_1.Globe size={13} color={tokens_1.color.signal}/>
            : <lucide_react_native_1.Zap size={13} color={tokens_1.color.signal} fill={tokens_1.color.signal}/>}
          </react_native_1.View>
          <react_native_1.View>
            <react_native_1.Text style={s.headerTitle}>
              {brief.briefType === 'general' ? 'Travel Inspiration' : "Today's Brief"}
            </react_native_1.Text>
            {brief.destination
            ? (<react_native_1.View style={s.destRow}>
                  <lucide_react_native_1.MapPin size={9} color={tokens_1.color.signal}/>
                  <react_native_1.Text style={s.destText}>{brief.destination}</react_native_1.Text>
                </react_native_1.View>)
            : <react_native_1.Text style={s.headerDate}>{formatDate(brief.date)}</react_native_1.Text>}
          </react_native_1.View>
        </react_native_1.View>
        <react_native_1.View style={s.headerRight}>
          <react_native_1.Pressable style={s.refreshBtn} onPress={handleRefresh} hitSlop={8} disabled={refreshing}>
            <lucide_react_native_1.RefreshCw size={13} color={refreshing ? tokens_1.color.signal : tokens_1.color.mute}/>
          </react_native_1.Pressable>
          {expanded ? <lucide_react_native_1.ChevronUp size={16} color={tokens_1.color.mute}/> : <lucide_react_native_1.ChevronDown size={16} color={tokens_1.color.mute}/>}
        </react_native_1.View>
      </react_native_1.Pressable>

      {/* Destination date row (when destination shown in header) */}
      {brief.destination && (<react_native_1.Text style={s.headerDateSub}>{formatDate(brief.date)}</react_native_1.Text>)}

      {/* Last-refreshed timestamp + staleness badge */}
      {brief.generatedAt ? (<react_native_1.View style={s.generatedAtRow}>
          <react_native_1.Text style={s.generatedAt}>Updated {formatGeneratedAt(brief.generatedAt)}</react_native_1.Text>
          {brief.isStale && (<react_native_1.Pressable style={s.staleBadge} onPress={handleRefresh} disabled={refreshing} hitSlop={6}>
              <lucide_react_native_1.AlertTriangle size={10} color="#92400E"/>
              <react_native_1.Text style={s.staleBadgeText}>May be outdated — tap to refresh</react_native_1.Text>
            </react_native_1.Pressable>)}
        </react_native_1.View>) : null}

      {/* Summary */}
      <react_native_1.Text style={s.summary}>{brief.summaryText}</react_native_1.Text>

      {/* Weather banner */}
      {brief.weatherSummary ? <WeatherBanner summary={brief.weatherSummary}/> : null}

      {/* Multi-day forecast strip — only when the trip spans more than 1 day */}
      {((_b = brief.weatherForecasts) === null || _b === void 0 ? void 0 : _b.length) > 1 ? (<WeatherForecastStrip forecasts={brief.weatherForecasts}/>) : null}

      {/* Warnings */}
      {((_c = brief.warnings) === null || _c === void 0 ? void 0 : _c.length) > 0 && (<react_native_1.View style={s.warningRow}>
          <lucide_react_native_1.AlertTriangle size={12} color={tokens_1.color.warn}/>
          <react_native_1.Text style={s.warningText}>{friendlyWarning(brief.warnings[0])}</react_native_1.Text>
        </react_native_1.View>)}

      {expanded && (<>
          {/* Open windows */}
          {((_d = brief.openWindows) === null || _d === void 0 ? void 0 : _d.length) > 0 && (<react_native_1.View style={s.section}>
              <react_native_1.Text style={s.sectionLabel}>FREE TIME TODAY</react_native_1.Text>
              <react_native_1.ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chipRow}>
                {brief.openWindows.map(function (w, i) { return (<react_native_1.View key={i} style={s.chip}>
                    <lucide_react_native_1.Clock size={10} color={tokens_1.color.deep}/>
                    <react_native_1.Text style={s.chipText}>{w.label} · {w.startTime}–{w.endTime}</react_native_1.Text>
                  </react_native_1.View>); })}
              </react_native_1.ScrollView>
            </react_native_1.View>)}

          {/* Plan preview */}
          {((_e = brief.planPreview) === null || _e === void 0 ? void 0 : _e.length) > 0 && (<react_native_1.View style={s.section}>
              <react_native_1.Text style={s.sectionLabel}>TODAY'S PLAN</react_native_1.Text>
              {brief.planPreview.map(function (item) { return (<PlanRow key={item.id} item={item}/>); })}
            </react_native_1.View>)}

          {/* Gap days */}
          {((_f = brief.gapDays) === null || _f === void 0 ? void 0 : _f.length) > 0 && (<react_native_1.View style={s.section}>
              <react_native_1.Text style={s.sectionLabel}>UNPLANNED DAYS AHEAD</react_native_1.Text>
              <react_native_1.ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chipRow}>
                {brief.gapDays.map(function (d) { return (<react_native_1.View key={d} style={s.gapChip}>
                    <lucide_react_native_1.Calendar size={10} color={tokens_1.color.signal}/>
                    <react_native_1.Text style={s.gapChipText}>{formatShortDate(d)}</react_native_1.Text>
                  </react_native_1.View>); })}
              </react_native_1.ScrollView>
            </react_native_1.View>)}

          {/* Happening nearby — Ticketmaster event suggestions */}
          {(((_g = brief.suggestions) === null || _g === void 0 ? void 0 : _g.filter(function (s) { var _a; return (_a = s.id) === null || _a === void 0 ? void 0 : _a.startsWith('rec_event_'); }).length) > 0) && (<react_native_1.View style={s.section}>
              <react_native_1.Text style={s.sectionLabel}>HAPPENING NEARBY</react_native_1.Text>
              {brief.suggestions
                    .filter(function (s) { var _a; return (_a = s.id) === null || _a === void 0 ? void 0 : _a.startsWith('rec_event_'); })
                    .map(function (sug) { return (<EventSuggestionRow key={sug.id} suggestion={sug} tripId={tripId} onDismiss={function () {
                        (0, intelligence_1.dismissBriefRecommendation)(tripId, sug.id, sug.category);
                        setBrief(function (b) { return b ? __assign(__assign({}, b), { suggestions: b.suggestions.filter(function (s) { return s.id !== sug.id; }) }) : b; });
                    }}/>); })}
            </react_native_1.View>)}

          {/* Suggestions (non-event) */}
          {(((_h = brief.suggestions) === null || _h === void 0 ? void 0 : _h.filter(function (s) { var _a; return !((_a = s.id) === null || _a === void 0 ? void 0 : _a.startsWith('rec_event_')); }).length) > 0) && (<react_native_1.View style={s.section}>
              <react_native_1.Text style={s.sectionLabel}>SUGGESTIONS</react_native_1.Text>
              {brief.suggestions
                    .filter(function (s) { var _a; return !((_a = s.id) === null || _a === void 0 ? void 0 : _a.startsWith('rec_event_')); })
                    .map(function (sug) { return (<SuggestionRow key={sug.id} suggestion={sug} tripId={tripId} onDismiss={function () {
                        (0, intelligence_1.dismissBriefRecommendation)(tripId, sug.id, sug.category);
                        setBrief(function (b) { return b ? __assign(__assign({}, b), { suggestions: b.suggestions.filter(function (s) { return s.id !== sug.id; }) }) : b; });
                    }}/>); })}
            </react_native_1.View>)}

          {/* Quick actions */}
          <react_native_1.View style={s.actionRow}>
            {(_j = brief.quickActions) === null || _j === void 0 ? void 0 : _j.map(function (action) { return (<react_native_1.Pressable key={action.id} style={s.actionBtn} onPress={function () { return handleQuickAction(action, tripId); }}>
                <react_native_1.Text style={s.actionText}>{chipLabelForAction(action)}</react_native_1.Text>
              </react_native_1.Pressable>); })}
          </react_native_1.View>
        </>)}
    </react_native_1.View>);
}
/** Returns "Updated X h ago" when the brief is ≥ 1 h old, otherwise null. */
function computeAgeLabel(generatedAt) {
    if (!generatedAt)
        return null;
    var ageHours = (Date.now() - generatedAt) / 3600000;
    if (ageHours < 1)
        return null;
    return "Updated ".concat(Math.floor(ageHours), " h ago");
}
function CompactBriefCard(_a) {
    var _b, _c, _d;
    var brief = _a.brief, tripId = _a.tripId;
    var topSuggestion = (_c = (_b = brief.suggestions) === null || _b === void 0 ? void 0 : _b[0]) !== null && _c !== void 0 ? _c : null;
    // Recompute every minute so the label stays accurate without a re-fetch.
    var _e = (0, react_1.useState)(function () { return computeAgeLabel(brief.generatedAt); }), ageLabel = _e[0], setAgeLabel = _e[1];
    (0, react_1.useEffect)(function () {
        setAgeLabel(computeAgeLabel(brief.generatedAt));
        var timer = setInterval(function () { return setAgeLabel(computeAgeLabel(brief.generatedAt)); }, 60000);
        return function () { return clearInterval(timer); };
    }, [brief.generatedAt]);
    return (<react_native_1.View style={sc.wrap}>
      <react_native_1.View style={sc.row}>
        <lucide_react_native_1.Zap size={11} color={tokens_1.color.signal} fill={tokens_1.color.signal}/>
        <react_native_1.Text style={sc.label} numberOfLines={1}>{brief.summaryText}</react_native_1.Text>
      </react_native_1.View>
      {((_d = brief.planPreview) === null || _d === void 0 ? void 0 : _d[0]) && (<react_native_1.Text style={sc.next} numberOfLines={1}>
          Next: {brief.planPreview[0].title}
        </react_native_1.Text>)}
      {topSuggestion && (<react_native_1.View style={sc.sugRow}>
          <lucide_react_native_1.Sparkles size={10} color={tokens_1.color.signal}/>
          <react_native_1.Text style={sc.sugText} numberOfLines={1}>{topSuggestion.title}</react_native_1.Text>
        </react_native_1.View>)}
      {ageLabel && <react_native_1.Text style={sc.ageLabel}>{ageLabel}</react_native_1.Text>}
      <react_native_1.Pressable style={sc.btn} onPress={function () { return expo_router_1.router.push("/trip/".concat(tripId)); }}>
        <react_native_1.Text style={sc.btnText}>Full Brief</react_native_1.Text>
      </react_native_1.Pressable>
    </react_native_1.View>);
}
function WeatherBanner(_a) {
    var summary = _a.summary;
    var lower = summary.toLowerCase();
    var isRainy = lower.includes('rain') || lower.includes('shower') || lower.includes('thunderstorm');
    var isSunny = lower.includes('sunny') || lower.includes('clear sky');
    var bgColor = isRainy ? '#E3F2FD' : isSunny ? '#FFF8E1' : '#EFF6FF';
    var iconColor = isRainy ? '#1565C0' : isSunny ? '#F59E0B' : '#3B82F6';
    var Icon = isRainy ? lucide_react_native_1.CloudRain : isSunny ? lucide_react_native_1.Sun : lucide_react_native_1.Cloud;
    return (<react_native_1.View style={[s.weatherBanner, { backgroundColor: bgColor }]}>
      <Icon size={12} color={iconColor}/>
      <react_native_1.Text style={[s.weatherText, { color: iconColor }]} numberOfLines={2}>{summary}</react_native_1.Text>
    </react_native_1.View>);
}
function forecastIcon(code) {
    if (code === 0 || code === 1)
        return lucide_react_native_1.Sun;
    if (code >= 51)
        return lucide_react_native_1.CloudRain;
    return lucide_react_native_1.Cloud;
}
function forecastIconColor(code) {
    if (code === 0 || code === 1)
        return '#F59E0B';
    if (code >= 51)
        return '#1565C0';
    return '#3B82F6';
}
function shortDay(dateStr) {
    var d = new Date(dateStr + 'T12:00:00Z');
    return d.toLocaleDateString('en', { weekday: 'short' });
}
function WeatherForecastStrip(_a) {
    var forecasts = _a.forecasts;
    if (forecasts.length === 0)
        return null;
    return (<react_native_1.View style={s.forecastWrap}>
      <react_native_1.Text style={s.forecastLabel}>TRIP FORECAST</react_native_1.Text>
      <react_native_1.ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.forecastRow}>
        {forecasts.map(function (f) {
            var Icon = forecastIcon(f.weatherCode);
            var iconColor = forecastIconColor(f.weatherCode);
            return (<react_native_1.View key={f.date} style={s.forecastDay}>
              <react_native_1.Text style={s.forecastDayName}>{shortDay(f.date)}</react_native_1.Text>
              <Icon size={16} color={iconColor}/>
              <react_native_1.Text style={s.forecastHigh}>{f.maxTempC}°</react_native_1.Text>
              <react_native_1.Text style={s.forecastLow}>{f.minTempC}°</react_native_1.Text>
            </react_native_1.View>);
        })}
      </react_native_1.ScrollView>
    </react_native_1.View>);
}
function PlanRow(_a) {
    var _b;
    var item = _a.item;
    return (<react_native_1.View style={s.planRow}>
      <react_native_1.View style={s.planDot}/>
      <react_native_1.View style={{ flex: 1 }}>
        <react_native_1.Text style={s.planTitle} numberOfLines={1}>{item.title}</react_native_1.Text>
        {item.startsAt && <react_native_1.Text style={s.planTime}>{formatTime(item.startsAt)}</react_native_1.Text>}
        {item.locationName && <react_native_1.Text style={s.planLoc} numberOfLines={1}>{item.locationName}</react_native_1.Text>}
        {((_b = item.warnings) === null || _b === void 0 ? void 0 : _b.length) > 0 && (<react_native_1.View style={s.planWarnRow}>
            <lucide_react_native_1.AlertTriangle size={10} color={tokens_1.color.warn}/>
            <react_native_1.Text style={s.planWarnText}>{item.warnings.join(', ')}</react_native_1.Text>
          </react_native_1.View>)}
      </react_native_1.View>
    </react_native_1.View>);
}
function EventSuggestionRow(_a) {
    var suggestion = _a.suggestion, tripId = _a.tripId, onDismiss = _a.onDismiss;
    var categoryLabel = suggestion.category === 'nightlife' ? 'Music' : suggestion.category === 'outdoor' ? 'Sports' : 'Event';
    return (<react_native_1.View style={s.eventRow}>
      <react_native_1.View style={s.eventIconCol}>
        <lucide_react_native_1.Ticket size={14} color={tokens_1.color.signal}/>
      </react_native_1.View>
      <react_native_1.View style={{ flex: 1 }}>
        <react_native_1.View style={s.eventTitleRow}>
          <react_native_1.Text style={s.eventTitle} numberOfLines={1}>{suggestion.title}</react_native_1.Text>
          <react_native_1.View style={s.eventBadge}>
            <react_native_1.Text style={s.eventBadgeText}>{categoryLabel.toUpperCase()}</react_native_1.Text>
          </react_native_1.View>
        </react_native_1.View>
        <react_native_1.Text style={s.eventReason} numberOfLines={2}>{suggestion.reason}</react_native_1.Text>
        <react_native_1.Text style={s.eventMeta}>{suggestion.estimatedTime} · {suggestion.priceLevel}</react_native_1.Text>
      </react_native_1.View>
      <TelegraphFeedbackMenu_1.TelegraphFeedbackMenu recommendationId={suggestion.id} category={suggestion.category} tripId={tripId} onDismiss={onDismiss}/>
    </react_native_1.View>);
}
function SuggestionRow(_a) {
    var suggestion = _a.suggestion, tripId = _a.tripId, onDismiss = _a.onDismiss;
    return (<react_native_1.View style={s.sugRow}>
      <react_native_1.View style={{ flex: 1 }}>
        {suggestion.forGapDay && (<react_native_1.View style={s.gapDayBadge}>
            <lucide_react_native_1.Calendar size={9} color={tokens_1.color.signal}/>
            <react_native_1.Text style={s.gapDayBadgeText}>{formatShortDate(suggestion.forGapDay)}</react_native_1.Text>
          </react_native_1.View>)}
        <react_native_1.View style={s.sugTitleRow}>
          <lucide_react_native_1.Sparkles size={12} color={tokens_1.color.signal}/>
          <react_native_1.Text style={s.sugTitle} numberOfLines={1}>{suggestion.title}</react_native_1.Text>
          <react_native_1.Text style={s.sugPrice}>{suggestion.priceLevel}</react_native_1.Text>
        </react_native_1.View>
        <react_native_1.Text style={s.sugReason} numberOfLines={2}>{suggestion.reason}</react_native_1.Text>
        <react_native_1.Text style={s.sugTime}>{suggestion.estimatedTime}</react_native_1.Text>
      </react_native_1.View>
      <TelegraphFeedbackMenu_1.TelegraphFeedbackMenu recommendationId={suggestion.id} category={suggestion.category} tripId={tripId} onDismiss={onDismiss}/>
    </react_native_1.View>);
}
/**
 * Returns a concise, descriptive label for a quick-action chip.
 *
 * For meal-nudge chips (those with params.meetupTime), the meal label is
 * derived from the meetup's scheduled hour so it always matches context:
 *   07–10 → breakfast, 11–13 → lunch, 17+ → dinner.
 *
 * Other kinds are mapped to short, human-readable labels.
 * Falls back to the server-provided action.label for anything unrecognised.
 */
function chipLabelForAction(action) {
    var _a, _b;
    // Meal nudge — derive from the meetup's scheduled hour
    if ((_a = action.params) === null || _a === void 0 ? void 0 : _a.meetupTime) {
        var h = new Date(action.params.meetupTime).getHours();
        if (h >= 7 && h < 11)
            return 'Find breakfast nearby';
        if (h >= 11 && h < 14)
            return 'Find lunch spot';
        if (h >= 17)
            return 'Find dinner option';
    }
    // Specific action kinds → fixed descriptive labels
    switch (action.kind) {
        case 'view_plan': return 'View plan';
        case 'create_meetup': return 'Plan a meetup';
        case 'add_to_plan': return 'Add to trip plan';
        case 'open_poll': return 'See the poll';
    }
    // Fall back to server-provided label (e.g. "Fill free time", "Plan today", "Ask Telegraph")
    return (_b = action.label) !== null && _b !== void 0 ? _b : 'Quick action';
}
function handleQuickAction(action, tripId) {
    var _a, _b, _c, _d;
    switch (action.kind) {
        case 'view_plan':
            expo_router_1.router.push("/trip/".concat(tripId));
            break;
        case 'ask_telegraph': {
            // Navigate to trip detail — ConciergeCommandBar lives there.
            // Pass the prompt and any structured meetup context as search params so
            // the bar pre-fills the text and Telegraph receives location/time context.
            if (!((_a = action.params) === null || _a === void 0 ? void 0 : _a.prompt)) {
                expo_router_1.router.push("/trip/".concat(tripId));
                break;
            }
            var params = new URLSearchParams({
                telegraphPrompt: action.params.prompt,
            });
            if ((_b = action.params) === null || _b === void 0 ? void 0 : _b.meetupId) {
                params.set('telegraphMeetupId', action.params.meetupId);
                if ((_c = action.params) === null || _c === void 0 ? void 0 : _c.meetupTime)
                    params.set('telegraphMeetupTime', action.params.meetupTime);
                if ((_d = action.params) === null || _d === void 0 ? void 0 : _d.meetupLocation)
                    params.set('telegraphMeetupLocation', action.params.meetupLocation);
            }
            expo_router_1.router.push("/trip/".concat(tripId, "?").concat(params.toString()));
            break;
        }
        case 'add_to_plan':
            expo_router_1.router.push("/trip/".concat(tripId));
            break;
        case 'create_meetup':
            // Navigate to meetup creation if the route exists; fall back to trip detail.
            expo_router_1.router.push("/trip/".concat(tripId));
            break;
        case 'open_poll':
            expo_router_1.router.push("/trip/".concat(tripId));
            break;
        default:
            expo_router_1.router.push("/trip/".concat(tripId));
    }
}
function formatGeneratedAt(ms) {
    var d = new Date(ms);
    var now = new Date();
    var isToday = d.toDateString() === now.toDateString();
    var time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    return isToday ? time : "".concat(d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), " ").concat(time);
}
function formatDate(iso) {
    if (!iso)
        return '';
    var d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}
function formatShortDate(iso) {
    if (!iso)
        return '';
    var d = new Date(iso + 'T00:00:00Z');
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
function formatTime(iso) {
    var d = new Date(iso);
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}
function friendlyWarning(w) {
    var _a;
    var map = {
        time_overlap: 'Schedule conflict detected',
        cancelled_meetup: 'A meetup was cancelled',
        free_window_unplanned: 'Your day has unplanned windows',
        late_addition: 'Item added late — check your plan',
    };
    return (_a = map[w]) !== null && _a !== void 0 ? _a : w;
}
var s = react_native_1.StyleSheet.create({
    wrap: { backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, marginHorizontal: tokens_1.space.lg, marginTop: tokens_1.space.xl, overflow: 'hidden' },
    loadRow: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm, padding: tokens_1.space.lg },
    loadText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    errorText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, padding: tokens_1.space.lg }),
    retryBtn: { paddingHorizontal: tokens_1.space.lg, paddingBottom: tokens_1.space.md },
    retryText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, fontWeight: '700' }),
    deniedRow: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm, padding: tokens_1.space.lg },
    deniedText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, flex: 1, lineHeight: 17 }),
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: tokens_1.space.lg, borderBottomWidth: 1, borderBottomColor: tokens_1.color.haze },
    headerLeft: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.md },
    icon: { width: 26, height: 26, borderRadius: 13, backgroundColor: '#FFF0EE', alignItems: 'center', justifyContent: 'center' },
    headerTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 14 }),
    headerDate: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
    headerDateSub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11, paddingHorizontal: tokens_1.space.lg, paddingTop: 4 }),
    generatedAtRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: tokens_1.space.sm, paddingHorizontal: tokens_1.space.lg, paddingTop: 2, paddingBottom: tokens_1.space.sm },
    generatedAt: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 10 }),
    staleBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#FEF3C7', borderWidth: 1, borderColor: '#FCD34D', borderRadius: tokens_1.radius.pill, paddingHorizontal: 7, paddingVertical: 3 },
    staleBadgeText: __assign(__assign({}, tokens_1.type.small), { color: '#92400E', fontSize: 10, fontWeight: '600' }),
    destRow: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 1 },
    destText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, fontSize: 11 }),
    headerRight: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm },
    refreshBtn: { padding: 4 },
    summary: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, fontSize: 13, lineHeight: 18, padding: tokens_1.space.lg, paddingBottom: tokens_1.space.sm }),
    weatherBanner: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, paddingHorizontal: tokens_1.space.lg, paddingVertical: 7 },
    weatherText: __assign(__assign({}, tokens_1.type.small), { fontSize: 11, lineHeight: 16, flex: 1 }),
    warningRow: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: '#FFF8E1', paddingHorizontal: tokens_1.space.lg, paddingVertical: 6 },
    warningText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.warn, fontSize: 11, flex: 1 }),
    section: { paddingHorizontal: tokens_1.space.lg, paddingTop: tokens_1.space.md },
    sectionLabel: __assign(__assign({}, tokens_1.type.stamp), { fontFamily: 'Courier', color: tokens_1.color.mute, fontSize: 10, letterSpacing: 0.8, marginBottom: tokens_1.space.sm }),
    chipRow: { gap: tokens_1.space.sm, paddingBottom: tokens_1.space.sm },
    chip: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: '#E8F0F2', paddingHorizontal: tokens_1.space.md, paddingVertical: 5, borderRadius: tokens_1.radius.pill },
    chipText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.deep, fontSize: 11 }),
    planRow: { flexDirection: 'row', alignItems: 'flex-start', gap: tokens_1.space.sm, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: tokens_1.color.haze },
    planDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: tokens_1.color.signal, marginTop: 5 },
    planTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 13 }),
    planTime: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
    planLoc: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
    planWarnRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
    planWarnText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.warn, fontSize: 10 }),
    gapChip: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: '#FFF0EE', paddingHorizontal: tokens_1.space.md, paddingVertical: 5, borderRadius: tokens_1.radius.pill, borderWidth: 1, borderColor: '#FFD9D4' },
    gapChipText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, fontSize: 11 }),
    sugRow: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: tokens_1.space.sm, borderBottomWidth: 1, borderBottomColor: tokens_1.color.haze, gap: tokens_1.space.sm },
    gapDayBadge: { flexDirection: 'row', alignItems: 'center', gap: 3, marginBottom: 3 },
    gapDayBadgeText: __assign(__assign({}, tokens_1.type.stamp), { fontFamily: 'Courier', color: tokens_1.color.signal, fontSize: 9, letterSpacing: 0.5 }),
    sugTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 2 },
    sugTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 13, flex: 1 }),
    sugPrice: __assign(__assign({}, tokens_1.type.stamp), { fontFamily: 'Courier', color: tokens_1.color.mute, fontSize: 11 }),
    sugReason: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11, lineHeight: 16 }),
    sugTime: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.faint, fontSize: 10, marginTop: 2 }),
    eventRow: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: tokens_1.space.sm, borderBottomWidth: 1, borderBottomColor: tokens_1.color.haze, gap: tokens_1.space.sm },
    eventIconCol: { width: 24, alignItems: 'center', paddingTop: 2 },
    eventTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2, flexWrap: 'wrap' },
    eventTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 13, flexShrink: 1 }),
    eventBadge: { backgroundColor: '#FFF0EE', borderRadius: tokens_1.radius.pill, paddingHorizontal: 6, paddingVertical: 2 },
    eventBadgeText: __assign(__assign({}, tokens_1.type.stamp), { color: tokens_1.color.signal, fontSize: 9, fontWeight: '700', letterSpacing: 0.5 }),
    eventReason: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11, lineHeight: 16 }),
    eventMeta: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.faint, fontSize: 10, marginTop: 2 }),
    actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: tokens_1.space.sm, padding: tokens_1.space.lg, paddingTop: tokens_1.space.md },
    actionBtn: { paddingHorizontal: tokens_1.space.md, paddingVertical: 7, borderRadius: tokens_1.radius.pill, borderWidth: 1, borderColor: tokens_1.color.signal, backgroundColor: '#FFF0EE' },
    actionText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, fontWeight: '700', fontSize: 12 }),
    forecastWrap: { paddingHorizontal: tokens_1.space.lg, paddingVertical: tokens_1.space.sm },
    forecastLabel: __assign(__assign({}, tokens_1.type.stamp), { fontFamily: 'Courier', color: tokens_1.color.mute, fontSize: 10, letterSpacing: 0.8, marginBottom: tokens_1.space.sm }),
    forecastRow: { gap: tokens_1.space.sm, paddingBottom: 2 },
    forecastDay: { alignItems: 'center', gap: 3, backgroundColor: '#F8F8F8', borderRadius: tokens_1.radius.md, paddingHorizontal: 10, paddingVertical: 8, minWidth: 54 },
    forecastDayName: __assign(__assign({}, tokens_1.type.stamp), { fontFamily: 'Courier', color: tokens_1.color.mute, fontSize: 10, letterSpacing: 0.3 }),
    forecastHigh: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 12, fontWeight: '700' }),
    forecastLow: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
});
var sc = react_native_1.StyleSheet.create({
    wrap: { backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, marginHorizontal: tokens_1.space.lg, marginTop: tokens_1.space.md, padding: tokens_1.space.md },
    row: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    label: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.ink, fontSize: 12, flex: 1 }),
    next: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11, marginTop: 2 }),
    sugRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3 },
    sugText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, fontSize: 11, flex: 1 }),
    ageLabel: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 10, marginTop: 3 }),
    btn: { alignSelf: 'flex-end', marginTop: tokens_1.space.sm, paddingHorizontal: tokens_1.space.md, paddingVertical: 5, borderRadius: tokens_1.radius.pill, borderWidth: 1, borderColor: tokens_1.color.haze },
    btnText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.ink, fontSize: 11, fontWeight: '700' }),
});
