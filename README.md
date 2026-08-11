# upload-thing

A small, near-free file host on Cloudflare. Uploads require a bearer token;
downloads/views are public. Files are served at
`https://files.benthecarman.dev/f/<id>/<filename>`.

## Parts

- `worker/` — Cloudflare Worker backed by an R2 bucket (`upload-thing-files`).
- `cli/` — Rust CLI. The upload token and base URL are baked into the binary
  at build time, so it needs no configuration or environment variables at run
  time.

## Using the CLI

```sh
# Upload a file, prints the public URL
upload-thing put ./report.html

# Upload with a different filename in the URL
upload-thing put ./build.tar.gz --name myapp-v1.2.tar.gz

# Delete by URL or key
upload-thing delete https://files.benthecarman.dev/f/Ab3xK9/report.html
upload-thing delete f/Ab3xK9/report.html
```

The binary is installed at `~/.cargo/bin/upload-thing`. Copy it to any machine
or agent environment as-is; the token travels inside the binary.

## Rebuilding the CLI (e.g. after token rotation)

The build needs `UPLOAD_TOKEN` (and optionally `UPLOAD_BASE_URL`) from the
environment or from `cli/.env` (gitignored):

```sh
cargo install --path cli
```

## Redeploying the Worker

```sh
cd worker
npm install
npx wrangler login          # once per machine
npx wrangler deploy
```

## Rotating the upload token

```sh
cd worker
openssl rand -hex 32        # new token
npx wrangler secret put UPLOAD_TOKEN   # paste the new token
# put the new token in cli/.env, then rebuild the CLI
cargo install --path cli
```

Old CLI binaries stop working once the secret is replaced.

## HTTP API (for reference)

| Method | Path                        | Auth          | Result                    |
|--------|-----------------------------|---------------|---------------------------|
| PUT    | `/upload?filename=<name>`   | Bearer token  | `{ "url": ..., "key": ... }` |
| GET    | `/f/<id>/<name>`            | none          | file bytes, stored type   |
| DELETE | `/delete?key=<key>`         | Bearer token  | `{ "deleted": ... }`      |
| POST   | `/multipart/create`         | Bearer token  | `{ "key": ..., "uploadId": ... }` |
| PUT    | `/multipart/part`           | Bearer token  | `{ "etag": ... }`         |
| POST   | `/multipart/complete`       | Bearer token  | `{ "url": ..., "key": ... }` |
| POST   | `/multipart/abort`          | Bearer token  | `{ "aborted": ... }`      |
| POST   | `/cleanup`                  | Bearer token  | `{ "totalBytes": ..., "deleted": ... }` |

Single-request uploads are limited to ~100 MB by the Cloudflare zone. The CLI
uploads larger files in 50 MB chunks through the multipart endpoints, so files
of 500 MB and more work (R2 allows up to 5 TiB per object).

## Storage cleanup

An hourly cron trigger keeps the bucket under `MAX_STORAGE_BYTES` (default
9 GiB, set in `worker/wrangler.jsonc`). When the total size is over the limit,
the Worker deletes the oldest files first until it is back under. This keeps
usage inside the R2 free tier (10 GB). You can also run a cleanup on demand
with an authenticated `POST /cleanup`.

## Cost

Runs on the Cloudflare free tier: Workers (100k requests/day) and R2
(10 GB storage, no egress fees). Expected cost: $0.
