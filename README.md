# streamtape-direct-worker

A lightweight Cloudflare Worker that resolves an allowed media URL and returns either:

- a **302 redirect** to the final URL
- a **JSON response** with upstream metadata

> Use only with content and origins you are authorized to access.

## Features

- `?mode=redirect` to redirect clients to the final URL
- `?mode=json` to return structured metadata
- CORS support for browser/mobile playback apps
- `GET`, `HEAD`, and `OPTIONS` handling
- range-request forwarding for media players
- request IDs for debugging
- allowlist protection via `ALLOWED_ORIGINS`

## Project structure

- `src/index.js` — Worker entrypoint
- `wrangler.toml` — Wrangler configuration
- `.github/workflows/deploy.yml` — deployment workflow

## Environment variables

Set these in Wrangler or Cloudflare dashboard:

- `ALLOWED_ORIGINS` — comma-separated list of permitted origins
- `DEBUG` — set to `true` to include sanitized error traces in JSON mode

Example:

```bash
ALLOWED_ORIGINS=https://example.com,https://media.example.com
DEBUG=false
```

## Local development

```bash
npm install
npm run dev
```

## Deploy

```bash
npm run deploy
```

## API usage

### JSON mode

Returns the final resolved URL and upstream metadata.

```bash
curl -i "https://YOUR-WORKER.workers.dev/?mode=json&url=https://example.com/video.mp4"
```

### Redirect mode

Redirects the client to the final URL.

```bash
curl -i "https://YOUR-WORKER.workers.dev/?mode=redirect&url=https://example.com/video.mp4"
```

### Range request test

Useful for VLC, ExoPlayer, and browser media elements.

```bash
curl -i \
  -H "Range: bytes=0-1023" \
  "https://YOUR-WORKER.workers.dev/?url=https://example.com/video.mp4"
```

## Response examples

### JSON

```json
{
  "ok": true,
  "requestId": "...",
  "upstream": {
    "status": 200,
    "ok": true,
    "redirected": false,
    "url": "https://example.com/video.mp4",
    "location": null,
    "headers": {
      "contentType": "video/mp4",
      "contentLength": "12345678"
    }
  }
}
```

### Error

```json
{
  "ok": false,
  "error": "origin_not_allowed",
  "message": "Target origin is not allowed by ALLOWED_ORIGINS.",
  "requestId": "..."
}
```

## Notes

- This worker does not bypass upstream protections.
- If your upstream requires signed URLs or authentication, use the provider's supported flow.
- For media playback, prefer `mode=redirect` unless your client needs metadata.
