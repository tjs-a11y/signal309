#!/usr/bin/env node
// Moves podcast audio from the Git repo to object storage (Cloudflare R2 or AWS S3)
// behind a custom CDN domain, and records each upload in podcast/cdn-manifest.json.
// build-feed.mjs then points those episodes' <enclosure> at the CDN.
//
//   node scripts/migrate-assets.mjs                    dry run: show what would upload
//   node scripts/migrate-assets.mjs --upload           upload new/changed MP3s, verify, update the manifest
//   node scripts/migrate-assets.mjs --upload --source ../media/out/podcast   also scan the render output folder
//   node scripts/migrate-assets.mjs --apply-public-policy   (S3 only) allow public GET on the audio prefix
//
// Environment (repository secrets in Actions; never commit them):
//   S3_ENDPOINT          R2: https://<account-id>.r2.cloudflarestorage.com   S3: leave empty
//   S3_REGION            R2: auto   S3: e.g. us-east-1
//   S3_BUCKET            bucket name
//   S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY   a key limited to this bucket (write)
//   CDN_BASE_URL         https://audio.<your-domain>  (the custom domain in front of the bucket)
//   S3_PREFIX            optional, default "signal309/audio"
//
// Public, read-only access:
//   R2: connect the custom domain to the bucket (R2 → bucket → Settings → Custom Domains). That makes
//       objects publicly readable through the domain only; the API endpoint stays private.
//   S3: object ACLs are disabled on new buckets, so access is a bucket policy granting s3:GetObject on
//       the prefix only (--apply-public-policy writes it). Writes always need the access key.
// Objects are immutable and content-addressed (<slug>-<sha256 prefix>.mp3), cached for a year.
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { basename, join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cdnBase, objectKey, readManifest } from '../podcast/media-config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PODCAST = resolve(here, '..', 'podcast');
const SLUG_RE = /^[a-z0-9-]{1,80}$/;

export function sha256File(path) {
  return new Promise((ok, fail) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', (d) => h.update(d)).on('end', () => ok(h.digest('hex'))).on('error', fail);
  });
}

// Every *.mp3 in the given folders, by slug. The podcast folder wins over extra sources on a clash.
export function scan(dirs) {
  const found = new Map();
  for (const dir of [...dirs].reverse()) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.mp3')) continue;
      const slug = basename(f, '.mp3');
      if (!SLUG_RE.test(slug)) continue;
      found.set(slug, join(dir, f));
    }
  }
  return found;
}

// Plans the work: which files are new or changed compared with the manifest.
export async function plan(files, manifest, prefix) {
  const todo = [];
  for (const [slug, path] of files) {
    const sha = await sha256File(path);
    const size = statSync(path).size;
    const have = manifest.objects[slug];
    if (have && have.sha256 === sha) continue;
    todo.push({ slug, path, sha, size, key: objectKey(prefix, slug, sha), replaces: have?.key ?? null });
  }
  return todo;
}

async function withRetries(fn, label, attempts = 4) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      const code = e?.$metadata?.httpStatusCode;
      if (code && code >= 400 && code < 500 && code !== 429) break; // our mistake: retrying won't help
      await new Promise((r) => setTimeout(r, 500 * 2 ** i + Math.random() * 250));
    }
  }
  throw new Error(`${label} failed: ${last?.message ?? last}`);
}

