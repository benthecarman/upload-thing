use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::Path;

/// Bakes UPLOAD_TOKEN and UPLOAD_BASE_URL into the binary at compile time.
/// Values come from the build environment, falling back to `cli/.env`
/// (gitignored). The build fails if UPLOAD_TOKEN is not set.
fn main() {
    println!("cargo:rerun-if-changed=.env");
    println!("cargo:rerun-if-env-changed=UPLOAD_TOKEN");
    println!("cargo:rerun-if-env-changed=UPLOAD_BASE_URL");

    let mut from_file: HashMap<String, String> = HashMap::new();
    if Path::new(".env").exists() {
        let contents = fs::read_to_string(".env").expect("failed to read .env");
        for line in contents.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some((k, v)) = line.split_once('=') {
                from_file.insert(k.trim().to_string(), v.trim().to_string());
            }
        }
    }

    let resolve = |key: &str| -> Option<String> {
        env::var(key).ok().or_else(|| from_file.get(key).cloned())
    };

    let token = resolve("UPLOAD_TOKEN").unwrap_or_else(|| {
        panic!("UPLOAD_TOKEN is not set: export it or put it in cli/.env before building")
    });
    let base_url = resolve("UPLOAD_BASE_URL")
        .unwrap_or_else(|| "https://files.benthecarman.dev".to_string());

    println!("cargo:rustc-env=UPLOAD_TOKEN={token}");
    println!("cargo:rustc-env=UPLOAD_BASE_URL={}", base_url.trim_end_matches('/'));
}
