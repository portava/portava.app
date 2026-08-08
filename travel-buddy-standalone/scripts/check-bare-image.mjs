#!/usr/bin/env node
/**
 * check-bare-image.mjs
 *
 * Guards against binding a private-bucket media URL to a raw image element.
 *
 * PROBLEM
 * -------
 * `post-media` and `profile-media` are PRIVATE Supabase buckets. A stored
 * value is either a bare `<bucket>/<path>` reference (what the upload
 * endpoints return) or a legacy public URL into a bucket that is no longer
 * public. NEITHER form loads in an <Image>. The API returns these columns raw
 * — e.g. api-server routes/follows.ts returns `avatarUrl: p.avatar_url` with
 * no signing — so a surface that binds one directly renders a blank box.
 *
 * It renders blank *silently*: the usual `url ? <Image/> : <Initials/>`
 * fallback tests truthiness, and an unsigned `profile-media/…` string is
 * perfectly truthy. There is no error, no log, and no fallback — just an empty
 * rectangle. That is the blank-media bug class fixed in 50bb012b5…db2dd781b,
 * and this check exists so it cannot come back one screen at a time.
 *
 * FIX
 * ---
 * Route the URL through the signed-URL hydration layer AND render it with a
 * component that has a designed fallback, so a null/failed resolve shows a
 * real empty state instead of a blank box:
 *
 *   Avatar            src/components/ui/Avatar.tsx
 *                     circular avatars — degrades to initials / kind glyph
 *   DisplayMediaImage src/components/ui/DisplayMediaImage.tsx
 *                     content images — skeleton, then designed fallback
 *   AvatarImage       src/components/ui/DisplayMediaImage.tsx
 *   CachedImage       src/components/CachedImage.tsx
 *                     drop-in <Image> replacement, hydrates + MediaFallback
 *
 * All four call useHydratedMedia()/hydrateMediaUrls() internally, so the call
 * site just passes the stored value.
 *
 * WHAT THIS CHECK DETECTS
 * -----------------------
 * A JSX element whose tag resolves to a RAW image component — `Image` imported
 * from 'react-native' or from 'expo-image', under whatever local alias — whose
 * `source` binds a `uri:` expression that names a media column.
 *
 * A "media column" is an identifier containing avatar / cover / photo / media /
 * image / thumbnail / thumb / poster AND ending in `Url` or `_url`, plus the
 * explicit `previewUri` (see ALLOWED). That is a deliberately name-based
 * heuristic: this check is zero-dependency and does not type-check, so it
 * cannot know a URL's provenance. Names in this codebase are consistent enough
 * for it, and anything it gets wrong belongs in ALLOWED with a reason.
 *
 * DELIBERATELY NOT MATCHED
 * ------------------------
 * - `*.uri` / `mediaUri` / `photoUri` — the codebase convention for a LOCAL
 *   device file handle from expo-image-picker (PostcardComposer `asset.uri`,
 *   PulseCreate `media.uri`, StoryComposer/HighlightComposer `mediaUri`,
 *   MediaFilterEditor `file.uri`). These are `file://` paths that have not been
 *   uploaded yet. Signing them is meaningless.
 * - `*ArtworkUrl` (stamps) — stamp artwork is signed SERVER-side before it
 *   reaches the client, in api-server routes/stamps.ts via createSignedUrls().
 *   It arrives already usable and must not be signed a second time.
 * - Expressions naming themselves as already-resolved (`hydrated*`,
 *   `resolved*`, `signed*`). Some surfaces hydrate inline rather than via a
 *   resilient component; that is compliant, if more verbose.
 *
 * SCOPE LIMITATION
 * ----------------
 * Text-based, like the other checks in this directory. It reads the opening
 * tag only, so `<Image source={buildSource(post)} />` — where the media URL is
 * assembled in a helper — is invisible to it. It catches the literal binding,
 * which is how every one of the 55 sites in the original sweep was written.
 *
 * EXCEPTIONS
 * ----------
 * ALLOWED below is keyed by file AND by expression, not by line number, so it
 * survives edits and cannot accidentally exempt a second binding in the same
 * file. Every entry carries a NOTE saying why that specific binding is correct
 * as written. An entry whose NOTE is "it was noisy" does not belong here — fix
 * the site or refine the pattern.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, extname, relative, sep } from 'node:path';
import process from 'node:process';

const SCAN_ROOTS = ['app', 'src'];
const SOURCE_EXTS = new Set(['.ts', '.tsx']);

/**
 * Files that ARE the hydration layer, or that are exempt wholesale.
 * A raw <Image> here is the point, not a bug.
 */
