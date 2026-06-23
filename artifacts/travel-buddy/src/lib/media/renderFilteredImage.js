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
exports.FILTER_OUTPUT_QUALITY = exports.FILTER_MAX_SIDE = void 0;
exports.renderFilteredImage = renderFilteredImage;
/**
 * renderFilteredImage — resize a photo and return metadata for filter display.
 *
 * Uses expo-image-manipulator to decode + resize to ≤1080px on the longest
 * side before upload. The CSS filter is applied as a live style overlay in the
 * editor and stored as filter_id/filter_intensity metadata on the post row —
 * the display layer re-applies it for native renders where canvas baking is
 * not available.
 *
 * On web, you can additionally bake via canvas (see the web-specific path at
 * the bottom), but expo-image-manipulator is the cross-platform path.
 */
var ImageManipulator = require("expo-image-manipulator");
var expo_image_manipulator_1 = require("expo-image-manipulator");
exports.FILTER_MAX_SIDE = 1080;
exports.FILTER_OUTPUT_QUALITY = 0.88;
/**
 * Resize a photo to at most `maxSide` on the longest dimension and return the
 * result with filter metadata attached. The URI returned is the resized JPEG
 * ready for upload; the caller is responsible for recording filterId and
 * filterIntensity on the post/highlight row so the display layer can re-apply
 * the CSS filter.
 *
 * Falls back to the original URI if ImageManipulator fails so posting can
 * still succeed.
 */
function renderFilteredImage(opts) {
    return __awaiter(this, void 0, void 0, function () {
        var uri, filterId, intensity, _a, maxSide, _b, outputQuality, actions, result, _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    uri = opts.uri, filterId = opts.filterId, intensity = opts.intensity, _a = opts.maxSide, maxSide = _a === void 0 ? exports.FILTER_MAX_SIDE : _a, _b = opts.outputQuality, outputQuality = _b === void 0 ? exports.FILTER_OUTPUT_QUALITY : _b;
                    _d.label = 1;
                case 1:
                    _d.trys.push([1, 3, , 4]);
                    actions = [{ resize: { width: maxSide } }];
                    return [4 /*yield*/, ImageManipulator.manipulateAsync(uri, actions, { compress: outputQuality, format: expo_image_manipulator_1.SaveFormat.JPEG })];
                case 2:
                    result = _d.sent();
                    return [2 /*return*/, {
                            uri: result.uri,
                            width: result.width,
                            height: result.height,
                            filterId: filterId,
                            filterIntensity: intensity,
                            mimeType: 'image/jpeg',
                        }];
                case 3:
                    _c = _d.sent();
                    return [2 /*return*/, {
                            uri: uri,
                            width: 0,
                            height: 0,
                            filterId: filterId,
                            filterIntensity: intensity,
                            mimeType: 'image/jpeg',
                        }];
                case 4: return [2 /*return*/];
            }
        });
    });
}