// Uploads one file, then confirms the object's size through the storage API and, if
// verifyFetch is given, that the public CDN URL serves it.
export async function uploadOne(item, { client, commands, bucket, cdn, verifyFetch }) {
  const body = readFileSync(item.path);
  await withRetries(() => client.send(new commands.PutObjectCommand({
    Bucket: bucket,
    Key: item.key,
    Body: body,
    ContentType: 'audio/mpeg',
    ContentLength: item.size,
    CacheControl: 'public, max-age=31536000, immutable',
    ChecksumSHA256: Buffer.from(item.sha, 'hex').toString('base64'),
    Metadata: { slug: item.slug, sha256: item.sha },
  })), `upload ${item.key}`);
  const head = await withRetries(() => client.send(new commands.HeadObjectCommand({ Bucket: bucket, Key: item.key })), `check ${item.key}`);
  if (Number(head.ContentLength) !== item.size) throw new Error(`size mismatch for ${item.key}: ${head.ContentLength} != ${item.size}`);
  if (verifyFetch) {
    const url = `${cdn}/${item.key}`;
    const res = await verifyFetch(url, { method: 'HEAD' });
    if (!res.ok) throw new Error(`CDN does not serve ${url} (HTTP ${res.status}); is the custom domain connected and public?`);
  }
  return { key: item.key, sha256: item.sha, size: item.size, uploaded_at: new Date().toISOString() };
}

export function publicReadPolicy(bucket, prefix) {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [{
      Sid: 'PublicReadPodcastAudio',
      Effect: 'Allow',
      Principal: '*',
      Action: 's3:GetObject',
      Resource: `arn:aws:s3:::${bucket}/${prefix.replace(/\/+$/, '')}/*`,
    }],
  });
}

async function main(argv) {
  const args = new Set(argv.filter((a) => a.startsWith('--')));
  const srcIdx = argv.indexOf('--source');
  const extra = srcIdx >= 0 && argv[srcIdx + 1] ? [resolve(argv[srcIdx + 1])] : [];
  const prefix = (process.env.S3_PREFIX || 'signal309/audio').replace(/^\/+|\/+$/g, '');
  const { show } = JSON.parse(readFileSync(join(PODCAST, 'episodes.json'), 'utf8'));
  const cdn = cdnBase(show);
  const manifest = readManifest(PODCAST);
  const files = scan([PODCAST, ...extra]);
  const todo = await plan(files, manifest, prefix);

  console.log(`${files.size} MP3s found, ${todo.length} new or changed.`);
  for (const t of todo) console.log(`  ${t.slug}: ${(t.size / 1e6).toFixed(1)} MB -> ${t.key}${t.replaces ? ` (replaces ${t.replaces})` : ''}`);
  if (!args.has('--upload') && !args.has('--apply-public-policy')) {
    console.log('Dry run. Add --upload to upload.');
    return 0;
  }

  const need = ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'];
  const missing = need.filter((k) => !process.env[k]);
  if (missing.length) { console.error(`Missing ${missing.join(', ')}.`); return 2; }
  if (!cdn) { console.error('Set CDN_BASE_URL (the custom CDN domain) first.'); return 2; }

  const commands = await import('@aws-sdk/client-s3');
  const client = new commands.S3Client({
    region: process.env.S3_REGION || 'auto',
    endpoint: process.env.S3_ENDPOINT || undefined,
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY },
  });
  const bucket = process.env.S3_BUCKET;

  if (args.has('--apply-public-policy')) {
    if (process.env.S3_ENDPOINT) { console.error('R2: make the bucket public by connecting the custom domain in the dashboard; bucket policies are not used.'); return 2; }
    await client.send(new commands.PutBucketPolicyCommand({ Bucket: bucket, Policy: publicReadPolicy(bucket, prefix) }));
    console.log(`Public read enabled for ${bucket}/${prefix}/* only.`);
    if (!args.has('--upload')) return 0;
  }

  let failed = 0;
  for (const t of todo) {
    try {
      manifest.objects[t.slug] = await uploadOne(t, { client, commands, bucket, cdn, verifyFetch: args.has('--no-verify') ? null : fetch });
      // Save after each file so a later failure never loses earlier progress.
      writeFileSync(join(PODCAST, 'cdn-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
      console.log(`  uploaded ${t.slug}`);
    } catch (e) {
      failed++;
      console.error(`  FAILED ${t.slug}: ${e.message}`);
    }
  }
  console.log(failed ? `${failed} upload(s) failed; the feed keeps serving those from Pages.` : 'All uploads verified.');
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(e.message); process.exit(1); });
}
