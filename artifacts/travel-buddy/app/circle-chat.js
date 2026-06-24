"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = CircleChatScreen;
var react_1 = require("react");
var expo_router_1 = require("expo-router");
var GroupChatScreen_1 = require("../src/components/GroupChatScreen");
function CircleChatScreen() {
    var ownerId = (0, expo_router_1.useLocalSearchParams)().ownerId;
    return (<GroupChatScreen_1.GroupChatScreen type="circle" id={ownerId !== null && ownerId !== void 0 ? ownerId : ''} title="Trusted Circle" memberLabel="Circle members only"/>);
}
