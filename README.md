# docx2md

Public DOCX ? Markdown converter with preview. Uses GitHub Actions for conversion and a Cloudflare Worker backend so users don't need a token.

## How it works
- The web UI uploads your `.docx` to a temporary file host (tmpfiles.org).
- The Cloudflare Worker triggers a GitHub Actions workflow with that temp URL.
- The workflow converts the file and uploads a zip artifact.
- The Worker streams the artifact back to the browser.

## GitHub Pages Setup
1. Repo Settings -> Pages
2. Source: `Deploy from a branch`
3. Branch: `main` / `/docs`

## Cloudflare Worker Setup
1. Create a Worker and deploy `worker/index.js`.
2. Add variables:
   - `GITHUB_OWNER` = your GitHub org/user
   - `GITHUB_REPO` = `docx2md`
   - `GITHUB_BRANCH` = `main`
3. Add secret:
   - `GITHUB_TOKEN` = fine-grained PAT (Actions: read/write)
4. Set the Worker URL in `docs/app.js`:
```
const WORKER_BASE = "https://docx2md.bikstudy.workers.dev";
```

## Notes
- No files are committed to the repo.
- The workflow runs on manual dispatch only.
