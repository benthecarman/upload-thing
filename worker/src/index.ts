// upload-thing: authenticated upload, public download file host backed by R2.
//
//   PUT    /upload?filename=<name>        (Bearer auth) -> { url, key }
//   GET    /list                          (Bearer auth) -> { objects, cursor? }
//   GET    /f/<id>/<name>                 (public)
//   DELETE /delete?key=<key>              (Bearer auth)
//
// Multipart uploads (for files over the ~100 MB zone request limit):
//   POST   /multipart/create?filename=<>  (Bearer auth) -> { key, uploadId }
//   PUT    /multipart/part?key&uploadId&partNumber=N   (Bearer auth) -> { etag }
//   POST   /multipart/complete            (Bearer auth, JSON body) -> { url, key }
//   POST   /multipart/abort               (Bearer auth, JSON body) -> { aborted }
//   GET    /favicon.ico                   (public)

import FAVICON from "./favicon.ico";

const ID_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function randomId(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join("");
}

function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return cleaned || "file";
}

const MIME_BY_EXT: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript",
  mjs: "text/javascript",
  json: "application/json",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  pdf: "application/pdf",
  wasm: "application/wasm",
  zip: "application/zip",
  tar: "application/x-tar",
  gz: "application/gzip",
};

function guessContentType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get("Authorization") ?? "";
  const expected = `Bearer ${env.UPLOAD_TOKEN}`;
  const a = new TextEncoder().encode(header);
  const b = new TextEncoder().encode(expected);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

async function handleUpload(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (!(await isAuthorized(request, env))) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (!request.body) {
    return new Response("Missing request body", { status: 400 });
  }
  const filename = sanitizeFilename(url.searchParams.get("filename") ?? "file");
  const key = `f/${randomId(8)}/${filename}`;
  const contentType =
    request.headers.get("Content-Type") ?? guessContentType(filename);
  await env.FILES.put(key, request.body, {
    httpMetadata: { contentType },
  });
  return Response.json({ url: `${url.origin}/${key}`, key });
}

async function handleGet(env: Env, url: URL): Promise<Response> {
  const key = url.pathname.slice(1);
  const object = await env.FILES.get(key);
  if (!object) {
    return new Response("Not found", { status: 404 });
  }
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("Cache-Control", "public, max-age=3600");
  return new Response(object.body, { headers });
}

async function handleDelete(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (!(await isAuthorized(request, env))) {
    return new Response("Unauthorized", { status: 401 });
  }
  const key = url.searchParams.get("key") ?? "";
  if (!key.startsWith("f/")) {
    return new Response("Invalid key", { status: 400 });
  }
  await env.FILES.delete(key);
  return Response.json({ deleted: key });
}

async function handleList(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (!(await isAuthorized(request, env))) {
    return new Response("Unauthorized", { status: 401 });
  }

  const cursor = url.searchParams.get("cursor") ?? undefined;
  const page = await env.FILES.list({ cursor, limit: 1000, prefix: "f/" });
  const objects = page.objects.map((object) => ({
    key: object.key,
    url: `${url.origin}/${object.key}`,
    size: object.size,
    uploaded: object.uploaded.toISOString(),
  }));

  return Response.json({
    objects,
    ...(page.truncated ? { cursor: page.cursor } : {}),
  });
}

function newFileKey(url: URL): string {
  const filename = sanitizeFilename(url.searchParams.get("filename") ?? "file");
  return `f/${randomId(8)}/${filename}`;
}

async function handleMultipartCreate(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (!(await isAuthorized(request, env))) {
    return new Response("Unauthorized", { status: 401 });
  }
  const key = newFileKey(url);
  const contentType =
    request.headers.get("Content-Type") ??
    guessContentType(key.split("/").pop() ?? "");
  const upload = await env.FILES.createMultipartUpload(key, {
    httpMetadata: { contentType },
  });
  return Response.json({ key, uploadId: upload.uploadId });
}

async function handleMultipartPart(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (!(await isAuthorized(request, env))) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (!request.body) {
    return new Response("Missing request body", { status: 400 });
  }
  const key = url.searchParams.get("key") ?? "";
  const uploadId = url.searchParams.get("uploadId") ?? "";
  const partNumber = parseInt(url.searchParams.get("partNumber") ?? "", 10);
  if (!key.startsWith("f/") || !uploadId || !(partNumber >= 1)) {
    return new Response("Invalid key, uploadId, or partNumber", { status: 400 });
  }
  const upload = env.FILES.resumeMultipartUpload(key, uploadId);
  const part = await upload.uploadPart(partNumber, request.body);
  return Response.json({ etag: part.etag });
}

