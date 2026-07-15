"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mockEvents = exports.mockAvailability = void 0;
var cebu_1 = require("./cebu");
// Drae is on a Cebu trip, open evenings/late; recurring weekend evenings.
exports.mockAvailability = {
    weekly: { days: { fri: ['evening', 'late'], sat: ['evening', 'late'], sun: ['afternoon', 'evening'] } },
    trips: [
        { id: 'tw1', citySlug: 'cebu', startDate: '2026-06-10', endDate: '2026-06-27', blocks: ['evening', 'late'] },
    ],
    openToMeet: true,
    strict: false,
};
var at = function (day, hour) {
    return new Date("2026-06-".concat(day, "T").concat(String(hour).padStart(2, '0'), ":00:00+08:00")).toISOString();
};
exports.mockEvents = [
    // inside availability (Cebu, evening/late during trip window)
    { id: 'e1', kind: 'plan', title: 'Sunset dive @ Mactan', citySlug: 'cebu', city: 'Cebu', startAt: at('20', 18), block: 'evening', category: 'adventure', host: cebu_1.users[0], attendeeCount: 4, capacity: 6, score: null },
    { id: 'e2', kind: 'plan', title: 'IT Park food crawl', citySlug: 'cebu', city: 'Cebu', startAt: at('21', 20), block: 'evening', category: 'food', host: cebu_1.users[2], attendeeCount: 7, capacity: 10, score: null },
    { id: 'e3', kind: 'meetup', title: 'Rooftop travelers’ mixer', citySlug: 'cebu', city: 'Cebu', startAt: at('22', 22), block: 'late', category: 'nightlife', host: cebu_1.users[3], attendeeCount: 12, capacity: 20, score: null },
    // outside availability (Cebu, morning/afternoon -> flexible)
    { id: 'e4', kind: 'event', title: 'Sunrise yoga, Mactan beach', citySlug: 'cebu', city: 'Cebu', startAt: at('21', 6), block: 'morning', category: 'wellness', attendeeCount: 9, capacity: 15, score: null },
    { id: 'e5', kind: 'plan', title: 'Kawasan canyoneering day trip', citySlug: 'cebu', city: 'Cebu', startAt: at('23', 8), block: 'morning', category: 'adventure', host: cebu_1.users[3], attendeeCount: 5, capacity: 8, score: null },
    // other city (not current) — appears lower / for search
    { id: 'e6', kind: 'plan', title: 'Intramuros night walk', citySlug: 'manila', city: 'Manila', startAt: at('28', 19), block: 'evening', category: 'culture', attendeeCount: 6, capacity: 12, score: null },
];
