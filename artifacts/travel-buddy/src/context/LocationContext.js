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
exports.LocationProvider = LocationProvider;
exports.useLocationContext = useLocationContext;
/**
 * LocationContext — app-wide GPS/location state.
 *
 * Wrap the root layout with <LocationProvider>. Any screen or component
 * can then call useLocationContext() to get the current city, request GPS,
 * or set a manual city.
 *
 * showPermissionPrompt is set to true when a location-required feature is
 * first loaded and no location has been captured yet.
 */
var react_1 = require("react");
var useActiveLocation_1 = require("../hooks/useActiveLocation");
var useLocationPreferences_1 = require("../hooks/useLocationPreferences");
var SessionContext_1 = require("./SessionContext");
var LocationContext = (0, react_1.createContext)(null);
// ── Provider ──────────────────────────────────────────────────────────────────
var DISMISSED_KEY = 'location_prompt_dismissed';
function LocationProvider(_a) {
    var children = _a.children;
    var isAuthed = (0, SessionContext_1.useSession)().isAuthed;
    var locationHook = (0, useActiveLocation_1.useActiveLocation)();
    var locationState = locationHook.locationState, requestLocation = locationHook.requestLocation, setManualCity = locationHook.setManualCity;
    var _b = (0, useLocationPreferences_1.useLocationPreferences)(), locationPrefs = _b.prefs, locationPrefsLoading = _b.isLoading, refreshLocationPrefs = _b.refresh;
    var _c = (0, react_1.useState)(false), showPermissionPrompt = _c[0], setShowPermissionPrompt = _c[1];
    var _d = (0, react_1.useState)(false), showCityPicker = _d[0], setShowCityPicker = _d[1];
    // Track whether the user has dismissed the prompt this session
    var _e = (0, react_1.useState)(false), dismissed = _e[0], setDismissed = _e[1];
    // Auto-show prompt once the user is authed, location is unknown, and they
    // haven't dismissed before. Only prompt once per session.
    (0, react_1.useEffect)(function () {
        if (!isAuthed)
            return;
        if (dismissed)
            return;
        if (locationState.permissionStatus === 'unknown')
            return; // still loading
        if (locationState.ok)
            return; // already have a location
        if (locationState.permissionStatus === 'denied')
            return; // can't prompt again
        if (locationState.permissionStatus === 'granted')
            return; // has permission, just no fix yet
        // Show after a short delay so the main screen settles first
        var timer = setTimeout(function () { return setShowPermissionPrompt(true); }, 2000);
        return function () { return clearTimeout(timer); };
    }, [isAuthed, locationState.permissionStatus, locationState.ok, dismissed]);
    var requireLocation = (0, react_1.useCallback)(function (_feature) {
        if (locationState.ok || dismissed)
            return;
        if (locationState.permissionStatus !== 'denied') {
            setShowPermissionPrompt(true);
        }
    }, [locationState.ok, locationState.permissionStatus, dismissed]);
    var dismissPermissionPrompt = (0, react_1.useCallback)(function () {
        setShowPermissionPrompt(false);
        setDismissed(true);
    }, []);
    var openCityPicker = (0, react_1.useCallback)(function () {
        setShowPermissionPrompt(false);
        setShowCityPicker(true);
    }, []);
    var closeCityPicker = (0, react_1.useCallback)(function () { return setShowCityPicker(false); }, []);
    return (<LocationContext.Provider value={__assign(__assign({}, locationHook), { showPermissionPrompt: showPermissionPrompt, showCityPicker: showCityPicker, requireLocation: requireLocation, dismissPermissionPrompt: dismissPermissionPrompt, openCityPicker: openCityPicker, closeCityPicker: closeCityPicker, locationPrefs: locationPrefs, locationPrefsLoading: locationPrefsLoading, refreshLocationPrefs: refreshLocationPrefs })}>
      {children}
    </LocationContext.Provider>);
}
// ── Consumer hook ─────────────────────────────────────────────────────────────
function useLocationContext() {
    var ctx = (0, react_1.useContext)(LocationContext);
    if (!ctx)
        throw new Error('useLocationContext must be used inside <LocationProvider>');
    return ctx;
}
