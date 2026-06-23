"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.useFollowingHighlights = useFollowingHighlights;
/**
 * useFollowingHighlights — fetches the highlights feed for followed users.
 *
 * Returns a list of HighlightFeedUser entries (users with active highlights),
 * a session-local viewed set so rings mute after viewing without waiting for
 * the next server round-trip, and a markSessionViewed callback.
 */
var react_1 = require("react");
var highlights_1 = require("../services/highlights");
var useHighlightRingState_1 = require("./useHighlightRingState");
function useFollowingHighlights() {
    var _a = (0, react_1.useState)([]), users = _a[0], setUsers = _a[1];
    var _b = (0, react_1.useState)(false), loading = _b[0], setLoading = _b[1];
    var _c = (0, react_1.useState)(0), refreshKey = _c[0], setRefreshKey = _c[1];
    var _d = (0, react_1.useState)(function () { return new Set(useHighlightRingState_1.viewedHighlightIds); }), sessionViewedIds = _d[0], setSessionViewedIds = _d[1];
    (0, react_1.useEffect)(function () {
        var cancelled = false;
        setLoading(true);
        (0, highlights_1.fetchFollowingHighlightsFeed)()
            .then(function (r) {
            if (cancelled)
                return;
            setUsers(r.ok && r.data ? r.data : []);
        })
            .catch(function () {
            if (!cancelled)
                setUsers([]);
        })
            .finally(function () {
            if (!cancelled)
                setLoading(false);
        });
        return function () {
            cancelled = true;
        };
    }, [refreshKey]);
    var refresh = (0, react_1.useCallback)(function () { return setRefreshKey(function (k) { return k + 1; }); }, []);
    var markSessionViewed = (0, react_1.useCallback)(function (ids) {
        for (var _i = 0, ids_1 = ids; _i < ids_1.length; _i++) {
            var id = ids_1[_i];
            (0, useHighlightRingState_1.markViewed)(id);
        }
        setSessionViewedIds(function (prev) {
            var next = new Set(prev);
            for (var _i = 0, ids_2 = ids; _i < ids_2.length; _i++) {
                var id = ids_2[_i];
                next.add(id);
            }
            return next;
        });
    }, []);
    return { users: users, loading: loading, refresh: refresh, sessionViewedIds: sessionViewedIds, markSessionViewed: markSessionViewed };
}
