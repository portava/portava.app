"use strict";
var __rest = (this && this.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Spinner = Spinner;
var lucide_react_1 = require("lucide-react");
var utils_1 = require("@/lib/utils");
function Spinner(_a) {
    var className = _a.className, props = __rest(_a, ["className"]);
    return (<lucide_react_1.Loader2Icon role="status" aria-label="Loading" className={(0, utils_1.cn)("size-4 animate-spin", className)} {...props}/>);
}
