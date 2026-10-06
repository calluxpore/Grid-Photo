// Small path / misc helpers for the renderer (no Node access here).

export const isWindows = navigator.userAgent.includes('Windows');
export const SEP = isWindows ? '\\' : '/';

export function basename(p) {
  return (p || '').split(/[\\/]/).pop();
}

export function dirname(p) {
  const parts = (p || '').split(/[\\/]/);
  parts.pop();
  return parts.join(SEP);
}

export function joinPath(dir, name) {
  if (!dir) return name;
  return dir.endsWith('\\') || dir.endsWith('/') ? dir + name : dir + SEP + name;
}

export function stem(p) {
  return basename(p).replace(/\.[^.]*$/, '');
}

export function extname(p) {
  const m = /\.[^.\\/]*$/.exec(p || '');
  return m ? m[0].toLowerCase() : '';
}

export function normcase(p) {
  const s = (p || '').replace(/[\\/]+/g, SEP);
  return isWindows ? s.toLowerCase() : s;
}

export function samePath(a, b) {
  return normcase(a) === normcase(b);
}

export function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Relative path from base dir, or null when not below it. */
export function relativeTo(p, baseDir) {
  const a = normcase(p);
  let b = normcase(baseDir);
  if (!b.endsWith(SEP)) b += SEP;
  return a.startsWith(b) ? p.slice(b.length) : null;
}

export function isAbsolute(p) {
  return /^([a-zA-Z]:[\\/]|[\\/])/.test(p || '');
}

export function resolvePath(baseDir, rel) {
  const parts = joinPath(baseDir, rel).split(/[\\/]+/);
  const out = [];
  for (const part of parts) {
    if (part === '..') out.pop();
    else if (part !== '.') out.push(part);
  }
  const joined = out.join(SEP);
  return !isWindows && !joined.startsWith('/') ? `/${joined}` : joined;
}
