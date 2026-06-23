"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.usePassport = usePassport;
/**
 * usePassport — loads the owner's full passport data.
 * Calls GET /api/me/profile + GET /api/me/passport/postcards + GET /api/me/stamps in parallel.
 * Falls back to mock data if backend is not configured.
 */
var react_1 = require("react");
var profile_1 = require("../services/profile");
var supabase_1 = require("../lib/supabase");
var passport_1 = require("../data/passport");
function usePassport() {
    var _a = (0, react_1.useState)(null), profile = _a[0], setProfile = _a[1];
    var _b = (0, react_1.useState)([]), postcards = _b[0], setPostcards = _b[1];
    var _c = (0, react_1.useState)([]), stamps = _c[0], setStamps = _c[1];
    var _d = (0, react_1.useState)(true), loading = _d[0], setLoading = _d[1];
    var _e = (0, react_1.useState)(null), error = _e[0], setError = _e[1];
    var _f = (0, react_1.useState)(0), tick = _f[0], setTick = _f[1];
    // Ref tracks whether we already have data — always current, no stale closure.
    var hasDataRef = (0, react_1.useRef)(false);
    if (profile !== null)
        hasDataRef.current = true;
    var reload = (0, react_1.useCallback)(function () { return setTick(function (t) { return t + 1; }); }, []);
    (0, react_1.useEffect)(function () {
        var _a, _b;
        var alive = true;
        // Only show the full-screen spinner on initial load — subsequent reloads
        // refresh silently so PassportContent stays mounted and avoids an infinite
        // focus-effect → reload → unmount → mount → focus-effect loop.
        if (!hasDataRef.current)
            setLoading(true);
        setError(null);
        if (!supabase_1.isSupabaseConfigured) {
            // No backend: return mock data so UI still works.
            var mock_1 = passport_1.mockPassport;
            var mockProfile_1 = {
                id: mock_1.user.id,
                handle: mock_1.user.handle,
                name: mock_1.user.name,
                displayName: mock_1.user.name,
                username: mock_1.user.handle,
                bio: (_a = mock_1.user.bio) !== null && _a !== void 0 ? _a : null,
                avatarUrl: mock_1.user.avatarUrl,
                homeCity: mock_1.user.homeCity,
                homeCountry: mock_1.user.homeCountry,
                currentCity: (_b = mock_1.user.currentCity) !== null && _b !== void 0 ? _b : null,
                travelStyle: mock_1.user.travelStyle,
                interests: mock_1.user.interests,
                verified: mock_1.user.verified,
                verificationStatus: mock_1.user.verified ? 'verified' : 'unverified',
                verifiedAt: null,
                openToMeet: mock_1.user.openToMeet,
                isPrivate: mock_1.user.isPrivate,
                passportVisibility: 'public',
                coverPhotoUrl: null,
                usernameUpdatedAt: null,
                createdAt: '2026-01-01T00:00:00Z',
                spokenLanguages: [],
                defaultLanguage: null,
                travelStyles: [],
                travelPace: null,
                budgetStyle: null,
                travelGroupStyle: [],
                lookingFor: [],
                comfortLevel: null,
                availabilityTags: [],
                planningStyle: null,
                publicSocialLinks: {},
                preferredLanguage: null,
            };
            setTimeout(function () {
                var _a;
                if (alive) {
                    setProfile(mockProfile_1);
                    setPostcards([]);
                    setStamps((_a = mock_1.stamps) !== null && _a !== void 0 ? _a : []);
                    setLoading(false);
                }
            }, 0);
            return function () { alive = false; };
        }
        Promise.all([(0, profile_1.getMyProfile)(), (0, profile_1.getMyPassportPostcards)(), (0, profile_1.getMyStamps)()]).then(function (_a) {
            var _b, _c, _d;
            var pRes = _a[0], pcRes = _a[1], stRes = _a[2];
            if (!alive)
                return;
            if (pRes.ok && pRes.data)
                setProfile(pRes.data);
            else
                setError((_b = pRes.message) !== null && _b !== void 0 ? _b : 'Could not load profile');
            setPostcards(pcRes.ok ? ((_c = pcRes.data) !== null && _c !== void 0 ? _c : []) : []);
            setStamps(stRes.ok ? ((_d = stRes.data) !== null && _d !== void 0 ? _d : []) : []);
            setLoading(false);
        }).catch(function () {
            if (!alive)
                return;
            setError('Failed to load passport');
            setLoading(false);
        });
        return function () { alive = false; };
    }, [tick]);
    return { profile: profile, postcards: postcards, stamps: stamps, loading: loading, error: error, reload: reload };
}
