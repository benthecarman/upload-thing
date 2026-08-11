---
name: upload-thing
description: Use when the user or agent needs to share a build artifact, an HTML page, a report, or any file through a public URL
---

# upload-thing

`upload-thing` is a CLI that uploads files to the user's Cloudflare file host
and prints a public URL. Uploads are authenticated by a token that is baked
into the binary. Downloads are public. Anyone who has the URL can view the
file.

## Commands

```sh
# Upload a file. Prints the public URL to stdout.
upload-thing put ./report.html

# Upload with a different name in the URL.
upload-thing put ./dist/app.tar.gz --name myapp-v1.2.tar.gz

# Delete a file by its URL or its key.
upload-thing delete https://files.benthecarman.dev/f/Ab3xK9/report.html
upload-thing delete f/Ab3xK9/report.html

# List all files. Prints one public URL per line, newest first.
upload-thing list

# List only URLs that match a regular expression.
upload-thing list --regex '\.(html|pdf)$'
```

## Rules for agents

- The last line of stdout from `put` is the public URL. Give this URL to the
  user.
- Use `list --regex` to find files by URL, key, or filename. The CLI returns an
  error if the regular expression is not valid.
- Do not upload secrets, credentials, or private data. URLs are public and
  unguessable, but not protected.
- Large files are uploaded in chunks automatically. There is no practical size
  limit (R2 allows up to 5 TiB for each object).
- Files stay on the host until you delete them. Delete temporary files when
  they are not necessary anymore.
- If the binary is missing, tell the user to run
  `cargo install --path cli` in `~/projects/upload-thing`.
