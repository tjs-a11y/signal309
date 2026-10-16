// Where each episode's audio is served from: the CDN (object storage) once an
// episode has been uploaded and recorded in cdn-manifest.json, otherwise the
// GitHub Pages copy. Pure functions: no network, no secrets.
//
// CDN base: CDN_BASE_URL env, else show.cdn_base in episodes.json. Must be
// https and a custom domain (e.g. https://audio.example.com). Raw bucket hosts
// (*.r2.cloudflarestorage.com, *.amazonaws.com, *.r2.dev) are refused, so the
// feed never depends on a storage vendor's URL and can move providers later.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const RAW_HOSTS = /(\.r2\.cloudflarestorage\.com|\.amazonaws\.com|\.r2\.dev)$/i;

export function cdnBase(show, env = process.env) {
  const raw = (env.CDN_BASE_URL || show.cdn_base || '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  let u;
  try { u = new URL(raw); } catch { throw new Error(`CDN base is not a URL: ${raw}`); }
  if (u.protocol !== 'https:') throw new Error('CDN base must use https');
  if (RAW_HOSTS.test(u.hostname)) throw new Error(`Use the custom CDN domain, not the raw bucket host (${u.hostname})`);
  return raw;
}

export function readManifest(dir) {
  const p = join(dir, 'cdn-manifest.json');
  if (!existsSync(p)) return { version: 1, objects: {} };
  const m = JSON.parse(readFileSync(p, 'utf8'));
  if (m.version !== 1 || typeof m.objects !== 'object') throw new Error('cdn-manifest.json: unknown format');
  return m;
}

// Object key for a file: content-addressed, so a re-rendered episode gets a new
// URL and no CDN or podcast app can keep serving a stale copy.
export const objectKey = (prefix, slug, sha256) => `${prefix.replace(/\/+$/, '')}/${slug}-${sha256.slice(0, 12)}.mp3`;

// The enclosure for one episode: { url, length, source }.
//   source "cdn":   uploaded and recorded in the manifest.
//   source "pages": not uploaded yet; served from GitHub Pages (needs the local mp3).
export function enclosureFor(slug, { show, manifest, localSize, env = process.env }) {
  const base = cdnBase(show, env);
  const obj = manifest.objects[slug];
  if (base && obj && obj.key && obj.size > 0) {
    return { url: `${base}/${obj.key}`, length: obj.size, source: 'cdn' };
  }
  if (localSize == null) return null; // neither uploaded nor in the repo: can't publish it
  return { url: `${show.base}/audio/${slug}.mp3`, length: localSize, source: 'pages' };
}
