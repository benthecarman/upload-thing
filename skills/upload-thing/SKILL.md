---
name: upload-thing
description: Upload and share build artifacts, HTML pages, reports, or other files through either a public URL or a private URL protected by Cloudflare Access. Use when Codex needs to give the user a downloadable or viewable file.
---

# upload-thing

Use the `upload-thing` CLI to upload a file.

## Commands

```sh
# Upload a public file. Print the public URL.
upload-thing put ./report.html

# Upload a private file. Cloudflare Access protects the URL.
upload-thing put ./report.html --private

# Use a different filename in the URL.
upload-thing put ./dist/app.tar.gz --name myapp-v1.2.tar.gz

# Delete a public or private file by URL or key.
upload-thing delete https://files.benthecarman.dev/f/Ab3xK9/report.html
upload-thing delete https://files.benthecarman.dev/private/Ab3xK9/report.html

# List public files.
upload-thing list

# List private files.
upload-thing list --private

# Filter either list with a regular expression.
upload-thing list --regex '\.(html|pdf)$'
upload-thing list --private --regex '\.(html|pdf)$'
```

## Rules

- Treat the last line of `put` output as the file URL. Give this URL to the
  user.
- Use a public upload only when the user requests public access or the file is
  safe for anyone with the URL.
- Use `--private` when the file contains restricted information or when public
  access is not clearly acceptable.
- Tell the user that a private URL requires login to the owner's Cloudflare
  account.
- Check a private URL before you give it to the user. An unauthenticated request
  must redirect to Cloudflare Access. If it returns `503`, delete the upload and
  report that Access is not configured.
- Never upload passwords, API keys, authentication tokens, credentials, or
  other secrets. A private URL is access-controlled storage, not a secret
  manager.
- Use `list --regex` to find files by URL, key, or filename. Add `--private`
  to search private files.
- Let the CLI upload large files in chunks automatically.
- Delete temporary files when the user no longer needs them.
