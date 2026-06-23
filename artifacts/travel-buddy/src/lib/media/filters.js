"use strict";
/**
 * Travel Buddy media filter library.
 *
 * 12 named filters expressed as CSS filter component values. Intensity (0–100)
 * linearly interpolates each component between the identity value (no effect)
 * and the preset value (full effect). buildCssFilter() produces a complete CSS
 * filter string suitable for React Native's `style.filter` (web) or an
 * overlay description for native rendering.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.FILTER_IDS = exports.mediaFilters = void 0;
exports.getMediaFilter = getMediaFilter;
exports.buildCssFilter = buildCssFilter;
var IDENTITY = {
    brightness: 1,
    contrast: 1,
    saturate: 1,
    sepia: 0,
    hueRotate: 0,
    grayscale: 0,
};
exports.mediaFilters = [
    {
        id: 'original',
        name: 'Original',
        description: 'No filter applied.',
        values: IDENTITY,
        defaultIntensity: 100,
        supportsVideo: true,
    },
    {
        id: 'wanderlust',
        name: 'Wanderlust',
        description: 'Warm, saturated travel look.',
        values: { brightness: 1.05, contrast: 1.1, saturate: 1.5, sepia: 0.1, hueRotate: 0, grayscale: 0 },
        defaultIntensity: 80,
        supportsVideo: true,
    },
    {
        id: 'golden_hour',
        name: 'Golden Hour',
        description: 'Warm golden afternoon light.',
        values: { brightness: 1.1, contrast: 1.05, saturate: 1.2, sepia: 0.35, hueRotate: 0, grayscale: 0 },
        defaultIntensity: 75,
        supportsVideo: true,
    },
    {
        id: 'deep_ocean',
        name: 'Deep Ocean',
        description: 'Cool blue coastal tones.',
        values: { brightness: 0.95, contrast: 1.15, saturate: 1.3, sepia: 0, hueRotate: 195, grayscale: 0 },
        defaultIntensity: 70,
        supportsVideo: true,
    },
    {
        id: 'mist',
        name: 'Mist',
        description: 'Faded, soft morning haze.',
        values: { brightness: 1.1, contrast: 0.85, saturate: 0.6, sepia: 0.05, hueRotate: 0, grayscale: 0 },
        defaultIntensity: 80,
        supportsVideo: true,
    },
    {
        id: 'polaroid',
        name: 'Polaroid',
        description: 'High contrast retro snapshot.',
        values: { brightness: 1.05, contrast: 1.25, saturate: 1.15, sepia: 0.15, hueRotate: 0, grayscale: 0 },
        defaultIntensity: 85,
        supportsVideo: true,
    },
    {
        id: 'noir',
        name: 'Noir',
        description: 'Classic black and white.',
        values: { brightness: 1.0, contrast: 1.2, saturate: 0, sepia: 0, hueRotate: 0, grayscale: 1 },
        defaultIntensity: 100,
        supportsVideo: true,
    },
    {
        id: 'safari',
        name: 'Safari',
        description: 'Warm earthy savanna tones.',
        values: { brightness: 1.05, contrast: 1.1, saturate: 0.9, sepia: 0.4, hueRotate: 15, grayscale: 0 },
        defaultIntensity: 75,
        supportsVideo: true,
    },
    {
        id: 'vivid',
        name: 'Vivid',
        description: 'Punchy ultra-saturated colours.',
        values: { brightness: 1.05, contrast: 1.2, saturate: 2.0, sepia: 0, hueRotate: 0, grayscale: 0 },
        defaultIntensity: 70,
        supportsVideo: true,
    },
    {
        id: 'sunset',
        name: 'Sunset',
        description: 'Orange-red evening warmth.',
        values: { brightness: 1.05, contrast: 1.1, saturate: 1.4, sepia: 0.5, hueRotate: -10, grayscale: 0 },
        defaultIntensity: 75,
        supportsVideo: true,
    },
    {
        id: 'arctic',
        name: 'Arctic',
        description: 'Crisp cool polar light.',
        values: { brightness: 1.1, contrast: 1.1, saturate: 0.7, sepia: 0, hueRotate: 210, grayscale: 0 },
        defaultIntensity: 80,
        supportsVideo: true,
    },
    {
        id: 'velvet',
        name: 'Velvet',
        description: 'Dark moody cinematic depth.',
        values: { brightness: 0.85, contrast: 1.35, saturate: 1.1, sepia: 0.1, hueRotate: 0, grayscale: 0 },
        defaultIntensity: 85,
        supportsVideo: true,
    },
];
/** Map for O(1) lookup by filter id. */
var filterMap = new Map(exports.mediaFilters.map(function (f) { return [f.id, f]; }));
function getMediaFilter(id) {
    var _a;
    return (_a = filterMap.get(id !== null && id !== void 0 ? id : '')) !== null && _a !== void 0 ? _a : exports.mediaFilters[0];
}
/**
 * Linearly interpolate each CSS filter component between the identity value and
 * the preset value at the given intensity (0–100). Returns a CSS filter string.
 *
 * At intensity=0  → effectively "Original" (identity values).
 * At intensity=100 → full preset values.
 */
function buildCssFilter(filter, intensity) {
    if (filter.id === 'original')
        return 'none';
    var t = Math.max(0, Math.min(100, intensity)) / 100;
    var lerp = function (identity, preset) { return identity + (preset - identity) * t; };
    var b = lerp(IDENTITY.brightness, filter.values.brightness);
    var c = lerp(IDENTITY.contrast, filter.values.contrast);
    var s = lerp(IDENTITY.saturate, filter.values.saturate);
    var sep = lerp(IDENTITY.sepia, filter.values.sepia);
    var hr = lerp(IDENTITY.hueRotate, filter.values.hueRotate);
    var gr = lerp(IDENTITY.grayscale, filter.values.grayscale);
    var parts = [];
    if (Math.abs(b - 1) > 0.001)
        parts.push("brightness(".concat(b.toFixed(3), ")"));
    if (Math.abs(c - 1) > 0.001)
        parts.push("contrast(".concat(c.toFixed(3), ")"));
    if (Math.abs(s - 1) > 0.001)
        parts.push("saturate(".concat(s.toFixed(3), ")"));
    if (sep > 0.001)
        parts.push("sepia(".concat(sep.toFixed(3), ")"));
    if (Math.abs(hr) > 0.1)
        parts.push("hue-rotate(".concat(hr.toFixed(1), "deg)"));
    if (gr > 0.001)
        parts.push("grayscale(".concat(gr.toFixed(3), ")"));
    return parts.length > 0 ? parts.join(' ') : 'none';
}
/** All valid filter IDs — used by API validators. */
exports.FILTER_IDS = exports.mediaFilters.map(function (f) { return f.id; });
