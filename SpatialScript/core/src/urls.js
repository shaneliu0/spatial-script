// Url containment for textures and assets (SPEC 3.5 url forms).
//
// A script's url reaches the file system of both consumers, so the core is the
// one place that resolves `.` and `..`, refuses an escape from the asset root,
// refuses a scheme outside the documented set, and strips credentials before
// anything is emitted (ROBUST-05).

import { ALLOWED_URL_SCHEMES } from "./limits.js";
import { push, cut } from "./builtins.js";

const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*:)/;

/** Collapses `.` and `..`; returns null when the path climbs above its root. */
function normalizeSegments(path) {
  const parts = path.split("/");
  const out = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    push(out, part);
  }
  return out.join("/");
}

/**
 * Resolves and contains one url.
 *
 * Returns `{ url, warning }`: `url` is what the command stream carries, or
 * `null` when the url is refused; `warning` is a message naming the url when
 * anything was changed or refused.
 */
export function resolveUrl(raw, assetRoot) {
  if (typeof raw !== "string" || raw.length === 0) return { url: raw, warning: null };

  const match = SCHEME.exec(raw);
  if (match !== null) {
    const scheme = match[1].toLowerCase();
    if (ALLOWED_URL_SCHEMES.indexOf(scheme) === -1) {
      return {
        url: null,
        warning: `The url scheme "${scheme}" is not allowed; "${short(raw)}" was dropped`,
      };
    }

    if (scheme === "data:") return { url: raw, warning: null };

    const rest = raw.slice(scheme.length);
    if (!rest.startsWith("//")) {
      // asset://name and other opaque forms: contain the path part.
      const contained = normalizeSegments(rest);
      if (contained === null) {
        return { url: null, warning: `"${short(raw)}" escapes its root and was dropped` };
      }
      return { url: contained === rest ? raw : `${scheme}${contained}`, warning: null };
    }

    // Authority form. Strip any userinfo before it reaches the wire.
    const authorityEnd = indexOfAny(rest, 2, "/?#");
    const authority = rest.slice(2, authorityEnd);
    const tail = rest.slice(authorityEnd);
    const at = authority.lastIndexOf("@");
    let warning = null;
    let host = authority;
    if (at !== -1) {
      host = authority.slice(at + 1);
      warning = `Credentials were stripped from "${short(raw)}" before it reached the consumer`;
    }

    const pathEnd = indexOfAny(tail, 0, "?#");
    const path = tail.slice(0, pathEnd);
    const query = tail.slice(pathEnd);
    const contained = normalizeSegments(path);
    if (contained === null) {
      return { url: null, warning: `"${short(raw)}" escapes its root and was dropped` };
    }
    const rebuilt = `${scheme}//${host}${contained.length > 0 ? `/${contained}` : path === "/" ? "/" : ""}${query}`;

    if (scheme === "file:" && assetRoot) {
      const root = normalizeSegments(assetRoot);
      if (root !== null && root.length > 0 && !contained.startsWith(root)) {
        return {
          url: null,
          warning: `"${short(raw)}" is outside the asset root and was dropped`,
        };
      }
    }
    return { url: rebuilt, warning };
  }

  // Relative: joined onto the asset root and contained inside it. An absolute
  // asset root keeps its leading slash.
  const absoluteRoot = typeof assetRoot === "string" && assetRoot.startsWith("/");
  const joined = assetRoot ? `${trimSlashes(assetRoot)}/${raw}` : raw;
  const contained = normalizeSegments(joined);
  if (contained === null) {
    return { url: null, warning: `"${short(raw)}" escapes the asset root and was dropped` };
  }
  const root = assetRoot ? normalizeSegments(assetRoot) : null;
  if (root !== null && root.length > 0 && !contained.startsWith(root)) {
    return { url: null, warning: `"${short(raw)}" escapes the asset root and was dropped` };
  }
  return { url: absoluteRoot ? `/${contained}` : contained, warning: null };
}

function indexOfAny(text, from, characters) {
  for (let i = from; i < text.length; i += 1) {
    if (characters.indexOf(text[i]) !== -1) return i;
  }
  return text.length;
}

function trimSlashes(text) {
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === "/") start += 1;
  while (end > start && text[end - 1] === "/") end -= 1;
  return text.slice(start, end);
}

function short(url) {
  return url.length > 80 ? `${cut(url, 80)}…` : url;
}
