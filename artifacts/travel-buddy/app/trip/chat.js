"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = TripChatScreen;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var GroupChatScreen_1 = require("../../src/components/GroupChatScreen");
var DailyBriefCard_1 = require("../../src/components/DailyBriefCard");
function TripChatScreen() {
    var id = (0, expo_router_1.useLocalSearchParams)().id;
    var tripId = id !== null && id !== void 0 ? id : '';
    return (<react_native_1.View style={s.root}>
      <DailyBriefCard_1.DailyBriefCard tripId={tripId} compact/>
      <react_native_1.View style={s.chat}>
        <GroupChatScreen_1.GroupChatScreen type="trip" id={tripId} title="Trip Chat" memberLabel="Trip members only"/>
      </react_native_1.View>
    </react_native_1.View>);
}
var s = react_native_1.StyleSheet.create({
    root: { flex: 1 },
    chat: { flex: 1 },
});
