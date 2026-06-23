"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
var react_1 = require("react");
var mockup_components_1 = require("./.generated/mockup-components");
function _resolveComponent(mod, name) {
    var fns = Object.values(mod).filter(function (v) { return typeof v === "function"; });
    return (mod.default ||
        mod.Preview ||
        mod[name] ||
        fns[fns.length - 1]);
}
function PreviewRenderer(_a) {
    var componentPath = _a.componentPath, modules = _a.modules;
    var _b = (0, react_1.useState)(null), Component = _b[0], setComponent = _b[1];
    var _c = (0, react_1.useState)(null), error = _c[0], setError = _c[1];
    (0, react_1.useEffect)(function () {
        var cancelled = false;
        setComponent(null);
        setError(null);
        function loadComponent() {
            return __awaiter(this, void 0, void 0, function () {
                var key, loader, mod, name_1, comp_1, e_1, message;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            key = "./components/mockups/".concat(componentPath, ".tsx");
                            loader = modules[key];
                            if (!loader) {
                                setError("No component found at ".concat(componentPath, ".tsx"));
                                return [2 /*return*/];
                            }
                            _a.label = 1;
                        case 1:
                            _a.trys.push([1, 3, , 4]);
                            return [4 /*yield*/, loader()];
                        case 2:
                            mod = _a.sent();
                            if (cancelled) {
                                return [2 /*return*/];
                            }
                            name_1 = componentPath.split("/").pop();
                            comp_1 = _resolveComponent(mod, name_1);
                            if (!comp_1) {
                                setError("No exported React component found in ".concat(componentPath, ".tsx\n\nMake sure the file has at least one exported function component."));
                                return [2 /*return*/];
                            }
                            setComponent(function () { return comp_1; });
                            return [3 /*break*/, 4];
                        case 3:
                            e_1 = _a.sent();
                            if (cancelled) {
                                return [2 /*return*/];
                            }
                            message = e_1 instanceof Error ? e_1.message : String(e_1);
                            setError("Failed to load preview.\n".concat(message));
                            return [3 /*break*/, 4];
                        case 4: return [2 /*return*/];
                    }
                });
            });
        }
        void loadComponent();
        return function () {
            cancelled = true;
        };
    }, [componentPath, modules]);
    if (error) {
        return (<pre style={{ color: "red", padding: "2rem", fontFamily: "system-ui" }}>
        {error}
      </pre>);
    }
    if (!Component)
        return null;
    return <Component />;
}
function getBasePath() {
    return import.meta.env.BASE_URL.replace(/\/$/, "");
}
function getPreviewExamplePath() {
    var basePath = getBasePath();
    return "".concat(basePath, "/preview/ComponentName");
}
function Gallery() {
    return (<div className="min-h-screen bg-gray-50 flex items-center justify-center p-8">
      <div className="text-center max-w-md">
        <h1 className="text-2xl font-semibold text-gray-900 mb-3">
          Component Preview Server
        </h1>
        <p className="text-gray-500 mb-4">
          This server renders individual components for the workspace canvas.
        </p>
        <p className="text-sm text-gray-400">
          Access component previews at{" "}
          <code className="bg-gray-100 px-1.5 py-0.5 rounded text-gray-600">
            {getPreviewExamplePath()}
          </code>
        </p>
      </div>
    </div>);
}
function getPreviewPath() {
    var basePath = getBasePath();
    var pathname = window.location.pathname;
    var local = basePath && pathname.startsWith(basePath)
        ? pathname.slice(basePath.length) || "/"
        : pathname;
    var match = local.match(/^\/preview\/(.+)$/);
    return match ? match[1] : null;
}
function App() {
    var previewPath = getPreviewPath();
    if (previewPath) {
        return (<PreviewRenderer componentPath={previewPath} modules={mockup_components_1.modules}/>);
    }
    return <Gallery />;
}
exports.default = App;
