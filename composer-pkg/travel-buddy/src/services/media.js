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
exports.MAX_VIDEO_BYTES = exports.MAX_IMAGE_BYTES = exports.ALLOWED_VIDEO_TYPES = exports.ALLOWED_IMAGE_TYPES = void 0;
exports.validateMedia = validateMedia;
exports.uploadMedia = uploadMedia;
exports.deleteUploadedMedia = deleteUploadedMedia;
/**
 * Media upload service. Uploads a picked image/video to the `post-media`
 * Supabase Storage bucket under the user's own folder, then returns the public
 * URL. The composer calls this BEFORE POST /api/posts; if upload fails, the post
 * is not created (and no fake URL is ever used).
 *
 * Path: post-media/{userId}/{uuid}.{ext}  (RLS lets a user write only their own
 * folder.)
 */
var supabase_1 = require("../lib/supabase");
exports.ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
exports.ALLOWED_VIDEO_TYPES = ['video/mp4'];
exports.MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB
exports.MAX_VIDEO_BYTES = 50 * 1024 * 1024; // 50MB
function extFromMime(mime) {
    switch (mime) {
        case 'image/jpeg': return 'jpg';
        case 'image/png': return 'png';
        case 'image/webp': return 'webp';
        case 'video/mp4': return 'mp4';
        default: return 'bin';
    }
}
function uuid() {
    var _a;
    // RFC4122-ish; crypto.randomUUID where available, else fallback.
    var g = globalThis;
    if ((_a = g.crypto) === null || _a === void 0 ? void 0 : _a.randomUUID)
        return g.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = (Math.random() * 16) | 0;
        var v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}
function validateMedia(media) {
    var _a;
    var mime = (_a = media.mimeType) !== null && _a !== void 0 ? _a : (media.type === 'video' ? 'video/mp4' : 'image/jpeg');
    var isImage = exports.ALLOWED_IMAGE_TYPES.includes(mime);
    var isVideo = exports.ALLOWED_VIDEO_TYPES.includes(mime);
    if (!isImage && !isVideo) {
        return { ok: false, kind: 'invalid_type', message: "Unsupported media type: ".concat(mime) };
    }
    if (media.fileSize != null) {
        var max = isVideo ? exports.MAX_VIDEO_BYTES : exports.MAX_IMAGE_BYTES;
        if (media.fileSize > max) {
            return { ok: false, kind: 'too_large', message: "File too large (".concat(Math.round(media.fileSize / 1024 / 1024), "MB; max ").concat(Math.round(max / 1024 / 1024), "MB)") };
        }
    }
    return { ok: true };
}
/**
 * Upload one picked media asset. Returns the public URL on success.
 * Steps: validate -> resolve current user -> fetch(uri)->blob -> storage.upload
 * -> getPublicUrl. Rich error detail on failure (no generic "could not upload").
 */
function uploadMedia(media) {
    return __awaiter(this, void 0, void 0, function () {
        var v, sessionData, userId, mime, path, blob, resp, e_1, upErr, pub, url;
        var _a, _b, _c, _d, _e, _f, _g, _h, _j;
        return __generator(this, function (_k) {
            switch (_k.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured) {
                        return [2 /*return*/, { ok: false, url: null, mediaType: null, errorKind: 'config_error', message: 'Backend not configured' }];
                    }
                    v = validateMedia(media);
                    if (!v.ok) {
                        return [2 /*return*/, { ok: false, url: null, mediaType: null, errorKind: v.kind, message: v.message }];
                    }
                    return [4 /*yield*/, supabase_1.supabase.auth.getSession()];
                case 1:
                    sessionData = (_k.sent()).data;
                    userId = (_c = (_b = (_a = sessionData.session) === null || _a === void 0 ? void 0 : _a.user) === null || _b === void 0 ? void 0 : _b.id) !== null && _c !== void 0 ? _c : null;
                    if (!userId) {
                        return [2 /*return*/, { ok: false, url: null, mediaType: null, errorKind: 'unauthenticated', message: 'Please sign in to upload media' }];
                    }
                    mime = (_d = media.mimeType) !== null && _d !== void 0 ? _d : (media.type === 'video' ? 'video/mp4' : 'image/jpeg');
                    path = "".concat(userId, "/").concat(uuid(), ".").concat(extFromMime(mime));
                    _k.label = 2;
                case 2:
                    _k.trys.push([2, 5, , 6]);
                    return [4 /*yield*/, fetch(media.uri)];
                case 3:
                    resp = _k.sent();
                    return [4 /*yield*/, resp.blob()];
                case 4:
                    blob = _k.sent();
                    return [3 /*break*/, 6];
                case 5:
                    e_1 = _k.sent();
                    return [2 /*return*/, {
                            ok: false, url: null, mediaType: null, errorKind: 'read_failed',
                            message: e_1 instanceof Error ? e_1.message : 'Failed to read media file',
                            detail: { uri: media.uri, mime: mime },
                        }];
                case 6: return [4 /*yield*/, supabase_1.supabase.storage
                        .from('post-media')
                        .upload(path, blob, { contentType: mime, upsert: false })];
                case 7:
                    upErr = (_k.sent()).error;
                    if (upErr) {
                        return [2 /*return*/, {
                                ok: false, url: null, mediaType: null, errorKind: 'upload_failed',
                                message: upErr.message,
                                detail: {
                                    bucket: 'post-media',
                                    path: path,
                                    mimeType: mime,
                                    fileSize: (_f = (_e = media.fileSize) !== null && _e !== void 0 ? _e : blob.size) !== null && _f !== void 0 ? _f : null,
                                    statusCode: (_h = (_g = upErr.statusCode) !== null && _g !== void 0 ? _g : upErr.status) !== null && _h !== void 0 ? _h : null,
                                    userPresent: Boolean(userId),
                                },
                            }];
                    }
                    pub = supabase_1.supabase.storage.from('post-media').getPublicUrl(path).data;
                    url = (_j = pub === null || pub === void 0 ? void 0 : pub.publicUrl) !== null && _j !== void 0 ? _j : null;
                    if (!url) {
                        return [2 /*return*/, { ok: false, url: null, mediaType: null, errorKind: 'upload_failed', message: 'Uploaded but could not resolve public URL', detail: { path: path } }];
                    }
                    return [2 /*return*/, { ok: true, url: url, mediaType: mime }];
            }
        });
    });
}
/** Best-effort cleanup: remove an uploaded object if post creation later fails. */
function deleteUploadedMedia(publicUrl) {
    return __awaiter(this, void 0, void 0, function () {
        var marker, idx, path, _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    _b.trys.push([0, 2, , 3]);
                    marker = '/post-media/';
                    idx = publicUrl.indexOf(marker);
                    if (idx === -1)
                        return [2 /*return*/];
                    path = publicUrl.slice(idx + marker.length);
                    return [4 /*yield*/, supabase_1.supabase.storage.from('post-media').remove([path])];
                case 1:
                    _b.sent();
                    return [3 /*break*/, 3];
                case 2:
                    _a = _b.sent();
                    return [3 /*break*/, 3];
                case 3: return [2 /*return*/];
            }
        });
    });
}
