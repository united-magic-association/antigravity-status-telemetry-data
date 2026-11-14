# antigravity-status-telemetry-data

Public anonymized hourly telemetry snapshots and automated GitHub Pages build for [`united-magic-association/antigravity-status`](https://github.com/united-magic-association/antigravity-status).

## Repository Structure

- `.github/workflows/sync-and-deploy.yml`: Hourly GitHub Actions workflow (`15 * * * *`, running off-peak after the Worker's `:10 UTC` rollup) that pulls finalized hourly rollups from the Cloudflare Worker (`${TELEMETRY_BASE_URL}/api/telemetry/stats`), updates `data/`, builds the web dashboard from `united-magic-association/antigravity-status`, and deploys to GitHub Pages.
- `scripts/sync.ts`: Incremental hourly rollup sync and rolling window (`24h`, `7d`, `30d`) builder.
- `data/`:
  - `manifest.json`: Index of available hourly snapshots and rolling aggregates.
  - `hourly/YYYY-MM-DDTHHZ.json`: Anonymized hourly rollup snapshots (retained for 90 days).
  - `rolling/{24h,7d,30d}.json`: Pre-merged rolling window reports.

## Setup Checklist

1. Under **Settings -> Pages**, set **Build and deployment -> Source** to **GitHub Actions**.
2. Under **Settings -> Secrets and variables -> Actions**, add:
   - Variable `TELEMETRY_BASE_URL`: `https://antigravity-status-telemetry.<your-subdomain>.workers.dev`
   - Secret `TELEMETRY_API_TOKEN`: matching secret configured on the Cloudflare Worker.
3. Trigger **Sync Telemetry & Deploy Pages** via `workflow_dispatch` once to publish the initial dashboard.
