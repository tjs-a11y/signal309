import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as S3 from '@aws-sdk/client-s3';
import { cdnBase, enclosureFor, objectKey } from '../podcast/media-config.mjs';
import { plan, publicReadPolicy, scan, sha256File, uploadOne } from '../scripts/migrate-assets.mjs';

const show = { base: 'https://tjs-a11y.github.io/signal309' };
const SHA = 'a'.repeat(64);

test('CDN base must be an https custom domain', () => {
  assert.equal(cdnBase(show, {}), null);
  assert.equal(cdnBase(show, { CDN_BASE_URL: 'https://audio.example.com/' }), 'https://audio.example.com');
  assert.throws(() => cdnBase(show, { CDN_BASE_URL: 'http://audio.example.com' }), /https/);
  assert.throws(() => cdnBase(show, { CDN_BASE_URL: 'https://abc123.r2.cloudflarestorage.com' }), /custom CDN domain/);
  assert.throws(() => cdnBase(show, { CDN_BASE_URL: 'https://bucket.s3.amazonaws.com' }), /custom CDN domain/);
  assert.throws(() => cdnBase(show, { CDN_BASE_URL: 'https://pub-123.r2.dev' }), /custom CDN domain/);
});

test('enclosure: CDN only for uploaded episodes, Pages otherwise, nothing if neither', () => {
  const key = objectKey('signal309/audio', 'ep1', SHA);
  assert.equal(key, 'signal309/audio/ep1-aaaaaaaaaaaa.mp3');
  const manifest = { version: 1, objects: { ep1: { key, size: 123, sha256: SHA } } };
  const env = { CDN_BASE_URL: 'https://audio.example.com' };
  assert.deepEqual(enclosureFor('ep1', { show, manifest, localSize: null, env }), { url: `https://audio.example.com/${key}`, length: 123, source: 'cdn' });
  assert.deepEqual(enclosureFor('ep2', { show, manifest, localSize: 50, env }), { url: `${show.base}/audio/ep2.mp3`, length: 50, source: 'pages' });
  assert.equal(enclosureFor('ep2', { show, manifest, localSize: null, env }), null);
  // No CDN configured: uploaded episodes keep using Pages (nothing changes until the domain exists).
  assert.equal(enclosureFor('ep1', { show, manifest, localSize: 99, env: {} }).source, 'pages');
});

function fixtureDir() {
  const d = mkdtempSync(join(tmpdir(), 's309-'));
  writeFileSync(join(d, 'ep-one.mp3'), Buffer.alloc(2048, 1));
  writeFileSync(join(d, 'ep-two.mp3'), Buffer.alloc(4096, 2));
  writeFileSync(join(d, 'Bad Name.mp3'), Buffer.alloc(10));
  writeFileSync(join(d, 'notes.txt'), 'x');
  return d;
}

test('scan + plan: only new or changed MP3s are uploaded', async () => {
  const d = fixtureDir();
  const files = scan([d]);
  assert.deepEqual([...files.keys()].sort(), ['ep-one', 'ep-two']);
  const sha1 = await sha256File(join(d, 'ep-one.mp3'));
  const manifest = { version: 1, objects: { 'ep-one': { key: 'x', sha256: sha1, size: 2048 } } };
  const todo = await plan(files, manifest, 'signal309/audio');
  assert.deepEqual(todo.map((t) => t.slug), ['ep-two']);
  assert.match(todo[0].key, /^signal309\/audio\/ep-two-[0-9a-f]{12}\.mp3$/);
});

function fakeClient({ headSize, fail = 0 } = {}) {
  const sent = [];
  let failures = fail;
  return {
    sent,
    async send(cmd) {
      sent.push(cmd);
      if (cmd instanceof S3.PutObjectCommand) {
        if (failures-- > 0) throw Object.assign(new Error('503 slow down'), { $metadata: { httpStatusCode: 503 } });
        return {};
      }
      if (cmd instanceof S3.HeadObjectCommand) return { ContentLength: headSize ?? cmd.input.Key.length };
      throw new Error('unexpected command');
    },
  };
}

test('upload: immutable caching, checksum, verified size and CDN reachability', async () => {
  const d = fixtureDir();
  const [item] = await plan(new Map([['ep-one', join(d, 'ep-one.mp3')]]), { version: 1, objects: {} }, 'signal309/audio');
  const client = fakeClient({ headSize: 2048, fail: 1 }); // first PUT fails with 503, retry succeeds
  const heads = [];
  const rec = await uploadOne(item, { client, commands: S3, bucket: 'b', cdn: 'https://audio.example.com', verifyFetch: async (url, init) => { heads.push([url, init.method]); return { ok: true, status: 200 }; } });
  const put = client.sent.find((c) => c instanceof S3.PutObjectCommand).input;
  assert.equal(put.ContentType, 'audio/mpeg');
  assert.equal(put.CacheControl, 'public, max-age=31536000, immutable');
  assert.equal(put.ChecksumSHA256, Buffer.from(item.sha, 'hex').toString('base64'));
  assert.equal(put.ACL, undefined, 'no object ACLs: access is controlled at the bucket/domain level');
  assert.equal(client.sent.filter((c) => c instanceof S3.PutObjectCommand).length, 2);
  assert.deepEqual(heads, [[`https://audio.example.com/${item.key}`, 'HEAD']]);
  assert.deepEqual({ key: rec.key, size: rec.size, sha256: rec.sha256 }, { key: item.key, size: 2048, sha256: item.sha });
});

test('upload refuses to record a file the storage or CDN did not confirm', async () => {
  const d = fixtureDir();
  const [item] = await plan(new Map([['ep-one', join(d, 'ep-one.mp3')]]), { version: 1, objects: {} }, 'p');
  await assert.rejects(uploadOne(item, { client: fakeClient({ headSize: 1 }), commands: S3, bucket: 'b', cdn: 'https://a.example', verifyFetch: null }), /size mismatch/);
  await assert.rejects(uploadOne(item, { client: fakeClient({ headSize: 2048 }), commands: S3, bucket: 'b', cdn: 'https://a.example', verifyFetch: async () => ({ ok: false, status: 403 }) }), /does not serve/);
});

test('S3 public policy grants read on the audio prefix only', () => {
  const p = JSON.parse(publicReadPolicy('my-bucket', 'signal309/audio/'));
  assert.deepEqual(p.Statement[0].Action, 's3:GetObject');
  assert.equal(p.Statement[0].Resource, 'arn:aws:s3:::my-bucket/signal309/audio/*');
});
