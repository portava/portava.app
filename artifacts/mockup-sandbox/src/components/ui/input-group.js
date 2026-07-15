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
exports.InputGroup = InputGroup;
exports.InputGroupAddon = InputGroupAddon;
exports.InputGroupButton = InputGroupButton;
exports.InputGroupText = InputGroupText;
exports.InputGroupInput = InputGroupInput;
exports.InputGroupTextarea = InputGroupTextarea;
var React = require("react");
var class_variance_authority_1 = require("class-variance-authority");
var utils_1 = require("@/lib/utils");
var button_1 = require("@/components/ui/button");
var input_1 = require("@/components/ui/input");
var textarea_1 = require("@/components/ui/textarea");
function InputGroup(_a) {
    var className = _a.className, props = __rest(_a, ["className"]);
    return (<div data-slot="input-group" role="group" className={(0, utils_1.cn)("group/input-group border-input dark:bg-input/30 shadow-xs relative flex w-full items-center rounded-md border outline-none transition-[color,box-shadow]", "h-9 has-[>textarea]:h-auto", "has-[>[data-align=inline-start]]:[&>input]:pl-2", "has-[>[data-align=inline-end]]:[&>input]:pr-2", "has-[>[data-align=block-start]]:h-auto has-[>[data-align=block-start]]:flex-col has-[>[data-align=block-start]]:[&>input]:pb-3", "has-[>[data-align=block-end]]:h-auto has-[>[data-align=block-end]]:flex-col has-[>[data-align=block-end]]:[&>input]:pt-3", "has-[[data-slot=input-group-control]:focus-visible]:ring-ring has-[[data-slot=input-group-control]:focus-visible]:ring-1", "has-[[data-slot][aria-invalid=true]]:ring-destructive/20 has-[[data-slot][aria-invalid=true]]:border-destructive dark:has-[[data-slot][aria-invalid=true]]:ring-destructive/40", className)} {...props}/>);
}
var inputGroupAddonVariants = (0, class_variance_authority_1.cva)("text-muted-foreground flex h-auto cursor-text select-none items-center justify-center gap-2 py-1.5 text-sm font-medium group-data-[disabled=true]/input-group:opacity-50 [&>kbd]:rounded-[calc(var(--radius)-5px)] [&>svg:not([class*='size-'])]:size-4", {
    variants: {
        align: {
            "inline-start": "order-first pl-3 has-[>button]:ml-[-0.45rem] has-[>kbd]:ml-[-0.35rem]",
            "inline-end": "order-last pr-3 has-[>button]:mr-[-0.4rem] has-[>kbd]:mr-[-0.35rem]",
            "block-start": "[.border-b]:pb-3 order-first w-full justify-start px-3 pt-3 group-has-[>input]/input-group:pt-2.5",
            "block-end": "[.border-t]:pt-3 order-last w-full justify-start px-3 pb-3 group-has-[>input]/input-group:pb-2.5",
        },
    },
    defaultVariants: {
        align: "inline-start",
    },
});
function InputGroupAddon(_a) {
    var className = _a.className, _b = _a.align, align = _b === void 0 ? "inline-start" : _b, props = __rest(_a, ["className", "align"]);
    return (<div role="group" data-slot="input-group-addon" data-align={align} className={(0, utils_1.cn)(inputGroupAddonVariants({ align: align }), className)} onClick={function (e) {
            var _a, _b;
            if (e.target.closest("button")) {
                return;
            }
            (_b = (_a = e.currentTarget.parentElement) === null || _a === void 0 ? void 0 : _a.querySelector("input")) === null || _b === void 0 ? void 0 : _b.focus();
        }} {...props}/>);
}
var inputGroupButtonVariants = (0, class_variance_authority_1.cva)("flex items-center gap-2 text-sm shadow-none", {
    variants: {
        size: {
            xs: "h-6 gap-1 rounded-[calc(var(--radius)-5px)] px-2 has-[>svg]:px-2 [&>svg:not([class*='size-'])]:size-3.5",
            sm: "h-8 gap-1.5 rounded-md px-2.5 has-[>svg]:px-2.5",
            "icon-xs": "size-6 rounded-[calc(var(--radius)-5px)] p-0 has-[>svg]:p-0",
            "icon-sm": "size-8 p-0 has-[>svg]:p-0",
        },
    },
    defaultVariants: {
        size: "xs",
    },
});
function InputGroupButton(_a) {
    var className = _a.className, _b = _a.type, type = _b === void 0 ? "button" : _b, _c = _a.variant, variant = _c === void 0 ? "ghost" : _c, _d = _a.size, size = _d === void 0 ? "xs" : _d, props = __rest(_a, ["className", "type", "variant", "size"]);
    return (<button_1.Button type={type} data-size={size} variant={variant} className={(0, utils_1.cn)(inputGroupButtonVariants({ size: size }), className)} {...props}/>);
}
function InputGroupText(_a) {
    var className = _a.className, props = __rest(_a, ["className"]);
    return (<span className={(0, utils_1.cn)("text-muted-foreground flex items-center gap-2 text-sm [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none", className)} {...props}/>);
}
function InputGroupInput(_a) {
    var className = _a.className, props = __rest(_a, ["className"]);
    return (<input_1.Input data-slot="input-group-control" className={(0, utils_1.cn)("flex-1 rounded-none border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent", className)} {...props}/>);
}
function InputGroupTextarea(_a) {
    var className = _a.className, props = __rest(_a, ["className"]);
    return (<textarea_1.Textarea data-slot="input-group-control" className={(0, utils_1.cn)("flex-1 resize-none rounded-none border-0 bg-transparent py-3 shadow-none focus-visible:ring-0 dark:bg-transparent", className)} {...props}/>);
}
