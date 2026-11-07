# mytoken

mytoken is a local-first cost comparison page built with Dioxus and Rust. Its companion script installs ccusage globally with Bun or npm, reads local daily usage reports for all sources supported by ccusage, compares each recorded token mix against every provider with a priced chat model in the current LiteLLM registry, and opens a local HTML report.

The report includes ccusage-supported daily, weekly, and monthly views. Weekly and monthly rows are grouped from ccusage daily JSON using the default Monday week start and calendar months. Subscription coverage is entered locally; OpenCode Go model limits are refreshed from the official plan documentation when available.

## Source layout

- `src/main.rs` — Dioxus Rust page source
- `public/index.html` — static deploy page
- `public/assets/site.css` — responsive page styles
- `public/scripts/usage-audit.sh` — macOS and Linux launcher
- `public/scripts/usage-audit.ps1` — Windows PowerShell launcher
- `public/scripts/usage-audit.mjs` — local report and price comparison

The static page is packaged from `public/` for Sites hosting. Build the Dioxus web application with the Dioxus CLI and the `wasm32-unknown-unknown` Rust target when those tools are available.