interface MultipartBody {
  key?: string;
  uploadId?: string;
  parts?: { partNumber: number; etag: string }[];
}

async function handleMultipartComplete(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (!(await isAuthorized(request, env))) {
    return new Response("Unauthorized", { status: 401 });
  }
  const body: MultipartBody = await request.json();
  if (!body.key?.startsWith("f/") || !body.uploadId || !body.parts?.length) {
    return new Response("Invalid body", { status: 400 });
  }
  const upload = env.FILES.resumeMultipartUpload(body.key, body.uploadId);
  await upload.complete(body.parts);
  return Response.json({ url: `${url.origin}/${body.key}`, key: body.key });
}

async function handleMultipartAbort(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!(await isAuthorized(request, env))) {
    return new Response("Unauthorized", { status: 401 });
  }
  const body: MultipartBody = await request.json();
  if (!body.key?.startsWith("f/") || !body.uploadId) {
    return new Response("Invalid body", { status: 400 });
  }
  const upload = env.FILES.resumeMultipartUpload(body.key, body.uploadId);
  await upload.abort();
  return Response.json({ aborted: body.key });
}

/// Deletes the oldest files until the bucket is back under MAX_STORAGE_BYTES.
/// Runs hourly from the cron trigger; also reachable through POST /cleanup.
async function cleanup(env: Env): Promise<{ totalBytes: number; deleted: number }> {
  const maxBytes = Number(env.MAX_STORAGE_BYTES);
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.FILES.list({ cursor, limit: 1000 });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  let totalBytes = objects.reduce((sum, o) => sum + o.size, 0);
  let deleted = 0;
  if (totalBytes > maxBytes) {
    objects.sort((a, b) => a.uploaded.getTime() - b.uploaded.getTime());
    for (const object of objects) {
      if (totalBytes <= maxBytes) break;
      await env.FILES.delete(object.key);
      totalBytes -= object.size;
      deleted += 1;
    }
  }
  return { totalBytes, deleted };
}

async function handleCleanup(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthorized(request, env))) {
    return new Response("Unauthorized", { status: 401 });
  }
  const result = await cleanup(env);
  console.log(JSON.stringify({ message: "cleanup", ...result }));
  return Response.json(result);
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "PUT" && url.pathname === "/upload") {
        return await handleUpload(request, env, url);
      }
      if (request.method === "DELETE" && url.pathname === "/delete") {
        return await handleDelete(request, env, url);
      }
      if (request.method === "GET" && url.pathname === "/list") {
        return await handleList(request, env, url);
      }
      if (request.method === "POST" && url.pathname === "/multipart/create") {
        return await handleMultipartCreate(request, env, url);
      }
      if (request.method === "PUT" && url.pathname === "/multipart/part") {
        return await handleMultipartPart(request, env, url);
      }
      if (request.method === "POST" && url.pathname === "/multipart/complete") {
        return await handleMultipartComplete(request, env, url);
      }
      if (request.method === "POST" && url.pathname === "/multipart/abort") {
        return await handleMultipartAbort(request, env);
      }
      if (request.method === "POST" && url.pathname === "/cleanup") {
        return await handleCleanup(request, env);
      }
      if (
        (request.method === "GET" || request.method === "HEAD") &&
        url.pathname === "/favicon.ico"
      ) {
        return new Response(FAVICON, {
          headers: {
            "Content-Type": "image/x-icon",
            "Cache-Control": "public, max-age=86400",
          },
        });
      }
      if (
        (request.method === "GET" || request.method === "HEAD") &&
        url.pathname.startsWith("/f/")
      ) {
        return await handleGet(env, url);
      }
      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.error(JSON.stringify({ message: "unhandled error", error: String(err) }));
      return new Response("Internal error", { status: 500 });
    }
  },
  async scheduled(event, env, ctx): Promise<void> {
    ctx.waitUntil(
      cleanup(env).then((r) =>
        console.log(JSON.stringify({ message: "scheduled cleanup", ...r })),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
