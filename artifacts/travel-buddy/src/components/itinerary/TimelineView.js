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
exports.STATUS_STYLE = exports.CAT_STYLE = void 0;
exports.fmtTime = fmtTime;
exports.dayLabel = dayLabel;
exports.TimelineView = TimelineView;
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var tripPlan_1 = require("../../services/tripPlan");
var tokens_1 = require("../../theme/tokens");
// ── Category / status maps ─────────────────────────────────────────────────────
exports.CAT_STYLE = {
    accommodation: { bg: '#E2EDF0', fg: tokens_1.color.deep, label: 'Stay' },
    activity: { bg: '#E3F1EA', fg: tokens_1.color.success, label: 'Activity' },
    dining: { bg: '#FCE9E4', fg: tokens_1.color.signal, label: 'Dining' },
    transport: { bg: '#EFE7FA', fg: '#7A4DBF', label: 'Transport' },
    free_time: { bg: '#F5F0E8', fg: '#8B6914', label: 'Free time' },
    meeting_point: { bg: '#FFF0D0', fg: '#B07000', label: 'Meetup' },
    other: { bg: tokens_1.color.haze, fg: tokens_1.color.mute, label: 'Other' },
};
exports.STATUS_STYLE = {
    confirmed: { bg: '#E3F1EA', fg: tokens_1.color.success },
    tentative: { bg: '#F5F0E8', fg: '#8B6914' },
    done: { bg: tokens_1.color.haze, fg: tokens_1.color.mute },
    cancelled: { bg: '#FCE9E4', fg: '#B0291A' },
};
// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtTime(iso) {
    if (!iso)
        return null;
    var d = new Date(iso);
    if (isNaN(d.getTime()))
        return null;
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function dayLabel(key, tripStartDate) {
    if (key === '__unscheduled__')
        return 'Unscheduled';
    var d = new Date(key + 'T00:00:00');
    if (isNaN(d.getTime()))
        return key;
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    var ms = d.getTime();
    if (ms === today.getTime())
        return 'Today';
    if (ms === tomorrow.getTime())
        return 'Tomorrow';
    if (tripStartDate) {
        var start = new Date(tripStartDate + 'T00:00:00');
        if (!isNaN(start.getTime())) {
            var dayNum = Math.round((ms - start.getTime()) / 86400000) + 1;
            if (dayNum >= 1)
                return "Day ".concat(dayNum, " \u2014 ").concat(d.toLocaleDateString([], { month: 'short', day: 'numeric' }));
        }
    }
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}
// Reconcile a proposed display order against the authoritative id set: keep the
// proposed order for ids that still exist, drop ids no longer present, and append
// any authoritative ids missing from the proposed order (e.g. items a teammate
// added mid-drag). Used to honour remote add/remove without losing a local move.
function reconcileMembership(proposed, authoritative) {
    var authSet = new Set(authoritative);
    var kept = proposed.filter(function (id) { return authSet.has(id); });
    var keptSet = new Set(kept);
    var added = authoritative.filter(function (id) { return !keptSet.has(id); });
    return __spreadArray(__spreadArray([], kept, true), added, true);
}
// ── Warning badge strip ───────────────────────────────────────────────────────
var WARN_SHORT = {
    time_overlap: '⚡ Conflict',
    duplicate: '🔁 Duplicate',
    outside_trip_dates: '📅 Off-schedule',
    missing_location: '📍 No location',
    cancelled_source: '🚫 Cancelled',
};
function WarningBadges(_a) {
    var warnings = _a.warnings;
    if (!warnings || warnings.length === 0)
        return null;
    return (<react_native_1.View style={wb.row}>
      {warnings.map(function (w) {
            var _a;
            return (<react_native_1.View key={w} style={wb.badge}>
          <lucide_react_native_1.AlertTriangle size={9} color="#B07000"/>
          <react_native_1.Text style={wb.text}>{(_a = WARN_SHORT[w]) !== null && _a !== void 0 ? _a : w}</react_native_1.Text>
        </react_native_1.View>);
        })}
    </react_native_1.View>);
}
function PlanItemCard(_a) {
    var _b, _c, _d;
    var item = _a.item, currentUserId = _a.currentUserId, isOwner = _a.isOwner, canEdit = _a.canEdit, tripId = _a.tripId, onPress = _a.onPress, onEditPress = _a.onEditPress, onRemove = _a.onRemove, onMarkDone = _a.onMarkDone, onMarkTentative = _a.onMarkTentative, onEdited = _a.onEdited, onMoveToUnscheduled = _a.onMoveToUnscheduled, dragHandlers = _a.dragHandlers, isDragging = _a.isDragging;
    var _e = (0, react_1.useState)(false), menuOpen = _e[0], setMenuOpen = _e[1];
    var cat = (_b = exports.CAT_STYLE[item.category]) !== null && _b !== void 0 ? _b : exports.CAT_STYLE.other;
    var statusStyle = (_c = exports.STATUS_STYLE[item.status]) !== null && _c !== void 0 ? _c : exports.STATUS_STYLE.tentative;
    var canAct = canEdit && (isOwner || item.creatorId === currentUserId);
    var timeStr = fmtTime(item.startsAt);
    var hasWarnings = item.warnings && item.warnings.length > 0;
    return (<>
      <react_native_1.View style={[ic.row, isDragging && ic.rowDragging]}>
        {canEdit && dragHandlers && (<react_native_1.View style={ic.handle} {...dragHandlers}>
            <lucide_react_native_1.GripVertical size={18} color={isDragging ? tokens_1.color.deep : tokens_1.color.faint}/>
          </react_native_1.View>)}

        <react_native_1.Pressable style={[ic.card, hasWarnings && ic.cardWarn, { flex: 1 }]} onPress={function () { return onPress(item); }}>
          <react_native_1.View style={ic.top}>
            <react_native_1.View style={[ic.catBadge, { backgroundColor: cat.bg }]}>
              <react_native_1.Text style={[ic.catText, { color: cat.fg }]}>{cat.label}</react_native_1.Text>
            </react_native_1.View>
            {item.sourceType !== 'manual' && (<react_native_1.View style={ic.sourceBadge}>
                <lucide_react_native_1.Tag size={9} color={tokens_1.color.mute}/>
                <react_native_1.Text style={ic.sourceText}>{item.sourceType === 'meetup' ? 'Meetup' : 'Place'}</react_native_1.Text>
              </react_native_1.View>)}
            <react_native_1.View style={{ flex: 1 }}/>
            <react_native_1.View style={[ic.statusBadge, { backgroundColor: statusStyle.bg }]}>
              <react_native_1.Text style={[ic.statusText, { color: statusStyle.fg }]}>{item.status}</react_native_1.Text>
            </react_native_1.View>
            {canAct && (<react_native_1.Pressable hitSlop={8} onPress={function () { return setMenuOpen(true); }} style={ic.moreBtn}>
                <lucide_react_native_1.MoreHorizontal size={16} color={tokens_1.color.mute}/>
              </react_native_1.Pressable>)}
          </react_native_1.View>

          <react_native_1.Text style={[ic.title, item.status === 'done' && ic.titleDone]} numberOfLines={2}>
            {item.title}
          </react_native_1.Text>

          <WarningBadges warnings={(_d = item.warnings) !== null && _d !== void 0 ? _d : []}/>

          {(timeStr || item.locationName) && (<react_native_1.View style={ic.metaRow}>
              {timeStr && (<react_native_1.View style={ic.metaItem}>
                  <lucide_react_native_1.Clock size={11} color={tokens_1.color.mute}/>
                  <react_native_1.Text style={ic.metaText}>{timeStr}</react_native_1.Text>
                </react_native_1.View>)}
              {item.locationName ? (<react_native_1.View style={ic.metaItem}>
                  <lucide_react_native_1.MapPin size={11} color={tokens_1.color.mute}/>
                  <react_native_1.Text style={ic.metaText} numberOfLines={1}>{item.locationName}</react_native_1.Text>
                </react_native_1.View>) : (item.category === 'accommodation' || item.category === 'meeting_point') ? (<react_native_1.View style={[ic.metaItem, ic.locationHidden]}>
                  <lucide_react_native_1.MapPin size={11} color="#8B6914"/>
                  <react_native_1.Text style={ic.locationHiddenText}>Location TBD</react_native_1.Text>
                </react_native_1.View>) : null}
            </react_native_1.View>)}
        </react_native_1.Pressable>
      </react_native_1.View>

      <react_native_1.Modal visible={menuOpen} transparent animationType="fade" onRequestClose={function () { return setMenuOpen(false); }}>
        <react_native_1.Pressable style={ic.menuOverlay} onPress={function () { return setMenuOpen(false); }}>
          <react_native_1.View style={ic.menuSheet}>
            <react_native_1.Text style={ic.menuTitle} numberOfLines={1}>{item.title}</react_native_1.Text>

            <react_native_1.Pressable style={ic.menuItem} onPress={function () { setMenuOpen(false); onPress(item); }}>
              <lucide_react_native_1.Tag size={16} color={tokens_1.color.deep}/>
              <react_native_1.Text style={ic.menuItemText}>View details</react_native_1.Text>
            </react_native_1.Pressable>

            {canAct && (<>
                <react_native_1.Pressable style={ic.menuItem} onPress={function () { setMenuOpen(false); onEditPress(item); }}>
                  <lucide_react_native_1.Pencil size={16} color={tokens_1.color.deep}/>
                  <react_native_1.Text style={ic.menuItemText}>Edit / Reschedule</react_native_1.Text>
                </react_native_1.Pressable>

                {item.dayDate && (<react_native_1.Pressable style={ic.menuItem} onPress={function () { setMenuOpen(false); onMoveToUnscheduled(item.id); }}>
                    <lucide_react_native_1.Clock size={16} color={tokens_1.color.mute}/>
                    <react_native_1.Text style={ic.menuItemText}>Move to unscheduled</react_native_1.Text>
                  </react_native_1.Pressable>)}

                {item.status !== 'done' && (<react_native_1.Pressable style={ic.menuItem} onPress={function () { setMenuOpen(false); onMarkDone(item.id); }}>
                    <lucide_react_native_1.CheckCircle2 size={16} color={tokens_1.color.success}/>
                    <react_native_1.Text style={ic.menuItemText}>Mark as done</react_native_1.Text>
                  </react_native_1.Pressable>)}
                {item.status !== 'tentative' && (<react_native_1.Pressable style={ic.menuItem} onPress={function () { setMenuOpen(false); onMarkTentative(item.id); }}>
                    <lucide_react_native_1.Clock size={16} color={tokens_1.color.mute}/>
                    <react_native_1.Text style={ic.menuItemText}>Mark as tentative</react_native_1.Text>
                  </react_native_1.Pressable>)}

                <react_native_1.Pressable style={ic.menuItem} onPress={function () { setMenuOpen(false); onRemove(item.id); }}>
                  <lucide_react_native_1.Trash2 size={16} color={tokens_1.color.signal}/>
                  <react_native_1.Text style={[ic.menuItemText, { color: tokens_1.color.signal }]}>Remove from plan</react_native_1.Text>
                </react_native_1.Pressable>
              </>)}

            <react_native_1.Pressable style={ic.menuCancel} onPress={function () { return setMenuOpen(false); }}>
              <react_native_1.Text style={ic.menuCancelText}>Cancel</react_native_1.Text>
            </react_native_1.Pressable>
          </react_native_1.View>
        </react_native_1.Pressable>
      </react_native_1.Modal>
    </>);
}
function DraggableItemList(_a) {
    var _this = this;
    var items = _a.items, tripId = _a.tripId, currentUserId = _a.currentUserId, isOwner = _a.isOwner, canEdit = _a.canEdit, onItemPress = _a.onItemPress, onEditPress = _a.onEditPress, onItemsChanged = _a.onItemsChanged, onRemove = _a.onRemove, onMarkDone = _a.onMarkDone, onMarkTentative = _a.onMarkTentative, onMoveToUnscheduled = _a.onMoveToUnscheduled, firstWarnedId = _a.firstWarnedId, warnedItemRef = _a.warnedItemRef;
    // Local display order (IDs); actual item data comes from `items` prop.
    var _b = (0, react_1.useState)(function () { return items.map(function (i) { return i.id; }); }), order = _b[0], setOrder = _b[1];
    var itemMap = (0, react_1.useMemo)(function () { return Object.fromEntries(items.map(function (i) { return [i.id, i]; })); }, [items]);
    // Drag state (refs for gesture tracking, state for re-render triggers)
    var activeIdxRef = (0, react_1.useRef)(-1);
    var activeAnim = (0, react_1.useRef)(new react_native_1.Animated.Value(0)).current;
    var _c = (0, react_1.useState)(0), forceUpdate = _c[1];
    var currentDragIdx = (0, react_1.useRef)(-1); // tracks current visual swap position
    var itemHeightsRef = (0, react_1.useRef)({});
    var getEstimatedHeight = (0, react_1.useCallback)(function (id) {
        var _a;
        return (_a = itemHeightsRef.current[id]) !== null && _a !== void 0 ? _a : 100;
    }, []);
    // Sync local display order when the items prop changes (add / remove / remote reorder).
    // While a drag is in progress we must NOT clobber the in-flight order: keep the
    // current order and only append new / drop removed ids. When idle we adopt the
    // canonical server order so reorders made by other members are reflected.
    // Holds a canonical server order that arrived mid-drag; applied once the drag ends.
    var pendingServerOrderRef = (0, react_1.useRef)(null);
    var prevItemsRef = (0, react_1.useRef)(items);
    if (prevItemsRef.current !== items) {
        prevItemsRef.current = items;
        var incoming = items.map(function (i) { return i.id; });
        var dragging = activeIdxRef.current >= 0;
        if (dragging) {
            // Don't disturb the in-flight gesture; remember the canonical order and
            // reconcile to it when the drag is released/terminated.
            pendingServerOrderRef.current = incoming;
        }
        else {
            pendingServerOrderRef.current = null;
            if (incoming.join(',') !== order.join(',')) {
                setOrder(incoming);
            }
        }
    }
    // Apply any order that arrived while a drag was active (called on drag end).
    var applyPendingOrder = (0, react_1.useCallback)(function () {
        var pending = pendingServerOrderRef.current;
        pendingServerOrderRef.current = null;
        if (pending) {
            setOrder(function (cur) { return (pending.join(',') !== cur.join(',') ? pending : cur); });
        }
    }, []);
    var commitReorder = (0, react_1.useCallback)(function (oldOrder, newOrder) { return __awaiter(_this, void 0, void 0, function () {
        var changed;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (oldOrder.join(',') === newOrder.join(','))
                        return [2 /*return*/];
                    changed = newOrder
                        .map(function (id, idx) { return ({ id: id, sortOrder: (idx + 1) * 1000 }); })
                        .filter(function (_a) {
                        var id = _a.id, sortOrder = _a.sortOrder;
                        var oldIdx = oldOrder.indexOf(id);
                        return oldIdx !== newOrder.indexOf(id) || sortOrder !== (oldIdx + 1) * 1000;
                    });
                    return [4 /*yield*/, Promise.all(changed.map(function (_a) {
                            var id = _a.id, sortOrder = _a.sortOrder;
                            return (0, tripPlan_1.reorderPlanItem)(tripId, id, sortOrder).catch(function () {
                                // silent: UI already reflects order; API failure is non-blocking
                            });
                        }))];
                case 1:
                    _a.sent();
                    // Notify parent so the canonical list stays in sync. Guard against emitting
                    // unknown/partial items: only keep ids that resolve to a real item, and
                    // append any locally-known ids missing from newOrder rather than dropping them.
                    onItemsChanged(function (prev) {
                        var byId = new Map(prev.map(function (i) { return [i.id, i]; }));
                        var resolvable = newOrder.filter(function (id) { return byId.has(id) || itemMap[id]; });
                        var missing = prev.map(function (i) { return i.id; }).filter(function (id) { return !resolvable.includes(id); });
                        var finalIds = __spreadArray(__spreadArray([], resolvable, true), missing, true);
                        return finalIds.map(function (id, idx) {
                            var _a;
                            var base = (_a = byId.get(id)) !== null && _a !== void 0 ? _a : itemMap[id];
                            return __assign(__assign({}, base), { sortOrder: (idx + 1) * 1000 });
                        });
                    });
                    return [2 /*return*/];
            }
        });
    }); }, [tripId, itemMap, onItemsChanged]);
    // Build one PanResponder per slot; recreate when order changes so index is correct.
    var panResponders = (0, react_1.useMemo)(function () {
        if (!canEdit)
            return [];
        return order.map(function (_, slotIdx) {
            return react_native_1.PanResponder.create({
                onStartShouldSetPanResponder: function () { return true; },
                onMoveShouldSetPanResponder: function (_, g) { return Math.abs(g.dy) > 4; },
                onMoveShouldSetPanResponderCapture: function (_, g) { return Math.abs(g.dy) > 4; },
                onPanResponderGrant: function () {
                    activeIdxRef.current = slotIdx;
                    currentDragIdx.current = slotIdx;
                    activeAnim.setValue(0);
                    forceUpdate(function (n) { return n + 1; });
                },
                onPanResponderMove: function (_, g) {
                    activeAnim.setValue(g.dy);
                    // Compute which slot the card has drifted into
                    var accumulated = 0;
                    var newSlot = slotIdx;
                    if (g.dy > 0) {
                        for (var k = slotIdx + 1; k < order.length; k++) {
                            accumulated += getEstimatedHeight(order[k]);
                            if (g.dy < accumulated - getEstimatedHeight(order[k]) / 2)
                                break;
                            newSlot = k;
                        }
                    }
                    else {
                        for (var k = slotIdx - 1; k >= 0; k--) {
                            accumulated -= getEstimatedHeight(order[k]);
                            if (g.dy > accumulated + getEstimatedHeight(order[k]) / 2)
                                break;
                            newSlot = k;
                        }
                    }
                    if (newSlot !== currentDragIdx.current) {
                        currentDragIdx.current = newSlot;
                        forceUpdate(function (n) { return n + 1; });
                    }
                },
                onPanResponderRelease: function () {
                    var from = activeIdxRef.current;
                    var to = currentDragIdx.current;
                    activeIdxRef.current = -1;
                    currentDragIdx.current = -1;
                    react_native_1.Animated.timing(activeAnim, {
                        toValue: 0, duration: 120, useNativeDriver: true,
                    }).start(function () { return forceUpdate(function (n) { return n + 1; }); });
                    if (from !== to && from >= 0 && to >= 0) {
                        // Local reorder is the newer write (last-write-wins for position), but
                        // membership (remote add/remove arriving mid-drag) must still be
                        // honoured. Rebase the local move onto the latest canonical id set.
                        var pending_1 = pendingServerOrderRef.current;
                        pendingServerOrderRef.current = null;
                        setOrder(function (prev) {
                            var next = __spreadArray([], prev, true);
                            var moved = next.splice(from, 1)[0];
                            next.splice(to, 0, moved);
                            var finalOrder = pending_1 ? reconcileMembership(next, pending_1) : next;
                            commitReorder(prev, finalOrder);
                            return finalOrder;
                        });
                    }
                    else {
                        // No local move — reconcile to any order that arrived during the drag.
                        applyPendingOrder();
                        forceUpdate(function (n) { return n + 1; });
                    }
                },
                onPanResponderTerminate: function () {
                    activeIdxRef.current = -1;
                    currentDragIdx.current = -1;
                    activeAnim.setValue(0);
                    applyPendingOrder();
                    forceUpdate(function (n) { return n + 1; });
                },
            });
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [order, canEdit]);
    // Build the visual render list.
    // While dragging to a different slot we:
    //   • Show the dragged card lifted (translateY) and dimmed at its origin slot
    //   • Insert a dashed placeholder at the current target slot so users can see the drop position
    //   • Other items naturally shift to make room for the placeholder
    var activeIdx = activeIdxRef.current;
    var targetIdx = currentDragIdx.current;
    var isDragging = activeIdx >= 0 && activeIdx < order.length;
    var showPlaceholder = isDragging && targetIdx !== activeIdx && targetIdx >= 0;
    var renderEntries = [];
    if (!showPlaceholder) {
        order.forEach(function (id, slotIdx) { return renderEntries.push({ kind: 'item', id: id, slotIdx: slotIdx }); });
    }
    else {
        var draggedHeight_1 = getEstimatedHeight(order[activeIdx]);
        var placeholderBeforeDragged_1 = targetIdx < activeIdx;
        order.forEach(function (id, slotIdx) {
            // Insert placeholder before this item when target is above the dragged slot
            if (slotIdx === targetIdx && placeholderBeforeDragged_1) {
                renderEntries.push({ kind: 'placeholder', height: draggedHeight_1 });
            }
            renderEntries.push({ kind: 'item', id: id, slotIdx: slotIdx });
            // Insert placeholder after this item when target is below the dragged slot
            if (slotIdx === targetIdx && !placeholderBeforeDragged_1) {
                renderEntries.push({ kind: 'placeholder', height: draggedHeight_1 });
            }
        });
    }
    return (<>
      {renderEntries.map(function (entry) {
            if (entry.kind === 'placeholder') {
                return (<react_native_1.View key="__drag_placeholder__" style={[dl.placeholder, { height: entry.height }]}/>);
            }
            var id = entry.id, slotIdx = entry.slotIdx;
            var item = itemMap[id];
            if (!item)
                return null;
            var isActive = activeIdx === slotIdx;
            var pr = panResponders[slotIdx];
            var card = (<PlanItemCard item={item} currentUserId={currentUserId} isOwner={isOwner} canEdit={canEdit} tripId={tripId} onPress={onItemPress} onEditPress={onEditPress} onRemove={onRemove} onMarkDone={onMarkDone} onMarkTentative={onMarkTentative} onEdited={function (updated) { return onItemsChanged(function (prev) { return prev.map(function (i) { return i.id === updated.id ? updated : i; }); }); }} onMoveToUnscheduled={onMoveToUnscheduled} dragHandlers={pr === null || pr === void 0 ? void 0 : pr.panHandlers} isDragging={isActive}/>);
            return (<react_native_1.Animated.View key={id} style={isActive
                    ? { transform: [{ translateY: activeAnim }], zIndex: 10, opacity: showPlaceholder ? 0.55 : 0.85 }
                    : undefined} onLayout={function (e) {
                    itemHeightsRef.current[id] = e.nativeEvent.layout.height;
                }}>
            {id === firstWarnedId && warnedItemRef
                    ? <react_native_1.View ref={warnedItemRef}>{card}</react_native_1.View>
                    : card}
          </react_native_1.Animated.View>);
        })}
    </>);
}
// ── Day group ─────────────────────────────────────────────────────────────────
function DayGroup(_a) {
    var _this = this;
    var bucket = _a.bucket, tripStartDate = _a.tripStartDate, tripId = _a.tripId, currentUserId = _a.currentUserId, isOwner = _a.isOwner, canEdit = _a.canEdit, onItemPress = _a.onItemPress, onEditPress = _a.onEditPress, onItemsChanged = _a.onItemsChanged, firstWarnedId = _a.firstWarnedId, warnedItemRef = _a.warnedItemRef;
    var label = dayLabel(bucket.key, tripStartDate);
    var isUnscheduled = bucket.key === '__unscheduled__';
    var handleRemove = function (itemId) {
        react_native_1.Alert.alert('Remove item', 'Remove this item from the trip plan?', [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Remove', style: 'destructive', onPress: function () { return __awaiter(_this, void 0, void 0, function () {
                    var _a;
                    return __generator(this, function (_b) {
                        switch (_b.label) {
                            case 0:
                                _b.trys.push([0, 2, , 3]);
                                return [4 /*yield*/, (0, tripPlan_1.removePlanItem)(tripId, itemId)];
                            case 1:
                                _b.sent();
                                onItemsChanged(function (prev) { return prev.filter(function (i) { return i.id !== itemId; }); });
                                return [3 /*break*/, 3];
                            case 2:
                                _a = _b.sent();
                                react_native_1.Alert.alert('Error', 'Could not remove item. Please try again.');
                                return [3 /*break*/, 3];
                            case 3: return [2 /*return*/];
                        }
                    });
                }); },
            },
        ]);
    };
    var handleMarkDone = function (itemId) { return __awaiter(_this, void 0, void 0, function () {
        var updated_1, _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    _b.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, (0, tripPlan_1.updatePlanItem)(tripId, itemId, { status: 'done' })];
                case 1:
                    updated_1 = _b.sent();
                    onItemsChanged(function (prev) { return prev.map(function (i) { return i.id === itemId ? updated_1 : i; }); });
                    return [3 /*break*/, 3];
                case 2:
                    _a = _b.sent();
                    react_native_1.Alert.alert('Error', 'Could not update item.');
                    return [3 /*break*/, 3];
                case 3: return [2 /*return*/];
            }
        });
    }); };
    var handleMarkTentative = function (itemId) { return __awaiter(_this, void 0, void 0, function () {
        var updated_2, _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    _b.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, (0, tripPlan_1.updatePlanItem)(tripId, itemId, { status: 'tentative' })];
                case 1:
                    updated_2 = _b.sent();
                    onItemsChanged(function (prev) { return prev.map(function (i) { return i.id === itemId ? updated_2 : i; }); });
                    return [3 /*break*/, 3];
                case 2:
                    _a = _b.sent();
                    react_native_1.Alert.alert('Error', 'Could not update item.');
                    return [3 /*break*/, 3];
                case 3: return [2 /*return*/];
            }
        });
    }); };
    var handleMoveToUnscheduled = function (itemId) { return __awaiter(_this, void 0, void 0, function () {
        var updated_3, _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    _b.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, (0, tripPlan_1.updatePlanItem)(tripId, itemId, { dayDate: null, startsAt: null, endsAt: null })];
                case 1:
                    updated_3 = _b.sent();
                    onItemsChanged(function (prev) { return prev.map(function (i) { return i.id === itemId ? updated_3 : i; }); });
                    return [3 /*break*/, 3];
                case 2:
                    _a = _b.sent();
                    react_native_1.Alert.alert('Error', 'Could not update item.');
                    return [3 /*break*/, 3];
                case 3: return [2 /*return*/];
            }
        });
    }); };
    return (<react_native_1.View style={dg.group}>
      <react_native_1.View style={[dg.header, isUnscheduled && dg.headerUnscheduled]}>
        <react_native_1.View style={[dg.dot, isUnscheduled && dg.dotUnscheduled]}/>
        <react_native_1.Text style={[dg.label, isUnscheduled && dg.labelUnscheduled]}>{label}</react_native_1.Text>
        <react_native_1.View style={dg.line}/>
        <react_native_1.Text style={dg.count}>{bucket.items.length}</react_native_1.Text>
      </react_native_1.View>

      {bucket.items.length === 0 ? (<react_native_1.Text style={dg.emptyDay}>Nothing planned yet.</react_native_1.Text>) : (<DraggableItemList items={bucket.items} tripId={tripId} currentUserId={currentUserId} isOwner={isOwner} canEdit={canEdit} onItemPress={onItemPress} onEditPress={onEditPress} onItemsChanged={onItemsChanged} onRemove={handleRemove} onMarkDone={handleMarkDone} onMarkTentative={handleMarkTentative} onMoveToUnscheduled={handleMoveToUnscheduled} firstWarnedId={firstWarnedId} warnedItemRef={warnedItemRef}/>)}
    </react_native_1.View>);
}
function TimelineView(_a) {
    var buckets = _a.buckets, tripStartDate = _a.tripStartDate, tripId = _a.tripId, currentUserId = _a.currentUserId, isOwner = _a.isOwner, canEdit = _a.canEdit, onItemPress = _a.onItemPress, onEditPress = _a.onEditPress, onItemsChanged = _a.onItemsChanged, firstWarnedId = _a.firstWarnedId, warnedItemRef = _a.warnedItemRef;
    if (buckets.length === 0 || buckets.every(function (b) { return b.items.length === 0; })) {
        return (<react_native_1.View style={tv.empty}>
        <react_native_1.Text style={tv.emptyTitle}>No items for this filter.</react_native_1.Text>
      </react_native_1.View>);
    }
    return (<react_native_1.View style={tv.wrap}>
      {buckets.map(function (bucket) { return (<DayGroup key={bucket.key} bucket={bucket} tripStartDate={tripStartDate} tripId={tripId} currentUserId={currentUserId} isOwner={isOwner} canEdit={canEdit} onItemPress={onItemPress} onEditPress={onEditPress} onItemsChanged={onItemsChanged} firstWarnedId={firstWarnedId} warnedItemRef={warnedItemRef}/>); })}
    </react_native_1.View>);
}
// ── Styles ────────────────────────────────────────────────────────────────────
var wb = react_native_1.StyleSheet.create({
    row: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4 },
    badge: { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: '#FFF3CD', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2 },
    text: { fontSize: 10, color: '#8B6914', fontWeight: '600' },
});
var ic = react_native_1.StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'stretch', marginBottom: 8 },
    rowDragging: { opacity: 0.85 },
    handle: { width: 28, justifyContent: 'center', alignItems: 'center', paddingRight: 2 },
    card: { backgroundColor: '#fff', borderRadius: tokens_1.radius.lg, padding: 12, borderWidth: 1, borderColor: tokens_1.color.haze, gap: 4 },
    cardWarn: { borderLeftWidth: 4, borderLeftColor: '#F59E0B', borderColor: '#F5D77B' },
    top: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    catBadge: { borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2 },
    catText: { fontSize: 10, fontWeight: '700' },
    sourceBadge: { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: tokens_1.color.haze, borderRadius: 5, paddingHorizontal: 5, paddingVertical: 2 },
    sourceText: { fontSize: 10, color: tokens_1.color.mute, fontWeight: '600' },
    statusBadge: { borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2 },
    statusText: { fontSize: 10, fontWeight: '700' },
    moreBtn: { padding: 2 },
    title: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, fontWeight: '600', lineHeight: 20 }),
    titleDone: { textDecorationLine: 'line-through', color: tokens_1.color.mute },
    metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 2 },
    metaItem: { flexDirection: 'row', alignItems: 'center', gap: 3 },
    metaText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    locationHidden: { backgroundColor: '#FFF8E7', borderRadius: 6, paddingHorizontal: 5, paddingVertical: 2 },
    locationHiddenText: __assign(__assign({}, tokens_1.type.small), { color: '#8B6914', fontWeight: '500' }),
    menuOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
    menuSheet: { backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: tokens_1.space.lg, paddingBottom: 36, gap: 4 },
    menuTitle: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontWeight: '600', marginBottom: 8 }),
    menuItem: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: tokens_1.color.haze },
    menuItemText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink }),
    menuCancel: { alignItems: 'center', paddingVertical: 12, marginTop: 4 },
    menuCancelText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute, fontWeight: '600' }),
});
var dg = react_native_1.StyleSheet.create({
    group: { marginBottom: 16 },
    header: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
    headerUnscheduled: { opacity: 0.65 },
    dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: tokens_1.color.deep },
    dotUnscheduled: { backgroundColor: tokens_1.color.faint },
    label: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.ink, fontWeight: '700', fontSize: 13 }),
    labelUnscheduled: { color: tokens_1.color.mute, fontStyle: 'italic' },
    line: { flex: 1, height: 1, backgroundColor: tokens_1.color.haze },
    count: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.faint }),
    emptyDay: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.faint, paddingLeft: 18, paddingBottom: 4 }),
});
var dl = react_native_1.StyleSheet.create({
    placeholder: {
        marginBottom: 8,
        borderRadius: tokens_1.radius.lg,
        borderWidth: 2,
        borderColor: tokens_1.color.deep,
        borderStyle: 'dashed',
        backgroundColor: 'rgba(30, 90, 120, 0.06)',
    },
});
var tv = react_native_1.StyleSheet.create({
    wrap: { gap: 0 },
    empty: { paddingVertical: 24, alignItems: 'center' },
    emptyTitle: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.faint }),
});
