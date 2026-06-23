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
 * Media upload service. Uploads a picked image/video through the API server's
 * POST /api/media/upload endpoint (service-role key, bypasses Storage RLS),
 * then returns the public URL. The composer calls this BEFORE POST /api/posts;
 * if upload fails, the post is not created (and no fake URL is ever used).
 *
 * NOTE: We deliberately do NOT write to Supabase Storage directly from the
 * client. The Supabase project uses an ECC P-256 JWT key; PostgREST / Storage
 * cannot fully resolve auth.uid() from it, so user-key uploads fail RLS.
 * The API server calls auth.getUser(token) (Auth endpoint, not PostgREST) to
 * verify identity, then uploads with the service-role key — same pattern as
 * trip / post creation.
 */
var supabase_1 = require("../lib/supabase");
exports.ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
exports.ALLOWED_VIDEO_TYPES = ['video/mp4'];
exports.MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB
exports.MAX_VIDEO_BYTES = 50 * 1024 * 1024; // 50MB
function apiBase() {
    var _a;
    return (_a = process.env.EXPO_PUBLIC_API_BASE_URL) !== null && _a !== void 0 ? _a : '';
}
function validateMedia(media, opts) {
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
    if (isVideo && (opts === null || opts === void 0 ? void 0 : opts.maxVideoDurationSeconds) != null) {
        var duration = media.duration;
        if (duration != null && duration > opts.maxVideoDurationSeconds) {
            return {
                ok: false,
                kind: 'too_large',
                message: "Highlights and video Postcards can be up to ".concat(opts.maxVideoDurationSeconds, " seconds."),
            };
        }
    }
    return { ok: true };
}
/**
 * Upload one picked media asset via POST /api/media/upload (API server,
 * service-role key — bypasses Storage RLS). Returns the public URL on success.
 * Steps: validate → get bearer token → fetch(uri)→blob → POST binary to API →
 * parse { url, path }. Rich error detail on failure.
 */
function uploadMedia(media) {
    return __awaiter(this, void 0, void 0, function () {
        var base, v, refreshed, session, _a, token, mime, blob, resp, e_1, apiRes, e_2, body_1, body, url;
        var _b, _c, _d, _e, _f, _g;
        return __generator(this, function (_h) {
            switch (_h.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured) {
                        return [2 /*return*/, { ok: false, url: null, mediaType: null, errorKind: 'config_error', message: 'Backend not configured' }];
                    }
                    base = apiBase();
                    if (!base) {
                        return [2 /*return*/, { ok: false, url: null, mediaType: null, errorKind: 'config_error', message: 'API base URL not configured' }];
                    }
                    v = validateMedia(media);
                    if (!v.ok) {
                        return [2 /*return*/, { ok: false, url: null, mediaType: null, errorKind: v.kind, message: v.message }];
                    }
                    return [4 /*yield*/, supabase_1.supabase.auth.refreshSession()];
                case 1:
                    refreshed = (_h.sent()).data;
                    if (!((_b = refreshed === null || refreshed === void 0 ? void 0 : refreshed.session) !== null && _b !== void 0)) return [3 /*break*/, 2];
                    _a = _b;
                    return [3 /*break*/, 4];
                case 2: return [4 /*yield*/, supabase_1.supabase.auth.getSession()];
                case 3:
                    _a = (_h.sent()).data.session;
                    _h.label = 4;
                case 4:
                    session = _a;
                    token = (_c = session === null || session === void 0 ? void 0 : session.access_token) !== null && _c !== void 0 ? _c : null;
                    if (!token) {
                        return [2 /*return*/, { ok: false, url: null, mediaType: null, errorKind: 'unauthenticated', message: 'Please sign in to upload media' }];
                    }
                    mime = (_d = media.mimeType) !== null && _d !== void 0 ? _d : (media.type === 'video' ? 'video/mp4' : 'image/jpeg');
                    _h.label = 5;
                case 5:
                    _h.trys.push([5, 8, , 9]);
                    return [4 /*yield*/, fetch(media.uri)];
                case 6:
                    resp = _h.sent();
                    return [4 /*yield*/, resp.blob()];
                case 7:
                    blob = _h.sent();
                    return [3 /*break*/, 9];
                case 8:
                    e_1 = _h.sent();
                    return [2 /*return*/, {
                            ok: false, url: null, mediaType: null, errorKind: 'read_failed',
                            message: e_1 instanceof Error ? e_1.message : 'Failed to read media file',
                            detail: { uri: media.uri, mime: mime },
                        }];
                case 9:
                    _h.trys.push([9, 11, , 12]);
                    return [4 /*yield*/, fetch("".concat(base, "/api/media/upload"), {
                            method: 'POST',
                            headers: { 'Content-Type': mime, Authorization: "Bearer ".concat(token) },
                            body: blob,
                        })];
                case 10:
                    apiRes = _h.sent();
                    return [3 /*break*/, 12];
                case 11:
                    e_2 = _h.sent();
                    return [2 /*return*/, {
                            ok: false, url: null, mediaType: null, errorKind: 'upload_failed',
                            message: e_2 instanceof Error ? e_2.message : 'Network error during upload',
                        }];
                case 12:
                    if (!!apiRes.ok) return [3 /*break*/, 14];
                    return [4 /*yield*/, apiRes.json().catch(function () { return ({}); })];
                case 13:
                    body_1 = _h.sent();
                    // 401 means the session is invalid (expired, revoked, or user deleted).
                    // Surface it as 'unauthenticated' so the composer can redirect to sign-in.
                    if (apiRes.status === 401) {
                        return [2 /*return*/, { ok: false, url: null, mediaType: null, errorKind: 'unauthenticated', message: 'Session expired — please sign in again.' }];
                    }
                    return [2 /*return*/, {
                            ok: false, url: null, mediaType: null, errorKind: 'upload_failed',
                            message: (_e = body_1 === null || body_1 === void 0 ? void 0 : body_1.message) !== null && _e !== void 0 ? _e : "Upload failed (HTTP ".concat(apiRes.status, ")"),
                            detail: { status: apiRes.status, mimeType: mime, fileSize: (_f = media.fileSize) !== null && _f !== void 0 ? _f : blob.size },
                        }];
                case 14: return [4 /*yield*/, apiRes.json().catch(function () { return ({}); })];
                case 15:
                    body = _h.sent();
                    url = (_g = body === null || body === void 0 ? void 0 : body.url) !== null && _g !== void 0 ? _g : null;
                    if (!url) {
                        return [2 /*return*/, { ok: false, url: null, mediaType: null, errorKind: 'upload_failed', message: 'Upload succeeded but no URL returned' }];
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
