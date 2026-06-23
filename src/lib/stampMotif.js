"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.motifFor = motifFor;
var knowledge_1 = require("../data/knowledge");
/* City slug -> signature icon + accent. Hand-seeded, provisional. */
var CITY_MOTIF = {
    cebu: { iconKey: 'Fish', accent: '#0A3D4A', caption: 'DIVING' },
    manila: { iconKey: 'Landmark', accent: '#7A4DBF', caption: 'HISTORY' },
    tokyo: { iconKey: 'TorusIcon', accent: '#C0392B', caption: 'TEMPLES' },
    bangkok: { iconKey: 'Soup', accent: '#C8851A', caption: 'STREET FOOD' },
};
/* Category fallback motif by stamp kind. Never provisional. */
var KIND_MOTIF = {
    city: { iconKey: 'MapPin', accent: '#0A3D4A' },
    plan: { iconKey: 'Users', accent: '#FF4D2E' },
    gem: { iconKey: 'Gem', accent: '#7A4DBF' },
    safe: { iconKey: 'ShieldCheck', accent: '#2E7D5B' },
    host: { iconKey: 'Crown', accent: '#11110F' },
    perk: { iconKey: 'Ticket', accent: '#C8851A' },
};
/**
 * Try to read a city slug from a stamp. City stamps encode the place in
 * label/sublabel; we match against known cities. Loose by design — falls back
 * to category motif when no city is recognized.
 */
function citySlugFromStamp(stamp) {
    var _a;
    var hay = "".concat(stamp.label, " ").concat((_a = stamp.sublabel) !== null && _a !== void 0 ? _a : '').toLowerCase();
    for (var _i = 0, _b = Object.keys(CITY_MOTIF); _i < _b.length; _i++) {
        var slug = _b[_i];
        if (hay.includes(slug))
            return slug;
    }
    return undefined;
}
function motifFor(stamp) {
    // City stamps get the city motif when recognized.
    if (stamp.kind === 'city') {
        var slug = citySlugFromStamp(stamp);
        if (slug) {
            var m = CITY_MOTIF[slug];
            var k_1 = (0, knowledge_1.knowledgeFor)(slug);
            return {
                iconKey: m.iconKey,
                accent: m.accent,
                frame: 'oval',
                caption: m.caption,
                provisional: k_1 ? k_1.status !== 'verified' : true,
            };
        }
    }
    // Fallback: category motif (rectangular frame to visually differ from cities).
    var k = KIND_MOTIF[stamp.kind];
    return { iconKey: k.iconKey, accent: k.accent, frame: 'rect', provisional: false };
}
