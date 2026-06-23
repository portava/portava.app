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
exports.default = PostDetail;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var ScreenHeader_1 = require("../../src/components/ScreenHeader");
var PostCard_1 = require("../../src/components/PostCard");
var cebu_1 = require("../../src/data/cebu");
var tokens_1 = require("../../src/theme/tokens");
function PostDetail() {
    var id = (0, expo_router_1.useLocalSearchParams)().id;
    var post = (0, cebu_1.postById)(id);
    return (<react_native_1.View style={{ flex: 1, backgroundColor: tokens_1.color.paper }}>
      <ScreenHeader_1.ScreenHeader title="Post" back/>
      <react_native_1.ScrollView contentContainerStyle={{ padding: tokens_1.space.lg, gap: tokens_1.space.lg }}>
        {post ? <PostCard_1.PostCard post={post}/> : <react_native_1.Text style={__assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute })}>Post not found.</react_native_1.Text>}
        <react_native_1.Text style={__assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink })}>Comments</react_native_1.Text>
        <react_native_1.Text style={__assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute })}>Comments thread shell — wire to backend later.</react_native_1.Text>
      </react_native_1.ScrollView>
    </react_native_1.View>);
}
