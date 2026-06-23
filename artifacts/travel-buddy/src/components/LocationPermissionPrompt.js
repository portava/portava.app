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
exports.LocationPermissionPrompt = LocationPermissionPrompt;
/**
 * LocationPermissionPrompt — bottom-sheet shown when location is needed
 * but not yet granted. Non-blocking: the user can dismiss or choose a city.
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../theme/tokens");
var LocationContext_1 = require("../context/LocationContext");
function LocationPermissionPrompt() {
    var _a = (0, LocationContext_1.useLocationContext)(), showPermissionPrompt = _a.showPermissionPrompt, locationState = _a.locationState, requestLocation = _a.requestLocation, dismissPermissionPrompt = _a.dismissPermissionPrompt, openCityPicker = _a.openCityPicker, isLoading = _a.isLoading;
    if (!showPermissionPrompt)
        return null;
    var isDenied = locationState.permissionStatus === 'denied';
    return (<react_native_1.Modal visible={showPermissionPrompt} transparent animationType="slide" onRequestClose={dismissPermissionPrompt}>
      <react_native_1.Pressable style={s.overlay} onPress={dismissPermissionPrompt}>
        <react_native_1.Pressable style={s.sheet} onPress={function (e) { return e.stopPropagation(); }}>
          {/* Close */}
          <react_native_1.Pressable style={s.closeBtn} onPress={dismissPermissionPrompt} hitSlop={12}>
            <lucide_react_native_1.X size={18} color={tokens_1.color.mute}/>
          </react_native_1.Pressable>

          {/* Icon */}
          <react_native_1.View style={s.iconWrap}>
            <lucide_react_native_1.MapPin size={28} color={tokens_1.color.signal}/>
          </react_native_1.View>

          {/* Heading */}
          <react_native_1.Text style={s.heading}>
            {isDenied ? 'Location is off' : 'Turn on location'}
          </react_native_1.Text>
          <react_native_1.Text style={s.body}>
            {isDenied
            ? 'You can still use Travel Buddy by choosing a city manually.'
            : 'Unlock nearby travelers, stamps, postcards, and local discovery.'}
          </react_native_1.Text>

          {/* Buttons */}
          <react_native_1.View style={s.actions}>
            {!isDenied && (<react_native_1.Pressable style={[s.btn, s.btnPrimary, isLoading && s.btnDisabled]} onPress={requestLocation} disabled={isLoading}>
                <lucide_react_native_1.Navigation size={16} color="#fff"/>
                <react_native_1.Text style={s.btnPrimaryText}>
                  {isLoading ? 'Detecting…' : 'Enable Location'}
                </react_native_1.Text>
              </react_native_1.Pressable>)}

            <react_native_1.Pressable style={[s.btn, s.btnOutline]} onPress={openCityPicker}>
              <lucide_react_native_1.MapPin size={16} color={tokens_1.color.ink}/>
              <react_native_1.Text style={s.btnOutlineText}>Choose City Manually</react_native_1.Text>
            </react_native_1.Pressable>

            <react_native_1.Pressable style={s.notNow} onPress={dismissPermissionPrompt}>
              <react_native_1.Text style={s.notNowText}>Not Now</react_native_1.Text>
            </react_native_1.Pressable>
          </react_native_1.View>
        </react_native_1.Pressable>
      </react_native_1.Pressable>
    </react_native_1.Modal>);
}
// ── Styles ────────────────────────────────────────────────────────────────────
var s = react_native_1.StyleSheet.create({
    overlay: {
        flex: 1,
        backgroundColor: 'rgba(17,17,15,0.5)',
        justifyContent: 'flex-end',
    },
    sheet: {
        backgroundColor: tokens_1.color.paper,
        borderTopLeftRadius: tokens_1.radius.lg,
        borderTopRightRadius: tokens_1.radius.lg,
        padding: tokens_1.space.xl,
        paddingBottom: tokens_1.space.xl + 16,
        alignItems: 'center',
        gap: tokens_1.space.sm,
    },
    closeBtn: {
        position: 'absolute',
        top: tokens_1.space.md,
        right: tokens_1.space.md,
        padding: tokens_1.space.sm,
    },
    iconWrap: {
        width: 56,
        height: 56,
        borderRadius: 28,
        backgroundColor: '#FFF0EC',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: tokens_1.space.xs,
    },
    heading: __assign(__assign({}, tokens_1.type.title), { color: tokens_1.color.ink, textAlign: 'center' }),
    body: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute, textAlign: 'center', marginBottom: tokens_1.space.sm }),
    actions: {
        width: '100%',
        gap: tokens_1.space.sm,
        marginTop: tokens_1.space.xs,
    },
    btn: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: tokens_1.space.sm,
        height: 48,
        borderRadius: tokens_1.radius.md,
    },
    btnPrimary: {
        backgroundColor: tokens_1.color.signal,
    },
    btnPrimaryText: __assign(__assign({}, tokens_1.type.body), { color: '#fff', fontWeight: '600' }),
    btnOutline: {
        borderWidth: 1.5,
        borderColor: tokens_1.color.haze,
    },
    btnOutlineText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, fontWeight: '500' }),
    btnDisabled: {
        opacity: 0.6,
    },
    notNow: {
        alignItems: 'center',
        paddingVertical: tokens_1.space.sm,
    },
    notNowText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.faint }),
});
