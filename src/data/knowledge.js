"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cityKnowledge = void 0;
exports.knowledgeFor = knowledgeFor;
var SEED_AT = '2026-06-16T00:00:00Z';
exports.cityKnowledge = [
    {
        citySlug: 'cebu', city: 'Cebu', country: 'Philippines',
        knownFor: ['diving', 'island hopping', 'lechon', 'historic basilica'],
        vibeTags: ['island', 'beach', 'food'],
        popularAreas: ['Mactan', 'IT Park', 'Moalboal', 'Carbon Market'],
        categories: ['beach', 'food', 'adventure', 'nightlife'],
        source: 'seed', status: 'provisional', verified: false, updatedAt: SEED_AT,
    },
    {
        citySlug: 'manila', city: 'Manila', country: 'Philippines',
        knownFor: ['Intramuros', 'history', 'street food', 'nightlife'],
        vibeTags: ['urban', 'historic', 'busy'],
        popularAreas: ['Intramuros', 'Makati', 'BGC', 'Binondo'],
        categories: ['culture', 'food', 'nightlife', 'shopping'],
        source: 'seed', status: 'provisional', verified: false, updatedAt: SEED_AT,
    },
    {
        citySlug: 'tokyo', city: 'Tokyo', country: 'Japan',
        knownFor: ['temples', 'ramen', 'shopping', 'neon nightlife'],
        vibeTags: ['urban', 'culture', 'food'],
        popularAreas: ['Shibuya', 'Asakusa', 'Shinjuku', 'Akihabara'],
        categories: ['culture', 'food', 'shopping', 'nightlife'],
        source: 'seed', status: 'provisional', verified: false, updatedAt: SEED_AT,
    },
    {
        citySlug: 'bangkok', city: 'Bangkok', country: 'Thailand',
        knownFor: ['street food', 'temples', 'markets', 'nightlife'],
        vibeTags: ['urban', 'food', 'lively'],
        popularAreas: ['Sukhumvit', 'Khao San', 'Chinatown', 'Chatuchak'],
        categories: ['food', 'culture', 'nightlife', 'shopping'],
        source: 'seed', status: 'provisional', verified: false, updatedAt: SEED_AT,
    },
];
function knowledgeFor(citySlug) {
    if (!citySlug)
        return undefined;
    return exports.cityKnowledge.find(function (k) { return k.citySlug === citySlug.toLowerCase(); });
}
