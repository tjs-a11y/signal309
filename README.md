# SIGNAL 309

A serialized sci-fi mystery audio drama from Hummingbird. Every night at 3:09 a.m., 1690 AM carries the news from another world.

- Podcast feed: https://tjs-a11y.github.io/signal309/feed.xml
- YouTube: https://www.youtube.com/@hummingbird-s4w

All stories are fiction. Voices are AI-generated.

## Audio storage (CDN)
MP3s start in `podcast/` and are served by GitHub Pages. To move audio to object storage (Cloudflare R2 or AWS S3) behind a custom domain:
1. **Create the bucket.** This is the owner's decision because it involves an account. R2 has no egress fees.
2. **Make it public read-only.**
   - R2: connect a custom domain to the bucket (for example `audio.<domain>`).
   - S3: add the bucket policy with `node scripts/migrate-assets.mjs --apply-public-policy`.
3. **Add repository secrets** `S3_ENDPOINT` (R2 only), `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`, plus the repository variable `CDN_BASE_URL`.
4. **Run the upload.** Run "Upload podcast audio to the CDN"; it also runs on every new MP3. Each verified upload is recorded in `podcast/cdn-manifest.json`, and the feed switches those episodes to the CDN URL. Episode IDs (`guid`) don't change, so listeners don't get duplicates.

Removing old MP3s from Git history to shrink the repo is a separate, destructive step (a history rewrite). Don't do it without the owner's approval.
