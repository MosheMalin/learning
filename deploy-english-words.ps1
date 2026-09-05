# Deploy the english-words app to Cloudflare Pages.
# Requires: npx wrangler login (one-time, already done on this machine).
Set-Location $PSScriptRoot\english-words
npx wrangler pages deploy . --project-name english-words --branch main --commit-dirty=true
