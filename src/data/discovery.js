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
Object.defineProperty(exports, "__esModule", { value: true });
exports.savedIdeas = exports.travelerPicks = exports.neighborhoods = exports.hiddenGems = exports.DISCOVERY_CATEGORIES = exports.featuredExperiences = exports.forYouSide = exports.compassPick = void 0;
var SEED = { source: 'seed', status: 'provisional', verified: false };
/** Top Compass pick — provisional, must use cautious wording in UI. */
exports.compassPick = __assign({ id: 'cp1', name: 'LIV Superclub', category: 'nightlife', neighborhood: 'IT Park', city: 'Cebu City', blurb: 'Often associated with Cebu’s nightlife scene.', savedCount: 0 }, SEED);
/** Two side cards beside the Compass pick. */
exports.forYouSide = [
    __assign({ id: 'sn1', name: 'Colon Street', category: 'culture', neighborhood: 'Downtown', city: 'Cebu City', blurb: 'Often associated with heritage travel — among the oldest streets in the country.' }, SEED),
    {
        id: 'pw1', name: 'Kawasan Falls', category: 'adventure',
        neighborhood: 'Badian', city: 'Cebu',
        blurb: 'A popular travel theme: turquoise falls and canyoneering.',
        savedCount: 521, source: 'traveler', status: 'provisional', verified: false,
    },
];
/** Featured experiences — horizontal cards. */
exports.featuredExperiences = [
    __assign({ id: 'fx1', name: 'Lechon Crawl', category: 'food', neighborhood: 'Cebu City', city: 'Cebu', blurb: 'Often associated with the city’s lechon spots.' }, SEED),
    __assign({ id: 'fx2', name: 'Rooftop Bars', category: 'nightlife', neighborhood: 'IT Park', city: 'Cebu', blurb: 'Popular travel theme: skyline views after dark.' }, SEED),
    __assign({ id: 'fx3', name: 'Island Hopping', category: 'beach', neighborhood: 'Mactan & Olango', city: 'Cebu', blurb: 'A popular theme for beaches near Cebu.' }, SEED),
    __assign({ id: 'fx4', name: 'Cultural Spots', category: 'culture', neighborhood: 'Cebu City', city: 'Cebu', blurb: 'Often associated with history and churches.' }, SEED),
    __assign({ id: 'fx5', name: 'Spa & Wellness', category: 'wellness', neighborhood: 'Lahug', city: 'Cebu', blurb: 'A popular theme for relaxation and recharge.' }, SEED),
];
exports.DISCOVERY_CATEGORIES = [
    'All', 'Food', 'Nightlife', 'Beach', 'Culture', 'Shopping', 'Wellness', 'Hidden Gems', 'More',
];
/* ── Pass 2 seed: gems, neighborhoods, traveler picks, saved ── */
var TRAVELER = function (name, avatarUrl) { return ({ name: name, avatarUrl: avatarUrl }); };
exports.hiddenGems = [
    __assign({ id: 'hg1', name: 'The Backspace Cafe', category: 'hidden_gem', neighborhood: 'Lahug, Cebu City', city: 'Cebu', blurb: 'Cozy cafe with great coffee and quiet vibes.', submittedBy: TRAVELER('Anna', 'https://i.pravatar.cc/120?img=5') }, SEED),
    __assign({ id: 'hg2', name: 'Sirao Garden', category: 'hidden_gem', neighborhood: 'Sirao, Cebu', city: 'Cebu', blurb: 'Flower garden with mountain views.', submittedBy: TRAVELER('Mark', 'https://i.pravatar.cc/120?img=12') }, SEED),
    __assign({ id: 'hg3', name: 'Sugbo Mercado', category: 'hidden_gem', neighborhood: 'IT Park, Cebu City', city: 'Cebu', blurb: 'Food market with local vendors and live music.', submittedBy: TRAVELER('Jessa', 'https://i.pravatar.cc/120?img=9') }, SEED),
    __assign({ id: 'hg4', name: 'Tamagas Falls', category: 'hidden_gem', neighborhood: 'Alegria, Cebu', city: 'Cebu', blurb: 'Hidden waterfall and natural lagoon.', submittedBy: TRAVELER('Carlo', 'https://i.pravatar.cc/120?img=15') }, SEED),
    __assign({ id: 'hg5', name: 'Speakeasy Cebu', category: 'hidden_gem', neighborhood: 'Capitol Site', city: 'Cebu', blurb: 'Hidden bar with craft cocktails.', submittedBy: TRAVELER('Vince', 'https://i.pravatar.cc/120?img=33') }, SEED),
];
exports.neighborhoods = [
    __assign({ id: 'nb1', vibe: 'Best for Nightlife', area: 'IT Park', tags: ['nightlife', 'food'], blurb: 'Often associated with bars, late food, and rooftop spots.' }, SEED),
    __assign({ id: 'nb2', vibe: 'Best for Food', area: 'Lahug', tags: ['food', 'cafes'], blurb: 'A popular travel theme: cafes and local eats.' }, SEED),
    __assign({ id: 'nb3', vibe: 'Best for Beach', area: 'Mactan Island', tags: ['beach', 'resorts'], blurb: 'Often associated with beaches and island hopping.' }, SEED),
    __assign({ id: 'nb4', vibe: 'Best for Culture', area: 'Cebu City', tags: ['culture', 'history'], blurb: 'A popular theme for heritage and churches.' }, SEED),
    __assign({ id: 'nb5', vibe: 'Best for Relaxation', area: 'Busay', tags: ['quiet', 'views'], blurb: 'Often associated with quiet stays and mountain views.' }, SEED),
];
exports.travelerPicks = [
    { id: 'tp1', user: TRAVELER('Leo', 'https://i.pravatar.cc/120?img=8'), place: 'The Distillery Cebu', note: 'Great cocktails and vibes!', city: 'Cebu City', rating: 4.6, tag: 'Nightlife', timeAgo: '2h ago', source: 'traveler', status: 'provisional', verified: false },
    { id: 'tp2', user: TRAVELER('Mia', 'https://i.pravatar.cc/120?img=20'), place: 'Casa Verde Cebu', note: 'Amazing Spanish food!', city: 'Cebu City', rating: 4.7, tag: 'Food', timeAgo: '5h ago', source: 'traveler', status: 'provisional', verified: false },
    { id: 'tp3', user: TRAVELER('Josh', 'https://i.pravatar.cc/120?img=14'), place: 'Virgin Island', note: 'Crystal clear waters.', city: 'Bantayan', rating: 4.8, tag: 'Beach', timeAgo: '1d ago', source: 'traveler', status: 'provisional', verified: false },
];
exports.savedIdeas = [
    { id: 'sv1', name: 'Cebu Lechon House', type: 'Restaurant', neighborhood: 'Lahug' },
    { id: 'sv2', name: 'Sumilon Island', type: 'Island', neighborhood: 'Oslob' },
    { id: 'sv3', name: 'La Vie Parisienne', type: 'Cafe', neighborhood: 'Cebu City' },
];
