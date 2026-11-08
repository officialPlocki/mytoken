# mytoken

mytoken is a local-first cost comparison page built with Dioxus and Rust. Its companion script installs ccusage globally with Bun or npm, reads local daily usage reports for all sources supported by ccusage, compares each recorded token mix against every provider with a priced chat model in the current LiteLLM registry, and opens a local HTML report.

The report includes ccusage-supported daily, weekly, and monthly views. Weekly and monthly rows are grouped from ccusage daily JSON using the default Monday week start and calendar months. It compares API prices only and does not ask about subscriptions or allowances. Models without a listed public rate are counted as $0 and identified in the report notes.

## Source layout

- `src/main.rs` — Dioxus Rust page source
- `assets/` — source assets used by the Dioxus web build
- `assets/site.css` — responsive page styles
- `assets/scripts/usage-audit.sh` — macOS and Linux launcher
- `assets/scripts/usage-audit.ps1` — Windows PowerShell launcher
- `assets/scripts/usage-audit.mjs` — local report and price comparison

For Dokploy, deploy with `compose.yaml`. Its Dockerfile builds the Dioxus app for WebAssembly with `dx bundle --web --release`, then serves the generated bundle with BusyBox on internal port 3000 for Dokploy's Caddy proxy. Dioxus creates the `public/` bundle during deployment; only that generated bundle goes into the runtime image. Railpack should not be used to compile this web app as a native Rust server.