const ALLOWED_FILES = new Set([
  // NOTE: the resilient components themselves. Each one calls
  // useHydratedMedia()/hydrateMediaUrls() and then renders a raw ExpoImage
  // with an onError fallback. This is where the signing actually happens.
  'src/components/ui/Avatar.tsx',
  'src/components/ui/DisplayMediaImage.tsx',
  'src/components/CachedImage.tsx',
  // NOTE: hydrates its own poster URL — a video poster is a post-media object
  // but SharedVideoPlayer must own the source/poster pair together, so it
  // cannot delegate to DisplayMediaImage.
  'src/components/ui/SharedVideoPlayer.tsx',
  // NOTE: hydrates inline; the thumbnail is derived from the video's own
  // post-media reference rather than passed in.
  'src/components/ui/VideoThumbnail.tsx',
]);

/**
 * Per-binding exemptions: file -> [{ expr, why }].
 *
 * `expr` is matched as a substring of the bound uri expression, so
 * `previewUri` exempts `{ uri: previewUri }` but NOT `{ uri: memory.photoUrl }`
 * in the same file.
 */
const ALLOWED_BINDINGS = {
  'src/components/EventComposerSheet.tsx': [
    {
      expr: 'previewUri',
      why: 'Local expo-image-picker result shown while composing an event cover. '
        + 'A file:// URI on the device — not uploaded yet, so there is nothing to sign.',
    },
  ],
  'src/components/MemoriesTab.tsx': [
    {
      expr: 'previewUri',
      why: 'Local picker preview in the memory composer (file:// on device). '
        + 'Note memory.photoUrl in this same file is NOT exempt — that one is post-media.',
    },
    {
      expr: 'photoUri',
      why: 'Second local picker preview in the same composer flow.',
    },
  ],
  'app/gems/submit.tsx': [
    {
      expr: 'form.imageUrl',
      why: 'User-typed URL in the gem submission form, echoed back as a live preview. '
        + 'It is arbitrary external input and is not in our storage at all.',
    },
  ],
  'app/trip/edit.tsx': [
    {
      expr: 'coverUrl',
      why: 'Local picker preview of a newly chosen trip cover, before upload. '
        + 'The already-saved cover on this screen renders through DisplayMediaImage.',
    },
  ],
  'app/trip/new.tsx': [
    {
      expr: 'coverUrl',
      why: 'Local picker preview of the cover being chosen for a trip that does not '
        + 'exist server-side yet.',
    },
  ],
};

/** Identifiers naming a media column that lives in post-media / profile-media. */
const MEDIA_URL_RE =
  /\b\w*(?:avatar|cover|photo|media|image|thumbnail|thumb|poster)\w*(?:Url|_url)\b/i;

/** Explicitly-tracked picker-preview name (see ALLOWED_BINDINGS). */
const PREVIEW_RE = /\b(?:previewUri|photoUri)\b/;

/** Expressions that announce they have already been through the sign layer. */
const ALREADY_HYDRATED_RE = /\b(?:hydrated|resolved|signed)\w*/i;

/** Stamp artwork is signed server-side — never a violation. See header. */
const SERVER_SIGNED_RE = /artwork/i;

/**
 * Tag names in this file that render a RAW image, i.e. bypass hydration.
 * Handles `import { Image }`, `import { Image as X }` and default imports
 * from both react-native and expo-image.
 */
function rawImageTags(src) {
  const tags = new Set();
  const importRe = /import\s+([^;]+?)\s+from\s+['"](react-native|expo-image)['"]/gs;
  let m;
  while ((m = importRe.exec(src)) !== null) {
    const clause = m[1];
    const braced = clause.match(/{([^}]*)}/s);
    if (braced) {
      for (const spec of braced[1].split(',')) {
        const parts = spec.trim().split(/\s+as\s+/);
        if (parts[0].trim() === 'Image') tags.add((parts[1] ?? parts[0]).trim());
      }
    }
    // Default import from expo-image (`import Image from 'expo-image'`) is not
    // a supported form of that package, so only the named case is handled.
  }
  return tags;
}

function collectFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // directory doesn't exist — skip silently
  }
  for (const entry of entries) {
    if (entry.isDirectory() && (entry.name === '__tests__' || entry.name === '__mocks__')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, out);
    } else if (SOURCE_EXTS.has(extname(entry.name))) {
      if (entry.name.includes('.test.') || entry.name.includes('.spec.')) continue;
      out.push(full);
    }
  }
  return out;
}

/** Line number (1-based) of a character offset. */
function lineAt(src, offset) {
  let line = 1;
  for (let i = 0; i < offset; i++) if (src[i] === '\n') line++;
  return line;
}

const violations = [];

for (const root of SCAN_ROOTS) {
  for (const file of collectFiles(root)) {
    const rel = relative('.', file).split(sep).join('/');
    if (ALLOWED_FILES.has(rel)) continue;

    const src = readFileSync(file, 'utf8');
    const tags = rawImageTags(src);
    if (tags.size === 0) continue;

    const exemptions = ALLOWED_BINDINGS[rel] ?? [];

    for (const tag of tags) {
      // Match the tag only when followed by a delimiter, so <Image> does not
      // also match <ImageBackground>.
      const tagRe = new RegExp(`<${tag}(?=[\\s/>])`, 'g');
      let m;
      while ((m = tagRe.exec(src)) !== null) {
        // The opening tag runs until the next '<' (an Image has no children)
        // or 800 chars, whichever comes first.
        const rest = src.slice(m.index + 1, m.index + 800);
        const nextTag = rest.indexOf('<');
        const openingTag = nextTag === -1 ? rest : rest.slice(0, nextTag);

        const uriMatch = openingTag.match(/uri:\s*([^,}\n]+)/);
        if (!uriMatch) continue;
        const expr = uriMatch[1].trim();

        const isMedia = MEDIA_URL_RE.test(expr) || PREVIEW_RE.test(expr);
        if (!isMedia) continue;
        if (ALREADY_HYDRATED_RE.test(expr)) continue;
        if (SERVER_SIGNED_RE.test(expr)) continue;

        const exempt = exemptions.find((e) => expr.includes(e.expr));
        if (exempt) continue;

        violations.push({ file: rel, line: lineAt(src, m.index), tag, expr });
      }
    }
  }
}

if (violations.length > 0) {
  const files = new Set(violations.map((v) => v.file));
  console.error(
    `\nbare-image guard: ${violations.length} binding(s) across ${files.size} file(s) `
    + `put a private-bucket media URL on a raw image element:\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  <${v.tag} source={{ uri: ${v.expr} }}`);
  }
  console.error(`
WHY THIS IS A BUG
  post-media and profile-media are PRIVATE buckets. The stored value is a bare
  "<bucket>/<path>" reference, or a legacy public URL into a bucket that is no
  longer public. Neither loads in an <Image>. The API returns these columns
  unsigned, so the element renders an empty rectangle — and because the usual
  "url ? <Image/> : <Fallback/>" guard only tests truthiness, the fallback
  never fires and nothing is logged.

FIX — hydrate the URL and render it with a component that has a real fallback:

  // BAD — blank box when the URL is an unsigned profile-media reference
  {item.avatarUrl ? (
    <Image source={{ uri: item.avatarUrl }} style={s.avatar} />
  ) : (
    <View style={s.placeholder}><Text>{initial}</Text></View>
  )}

  // GOOD — hydrates internally, degrades to initials on a null/failed resolve
  <Avatar uri={item.avatarUrl} name={item.name} size={40} />

  Avatar            src/components/ui/Avatar.tsx          (circular avatars)
  DisplayMediaImage src/components/ui/DisplayMediaImage.tsx (content images)
  CachedImage       src/components/CachedImage.tsx        (drop-in <Image>)

If a binding is genuinely NOT a private-bucket URL — a local expo-image-picker
file:// preview, or arbitrary external input — add it to ALLOWED_BINDINGS in
scripts/check-bare-image.mjs, keyed by file and expression, with a NOTE saying
why. Do not add entries just to quiet the check.
`);
  process.exit(1);
}

console.log(
  `lint:bare-image — no unhydrated private-bucket media bindings in ${SCAN_ROOTS.join(', ')}.`,
);
