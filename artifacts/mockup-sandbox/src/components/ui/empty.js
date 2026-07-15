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
exports.Empty = Empty;
exports.EmptyHeader = EmptyHeader;
exports.EmptyTitle = EmptyTitle;
exports.EmptyDescription = EmptyDescription;
exports.EmptyContent = EmptyContent;
exports.EmptyMedia = EmptyMedia;
var class_variance_authority_1 = require("class-variance-authority");
var utils_1 = require("@/lib/utils");
function Empty(_a) {
    var className = _a.className, props = __rest(_a, ["className"]);
    return (<div data-slot="empty" className={(0, utils_1.cn)("flex min-w-0 flex-1 flex-col items-center justify-center gap-6 text-balance rounded-lg border-dashed p-6 text-center md:p-12", className)} {...props}/>);
}
function EmptyHeader(_a) {
    var className = _a.className, props = __rest(_a, ["className"]);
    return (<div data-slot="empty-header" className={(0, utils_1.cn)("flex max-w-sm flex-col items-center gap-2 text-center", className)} {...props}/>);
}
var emptyMediaVariants = (0, class_variance_authority_1.cva)("mb-2 flex shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg]:shrink-0", {
    variants: {
        variant: {
            default: "bg-transparent",
            icon: "bg-muted text-foreground flex size-10 shrink-0 items-center justify-center rounded-lg [&_svg:not([class*='size-'])]:size-6",
        },
    },
    defaultVariants: {
        variant: "default",
    },
});
function EmptyMedia(_a) {
    var className = _a.className, _b = _a.variant, variant = _b === void 0 ? "default" : _b, props = __rest(_a, ["className", "variant"]);
    return (<div data-slot="empty-icon" data-variant={variant} className={(0, utils_1.cn)(emptyMediaVariants({ variant: variant, className: className }))} {...props}/>);
}
function EmptyTitle(_a) {
    var className = _a.className, props = __rest(_a, ["className"]);
    return (<div data-slot="empty-title" className={(0, utils_1.cn)("text-lg font-medium tracking-tight", className)} {...props}/>);
}
function EmptyDescription(_a) {
    var className = _a.className, props = __rest(_a, ["className"]);
    return (<div data-slot="empty-description" className={(0, utils_1.cn)("text-muted-foreground [&>a:hover]:text-primary text-sm/relaxed [&>a]:underline [&>a]:underline-offset-4", className)} {...props}/>);
}
function EmptyContent(_a) {
    var className = _a.className, props = __rest(_a, ["className"]);
    return (<div data-slot="empty-content" className={(0, utils_1.cn)("flex w-full min-w-0 max-w-sm flex-col items-center gap-4 text-balance text-sm", className)} {...props}/>);
}
