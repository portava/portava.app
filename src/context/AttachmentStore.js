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
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AttachmentProvider = AttachmentProvider;
exports.useAttachments = useAttachments;
var react_1 = require("react");
/**
 * In-memory session attachment store. Implements AttachmentService.
 * Persistence: 'session' — survives navigation, resets on full reload.
 * NOT backend-persisted. Swap this provider for an API-backed one later
 * (same interface, callers unchanged).
 */
var ME = 'me';
var AttachmentContext = (0, react_1.createContext)(null);
function AttachmentProvider(_a) {
    var _this = this;
    var children = _a.children;
    var _b = (0, react_1.useState)([]), attachments = _b[0], setAttachments = _b[1];
    var isAttached = (0, react_1.useCallback)(function (sourceItemId, targetId) {
        return attachments.some(function (a) { return a.sourceItemId === sourceItemId && a.targetId === targetId; });
    }, [attachments]);
    var listAttachmentsByTarget = (0, react_1.useCallback)(function (targetId) { return attachments.filter(function (a) { return a.targetId === targetId; }); }, [attachments]);
    var listAttachmentsBySource = (0, react_1.useCallback)(function (sourceItemId) { return attachments.filter(function (a) { return a.sourceItemId === sourceItemId; }); }, [attachments]);
    var createAttachment = (0, react_1.useCallback)(function (source, target, notes) { return __awaiter(_this, void 0, void 0, function () {
        var existing, att;
        return __generator(this, function (_a) {
            existing = attachments.find(function (a) { return a.sourceItemId === source.id && a.targetId === target.id; });
            if (existing)
                return [2 /*return*/, existing];
            att = {
                id: "att_".concat(Date.now(), "_").concat(Math.random().toString(36).slice(2, 7)),
                userId: ME,
                sourceItemId: source.id,
                sourceItemType: source.type,
                sourceTitle: source.title,
                sourceSubtitle: source.subtitle,
                sourceImageUrl: source.imageUrl,
                sourceCity: source.city,
                sourceCategory: source.category,
                targetId: target.id,
                targetType: target.type,
                targetTitle: target.title,
                createdAt: new Date().toISOString(),
                notes: notes,
                persistence: 'session',
            };
            setAttachments(function (prev) { return __spreadArray([att], prev, true); });
            return [2 /*return*/, att];
        });
    }); }, [attachments]);
    var deleteAttachment = (0, react_1.useCallback)(function (attachmentId) { return __awaiter(_this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            setAttachments(function (prev) { return prev.filter(function (a) { return a.id !== attachmentId; }); });
            return [2 /*return*/];
        });
    }); }, []);
    var value = (0, react_1.useMemo)(function () { return ({ attachments: attachments, isAttached: isAttached, listAttachmentsByTarget: listAttachmentsByTarget, listAttachmentsBySource: listAttachmentsBySource, createAttachment: createAttachment, deleteAttachment: deleteAttachment }); }, [attachments, isAttached, listAttachmentsByTarget, listAttachmentsBySource, createAttachment, deleteAttachment]);
    return <AttachmentContext.Provider value={value}>{children}</AttachmentContext.Provider>;
}
function useAttachments() {
    var _this = this;
    var ctx = (0, react_1.useContext)(AttachmentContext);
    if (!ctx) {
        // Safe fallback if provider missing — no-op store so UI never crashes.
        return {
            attachments: [],
            isAttached: function () { return false; },
            listAttachmentsByTarget: function () { return []; },
            listAttachmentsBySource: function () { return []; },
            createAttachment: function () { return __awaiter(_this, void 0, void 0, function () { return __generator(this, function (_a) {
                throw new Error('AttachmentProvider missing');
            }); }); },
            deleteAttachment: function () { return __awaiter(_this, void 0, void 0, function () { return __generator(this, function (_a) {
                return [2 /*return*/];
            }); }); },
        };
    }
    return ctx;
}
