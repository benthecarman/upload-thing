use clap::{Parser, Subcommand};
use reqwest::blocking::Client;
use reqwest::header::CONTENT_TYPE;
use std::error::Error;
use std::path::PathBuf;

const TOKEN: &str = env!("UPLOAD_TOKEN");
const BASE_URL: &str = env!("UPLOAD_BASE_URL");

#[derive(Parser)]
#[command(name = "upload-thing", about = "Upload files to the upload-thing host and get a public URL")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Upload a file and print its public URL
    Put {
        /// File to upload
        file: PathBuf,
        /// Override the filename used in the URL
        #[arg(long)]
        name: Option<String>,
    },
    /// Delete a previously uploaded file by URL or key
    Delete {
        /// Full URL (https://.../f/<id>/<name>) or bare key (f/<id>/<name>)
        url_or_key: String,
    },
}

fn mime_from_ext(filename: &str) -> &'static str {
    let ext = filename.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript",
        "json" => "application/json",
        "txt" => "text/plain; charset=utf-8",
        "md" => "text/markdown; charset=utf-8",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        "wasm" => "application/wasm",
        "zip" => "application/zip",
        "tar" => "application/x-tar",
        "gz" => "application/gzip",
        _ => "application/octet-stream",
    }
}

/// Percent-encode just enough for a query-parameter value.
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn check_status(resp: reqwest::blocking::Response) -> Result<reqwest::blocking::Response, Box<dyn Error>> {
    if resp.status().is_success() {
        Ok(resp)
    } else {
        let status = resp.status();
        let body = resp.text().unwrap_or_default();
        Err(format!("server returned {status}: {body}").into())
    }
}

/// Files larger than this are uploaded in chunks through the multipart
/// endpoints, because the Cloudflare zone rejects single requests over ~100 MB.
const MULTIPART_THRESHOLD: u64 = 90 * 1024 * 1024;
/// Chunk size for multipart uploads. Must be >= 5 MiB (R2 minimum part size).
const CHUNK_SIZE: u64 = 50 * 1024 * 1024;

fn put(file: PathBuf, name: Option<String>) -> Result<(), Box<dyn Error>> {
    let filename = name
        .or_else(|| file.file_name().map(|n| n.to_string_lossy().into_owned()))
        .ok_or("could not determine filename; pass --name")?;
    let size = std::fs::metadata(&file)?.len();
    let client = Client::new();
    let content_type = mime_from_ext(&filename);

    let url = if size <= MULTIPART_THRESHOLD {
        let bytes = std::fs::read(&file)?;
        let resp = client
            .put(format!("{BASE_URL}/upload?filename={}", urlencode(&filename)))
            .bearer_auth(TOKEN)
            .header(CONTENT_TYPE, content_type)
            .body(bytes)
            .send()?;
        let json: serde_json::Value = check_status(resp)?.json()?;
        json["url"].as_str().ok_or("unexpected response shape")?.to_owned()
    } else {
        put_multipart(&client, &file, &filename, size, content_type)?
    };
    println!("{url}");
    Ok(())
}

fn put_multipart(
    client: &Client,
    file: &PathBuf,
    filename: &str,
    size: u64,
    content_type: &str,
) -> Result<String, Box<dyn Error>> {
    let resp = client
        .post(format!(
            "{BASE_URL}/multipart/create?filename={}",
            urlencode(filename)
        ))
        .bearer_auth(TOKEN)
        .header(CONTENT_TYPE, content_type)
        .send()?;
    let json: serde_json::Value = check_status(resp)?.json()?;
    let key = json["key"].as_str().ok_or("unexpected response shape")?;
    let upload_id = json["uploadId"]
        .as_str()
        .ok_or("unexpected response shape")?;

    let result = upload_parts(client, file, key, upload_id, size);
    if result.is_err() {
        let _ = client
            .post(format!("{BASE_URL}/multipart/abort"))
            .bearer_auth(TOKEN)
            .json(&serde_json::json!({ "key": key, "uploadId": upload_id }))
            .send();
    }
    let parts = result?;

    let resp = client
        .post(format!("{BASE_URL}/multipart/complete"))
        .bearer_auth(TOKEN)
        .json(&serde_json::json!({ "key": key, "uploadId": upload_id, "parts": parts }))
        .send()?;
    let json: serde_json::Value = check_status(resp)?.json()?;
    Ok(json["url"]
        .as_str()
        .ok_or("unexpected response shape")?
        .to_owned())
}

fn upload_parts(
    client: &Client,
    file: &PathBuf,
    key: &str,
    upload_id: &str,
    size: u64,
) -> Result<Vec<serde_json::Value>, Box<dyn Error>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(file)?;
    let total_parts = size.div_ceil(CHUNK_SIZE);
    let mut parts = Vec::new();
    for n in 1..=total_parts {
        f.seek(SeekFrom::Start((n - 1) * CHUNK_SIZE))?;
        let len = CHUNK_SIZE.min(size - (n - 1) * CHUNK_SIZE) as usize;
        let mut buf = vec![0u8; len];
        f.read_exact(&mut buf)?;
        eprintln!("uploading part {n}/{total_parts} ({len} bytes)");
        let resp = client
            .put(format!(
                "{BASE_URL}/multipart/part?key={}&uploadId={}&partNumber={n}",
                urlencode(key),
                urlencode(upload_id)
            ))
            .bearer_auth(TOKEN)
            .header(CONTENT_TYPE, "application/octet-stream")
            .body(buf)
            .send()?;
        let json: serde_json::Value = check_status(resp)?.json()?;
        let etag = json["etag"].as_str().ok_or("unexpected response shape")?;
        parts.push(serde_json::json!({ "partNumber": n, "etag": etag }));
    }
    Ok(parts)
}

fn delete(url_or_key: String) -> Result<(), Box<dyn Error>> {
    let key = url_or_key
        .strip_prefix(BASE_URL)
        .map(|rest| rest.trim_start_matches('/'))
        .unwrap_or(url_or_key.as_str());
    let resp = Client::new()
        .delete(format!("{BASE_URL}/delete?key={}", urlencode(key)))
        .bearer_auth(TOKEN)
        .send()?;
    check_status(resp)?;
    println!("deleted {key}");
    Ok(())
}

fn main() -> Result<(), Box<dyn Error>> {
    let cli = Cli::parse();
    match cli.command {
        Commands::Put { file, name } => put(file, name),
        Commands::Delete { url_or_key } => delete(url_or_key),
    }
}
