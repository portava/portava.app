"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.useAvailability = useAvailability;
exports.useCityPulse = useCityPulse;
/**
 * useAvailability + useCityPulse — data seams.
 * Availability now reads from the session store (editable); events still mock.
 * Swap event body for API GET later (same shapes).
 */
var react_1 = require("react");
var events_1 = require("../data/events");
var recommend_1 = require("../lib/recommend");
var availability_1 = require("../lib/availability");
var AvailabilityStore_1 = require("../context/AvailabilityStore");
function useAvailability() {
    // Reads from the in-memory session store (seeded from mock). Edits propagate live.
    var availability = (0, AvailabilityStore_1.useAvailabilityStore)().availability;
    return { availability: availability, loading: false, error: null };
}
function useCityPulse(opts) {
    var availability = useAvailability().availability;
    // TODO(backend): GET /pulse/events?city=...
    var events = events_1.mockEvents;
    var buckets = (0, react_1.useMemo)(function () { return (0, recommend_1.filterPulse)(events, { availability: availability, currentCitySlug: opts.currentCitySlug, interests: opts.interests }); }, [events, availability, opts.currentCitySlug, opts.interests]);
    var status = (0, availability_1.resolveStatus)(availability, new Date().toISOString(), opts.currentCitySlug);
    return { buckets: buckets, availability: availability, status: status, loading: false, error: null };
}
