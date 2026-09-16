# Deploy the tracker Worker (parent dashboard + event ingest), then the router
# so its service binding is current. Requires: npx wrangler login (cached).
# First time only, before this: see tracker/README.md "Deploy (first time)".
Set-Location $PSScriptRoot\tracker
npx wrangler deploy
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Set-Location $PSScriptRoot\router-worker
npx wrangler deploy
