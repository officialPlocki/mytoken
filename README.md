# mytoken

mytoken is a local-first cost comparison page built with Dioxus and Rust. Its companion script installs ccusage globally with Bun or npm, reads local daily usage reports for all sources supported by ccusage, compares each recorded token mix against every provider with a priced chat model in the current LiteLLM registry, and opens a local HTML report.

The report includes ccusage-supported daily, weekly, and monthly views plus per-model usage. Weekly and monthly rows are grouped from ccusage daily JSON using the default Monday week start and calendar months. It compares API prices only and does not ask about subscriptions or allowances. Unrated and zero-priced models stay visible in usage but are excluded from paid comparisons. Alternatives must have positive listed input/output/cache rates, match the used model's name-derived tier and recorded capabilities, and list an input context within 100,000 tokens. All long report tables paginate at 25 rows, and the comparison list supports cost, savings, context, provider, and model sorting. If the tokenmaxxing CLI is installed and already authenticated, the analyzer imports older public profile history automatically and asks before syncing local usage to tokenmaxxing.sh.

## Source layout

- `src/main.rs` — Dioxus Rust page source
- `assets/` — source assets used by the Dioxus web build
- `assets/site.css` — responsive page styles
- `assets/scripts/usage-audit.sh` — macOS and Linux launcher
- `assets/scripts/usage-audit.ps1` — Windows PowerShell launcher
- `assets/scripts/usage-audit.mjs` — local report and price comparison

For Dokploy, deploy with `compose.yaml`. Its Dockerfile builds the Dioxus app for WebAssembly with `dx bundle --web --release`, then serves the generated bundle with BusyBox on internal port 3000 for Dokploy's Caddy proxy. Dioxus creates the `public/` bundle during deployment; only that generated bundle goes into the runtime image. Railpack should not be used to compile this web app as a native Rust server.
