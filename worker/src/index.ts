// upload-thing: authenticated upload, public download file host backed by R2.
//
//   PUT    /upload?filename=<name>   (Bearer auth) -> { url, key }
//   GET    /f/<id>/<name>            (public)
//   DELETE /delete?key=<key>         (Bearer auth)

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
} satisfies ExportedHandler<Env>;
