"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = Saved;
var react_1 = require("react");
var react_native_1 = require("react-native");
var ScreenHeader_1 = require("../src/components/ScreenHeader");
var ui_1 = require("../src/components/ui");
var PostCard_1 = require("../src/components/PostCard");
var cebu_1 = require("../src/data/cebu");
var tokens_1 = require("../src/theme/tokens");
var TABS = ['Posts', 'Places', 'Hotels', 'Nightlife', 'Itineraries', 'Questions', 'AI answers'];
function Saved() {
    var _a = (0, react_1.useState)('Posts'), tab = _a[0], setTab = _a[1];
    var saved = cebu_1.posts.filter(function (p) { return p.saved; });
    return (<react_native_1.View style={{ flex: 1, backgroundColor: tokens_1.color.paper }}>
      <ScreenHeader_1.ScreenHeader title="Saved" back/>
      <react_native_1.FlatList data={TABS} horizontal showsHorizontalScrollIndicator={false} keyExtractor={function (x) { return x; }} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: tokens_1.space.sm, padding: tokens_1.space.lg }} renderItem={function (_a) {
        var item = _a.item;
        return <ui_1.Chip label={item} active={item === tab} onPress={function () { return setTab(item); }}/>;
    }}/>
      <react_native_1.ScrollView contentContainerStyle={{ padding: tokens_1.space.lg, paddingTop: 0, gap: tokens_1.space.lg }}>
        {saved.map(function (p) { return <PostCard_1.PostCard key={p.id} post={p}/>; })}
      </react_native_1.ScrollView>
    </react_native_1.View>);
}
