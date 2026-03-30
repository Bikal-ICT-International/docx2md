# docx2md (GitHub-only)

Convert Word `.docx` files to GitHub-flavored Markdown with extracted media, using only GitHub Pages + GitHub Actions. No local Pandoc required.

## How it works
- The web UI uploads your `.docx` to a temporary file host (file.io).
- The UI triggers a GitHub Actions workflow via API.
- The workflow converts the file and uploads a zip artifact with Markdown + media.
- The UI downloads and previews the artifact.

## GitHub Pages Setup
1. Repo Settings -> Pages
2. Source: `Deploy from a branch`
3. Branch: `main` / `/docs`

## GitHub Token (required in the UI)
Create a fine-grained PAT with:
- Actions: Read and write
- Contents: Read (optional)

Enter the token in the UI when prompted.

## Notes
- The workflow runs only on manual dispatch.
- Output is stored as an artifact, not committed to the repo.
