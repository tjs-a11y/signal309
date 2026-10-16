// Builds the public podcast site (feed.xml + index.html) for episodes whose release time has passed.
// Usage: node podcast/build-feed.mjs <out dir>   (mp3s and .duration files sit next to this script)
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enclosureFor, readManifest } from './media-config.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] || join(here, '..', 'out', 'podcast-site');
const { show, episodes } = JSON.parse(readFileSync(join(here, 'episodes.json'), 'utf8'));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const hms = (s) => { s = Math.round(s); return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const now = Date.now();
mkdirSync(join(out, 'audio'), { recursive: true });
copyFileSync(join(here, 'cover.jpg'), join(out, 'cover.jpg'));
const manifest = readManifest(here);
// Audio comes from the CDN once uploaded (see media-config.mjs), else from this Pages site.
const audio = new Map(episodes.map((e) => {
  const mp3 = join(here, `${e.slug}.mp3`);
  return [e.slug, enclosureFor(e.slug, { show, manifest, localSize: existsSync(mp3) ? statSync(mp3).size : null })];
}));
const live = episodes.filter((e) => Date.parse(e.release) <= now && audio.get(e.slug));
const items = live.map((e, i) => {
  const enc = audio.get(e.slug);
  if (enc.source === 'pages') copyFileSync(join(here, `${e.slug}.mp3`), join(out, 'audio', `${e.slug}.mp3`));
  const dur = Number(readFileSync(join(here, `${e.slug}.duration`), 'utf8'));
  const support = show.support ? `\n\nKeep 1690 on the air: become a Listener on 1690 ($2.99/month, your name in the end credits) ${show.support.monthly} or leave a tip ${show.support.tip}` : '';
  const desc = `${e.summary}\n\nWatch it on YouTube: ${e.youtube}${support}\n\nFiction. Voices are AI-generated.`;
  return `<item><title>${esc(e.title)}</title><description>${esc(desc)}</description><itunes:summary>${esc(desc)}</itunes:summary>`
    + `<enclosure url="${esc(enc.url)}" length="${enc.length}" type="audio/mpeg"/><guid isPermaLink="false">${e.slug}</guid>`
    + `<pubDate>${new Date(e.release).toUTCString()}</pubDate><itunes:duration>${hms(dur)}</itunes:duration><itunes:episode>${i + 1}</itunes:episode><itunes:episodeType>full</itunes:episodeType><itunes:explicit>${show.explicit}</itunes:explicit><link>${esc(e.youtube)}</link></item>`;
}).reverse();
const feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:podcast="https://podcastindex.org/namespace/1.0">
<channel><title>${esc(show.title)}</title><link>${esc(show.site)}</link><atom:link href="${show.base}/feed.xml" rel="self" type="application/rss+xml"/>
<language>${show.language}</language><description>${esc(show.summary)}</description><itunes:summary>${esc(show.summary)}</itunes:summary>
<itunes:author>${esc(show.author)}</itunes:author><itunes:owner><itunes:name>${esc(show.author)}</itunes:name>${show.email ? `<itunes:email>${esc(show.email)}</itunes:email>` : ''}</itunes:owner>
<itunes:image href="${show.base}/cover.jpg"/><image><url>${show.base}/cover.jpg</url><title>${esc(show.title)}</title><link>${esc(show.site)}</link></image>
<itunes:category text="${esc(show.category[0])}"><itunes:category text="${esc(show.category[1])}"/></itunes:category>
<itunes:explicit>${show.explicit}</itunes:explicit><itunes:type>serial</itunes:type>
${items.join('\n')}
</channel></rss>
`;
writeFileSync(join(out, 'feed.xml'), feed);
writeFileSync(join(out, 'index.html'), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SIGNAL 309</title><style>body{background:#050706;color:#ece8e0;font:17px/1.5 system-ui,sans-serif;max-width:640px;margin:0 auto;padding:24px 16px}img{max-width:100%;border-radius:8px}a{color:#e8a33d}</style><img src="cover.jpg" alt="SIGNAL 309 cover"><h1>SIGNAL 309</h1><p>${esc(show.summary)}</p><ul>${live.map((e) => `<li><b>${esc(e.title)}</b>: <a href="${esc(e.youtube)}">watch</a> · <a href="${esc(audio.get(e.slug).url)}">listen</a></li>`).join('')}</ul>${show.support ? `<p><b>Keep 1690 on the air:</b> <a href="${show.support.monthly}">become a Listener on 1690</a> ($2.99/month, your name in the end credits) or <a href="${show.support.tip}">leave a tip</a>.</p>` : ''}${show.apple ? `<p><a href="${show.apple}">Listen on Apple Podcasts</a></p>` : ''}${show.spotify ? `<p><a href="${show.spotify}">Listen on Spotify</a></p>` : ''}<p><a href="feed.xml">Podcast feed (RSS)</a></p>`);
const onCdn = live.filter((e) => audio.get(e.slug).source === 'cdn').length;
console.log(`feed: ${live.length} of ${episodes.length} episodes live (${onCdn} from CDN, ${live.length - onCdn} from Pages)`);
