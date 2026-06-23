"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pulseFeed = void 0;
exports.withEditorial = withEditorial;
var cebu_1 = require("./cebu");
var A = function (i) { return ({ id: cebu_1.users[i % cebu_1.users.length].id, name: cebu_1.users[i % cebu_1.users.length].name, avatarUrl: cebu_1.users[i % cebu_1.users.length].avatarUrl }); };
exports.pulseFeed = [
    {
        id: 'pf1', type: 'post', city: 'Cebu City', neighborhood: 'IT Park',
        author: A(0), createdAt: '2026-06-16T09:00:00Z', timeAgo: '2h ago',
        tags: ['Cafe', 'IT Park'], source: 'user',
        caption: 'Best cafe find today in IT Park! Great coffee and sunset vibes.',
        likeCount: 48, commentCount: 12, availabilityMatch: true,
    },
    {
        id: 'pf2', type: 'question', city: 'Mactan',
        author: A(1), createdAt: '2026-06-16T10:00:00Z', timeAgo: '1h ago',
        tags: ['Beach', 'Nightlife'], source: 'user',
        question: 'Best beach club in Mactan tonight?', replyCount: 23, availabilityMatch: true,
    },
    {
        id: 'pf3', type: 'plan', city: 'Olango Island',
        author: A(2), host: A(2), createdAt: '2026-06-16T08:00:00Z', timeAgo: '3h ago',
        tags: ['Adventure', 'Water'], source: 'user',
        title: 'Island Hopping & Snorkeling', time: 'Tomorrow · 9:00 AM',
        attendeeCount: 9, availabilityMatch: true,
    },
    {
        id: 'pf4', type: 'circle_activity', city: 'Cebu City',
        createdAt: '2026-06-16T11:00:00Z', timeAgo: '20m ago', tags: [], source: 'circle',
        activityText: '3 people in your Circle are open tonight',
        participants: [A(0), A(1), A(2), A(3)],
    },
    {
        id: 'pf5', type: 'hidden_gem', city: 'Cebu', neighborhood: 'Oslob, Cebu',
        author: A(3), createdAt: '2026-06-15T09:00:00Z', timeAgo: '1d ago',
        tags: ['Nature'], source: 'user', title: 'Tumalog Falls',
        blurb: 'Worth the short trip! Beautiful and not too crowded.',
    },
    {
        id: 'pf6', type: 'itinerary', city: 'Cebu', neighborhood: 'Cebu City',
        author: A(4), createdAt: '2026-06-15T12:00:00Z', timeAgo: '1d ago',
        tags: ['Food', 'Culture'], source: 'user',
        title: 'A Perfect Cebu Food Day', estimate: '~6 hrs',
        steps: ['Lechon lunch in Talisay', 'Cafe + walk in IT Park', 'Sugbo Mercado night eats'],
    },
    {
        id: 'pf7', type: 'compass_suggestion', city: 'Cebu City', neighborhood: 'IT Park',
        createdAt: '2026-06-16T11:30:00Z', tags: ['Nightlife'], source: 'compass',
        title: 'LIV Superclub', reason: 'Matches your nightlife + food interests, inside your availability',
        isProvisional: true,
    },
    {
        id: 'pf8', type: 'city_note', city: 'Cebu', neighborhood: 'Downtown',
        createdAt: '2026-06-10T00:00:00Z', tags: ['Culture'], source: 'seed',
        title: 'Colon Street', blurb: 'Often associated with heritage travel — among the oldest streets in the country.',
        isProvisional: true,
    },
];
/** Editorial inspiration items (kept, but labeled). Pulled from existing posts. */
function withEditorial(items) {
    return items; // editorial PostCards render separately below; see Pulse screen
}
