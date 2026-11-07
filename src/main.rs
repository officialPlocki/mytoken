use dioxus::prelude::*;

const BASH_SCRIPT: &str = include_str!("../public/scripts/usage-audit.sh");
const POWERSHELL_SCRIPT: &str = include_str!("../public/scripts/usage-audit.ps1");
const ANALYZER_SCRIPT: &str = include_str!("../public/scripts/usage-audit.mjs");
const SITE_ORIGIN: &str = match option_env!("SITE_ORIGIN") {
    Some(value) => value,
    None => "https://mytoken.alivethrush.chatgpt.site",
};

#[derive(Clone, Copy, PartialEq)]
enum Platform {
    MacLinux,
    Windows,
}

#[component]
fn App() -> Element {
    let mut platform = use_signal(|| Platform::MacLinux);
    let mut copied = use_signal(|| false);
    let is_windows = platform() == Platform::Windows;
    let script_url = format!("{}/scripts/{}", SITE_ORIGIN, if is_windows { "usage-audit.ps1" } else { "usage-audit.sh" });
    let command = if is_windows {
        format!("$env:MYTOKEN_SITE_ORIGIN='{}'; try {{ irm '{}' | iex }} finally {{ Remove-Item Env:MYTOKEN_SITE_ORIGIN -ErrorAction SilentlyContinue }}", SITE_ORIGIN, script_url)
    } else {
        format!("curl -fsSL '{}' | MYTOKEN_SITE_ORIGIN='{}' bash", script_url, SITE_ORIGIN)
    };
    let copied_command = command.clone();

    rsx! {
        main { class: "page-shell",
            header { class: "topbar",
                a { class: "brand", href: "#top", aria_label: "mytoken home",
                    span { class: "brand-mark", "MT" }
                    span { "MYTOKEN" }
                }
                a { class: "source-link", href: "https://ccusage.com/guide/", target: "_blank", rel: "noreferrer", "Powered by ccusage ↗" }
            }

            section { id: "top", class: "hero",
                p { class: "eyebrow", "LOCAL TOKEN COST AUDIT" }
                h1 { "See what your tokens would cost anywhere." }
                p { class: "lede", "A single local script reads every supported ccusage source on this computer, groups usage by day, week, and month, then reprices the same token mix against current API rates." }
            }

            section { class: "command-panel", aria_label: "Run the local report",
                div { class: "panel-heading",
                    div {
                        p { class: "step-label", "01 / CHOOSE YOUR SYSTEM" }
                        h2 { "Run it from your terminal" }
                    }
                    span { class: "local-badge", "RUNS LOCALLY" }
                }
                div { class: "os-tabs", role: "tablist", aria_label: "Operating system",
                    button {
                        class: if platform() == Platform::MacLinux { "os-tab active" } else { "os-tab" },
                        role: "tab", aria_selected: platform() == Platform::MacLinux,
                        onclick: move |_| { platform.set(Platform::MacLinux); copied.set(false); },
                        "macOS / Linux"
                    }
                    button {
                        class: if platform() == Platform::Windows { "os-tab active" } else { "os-tab" },
                        role: "tab", aria_selected: platform() == Platform::Windows,
                        onclick: move |_| { platform.set(Platform::Windows); copied.set(false); },
                        "Windows PowerShell"
                    }
                }
                div { class: "command-row",
                    code { class: "command-text", "{command}" }
                    button {
                        class: "copy-button",
                        aria_label: "Copy terminal command",
                        onclick: move |_| {
                            let script = format!("navigator.clipboard.writeText({:?})", copied_command);
                            let task = document::eval(&script);
                            spawn(async move {
                                let _ = task.await;
                                copied.set(true);
                            });
                        },
                        if copied() { "Copied" } else { "Copy" }
                    }
                }
                p { class: "hint", "Review the full script below before running it. It installs ccusage globally with Bun when available, or npm otherwise." }
            }

            section { class: "flow-strip", aria_label: "What the script does",
                div { class: "flow-item",
                    span { class: "flow-index", "A" }
                    div { strong { "Discover" } p { "All local ccusage sources and models" } }
                }
                span { class: "flow-arrow", "→" }
                div { class: "flow-item",
                    span { class: "flow-index", "B" }
                    div { strong { "Reprice" } p { "Live API rates plus your plan allowances" } }
                }
                span { class: "flow-arrow", "→" }
                div { class: "flow-item",
                    span { class: "flow-index", "C" }
                    div { strong { "Open" } p { "A private HTML report in your browser" } }
                }
            }

            section { class: "script-section",
                div { class: "section-title",
                    p { class: "step-label", "02 / INSPECT THE SOURCE" }
                    h2 { "Every line is readable before you run it." }
                }
                details { class: "script-disclosure",
                    summary { "macOS and Linux launcher", span { "BASH · {BASH_SCRIPT.lines().count()} LINES" } }
                    pre { code { "{BASH_SCRIPT}" } }
                }
                details { class: "script-disclosure",
                    summary { "Windows launcher", span { "POWERSHELL · {POWERSHELL_SCRIPT.lines().count()} LINES" } }
                    pre { code { "{POWERSHELL_SCRIPT}" } }
                }
                details { class: "script-disclosure analyzer-disclosure",
                    summary { "Shared analyzer and report generator", span { "JAVASCRIPT · {ANALYZER_SCRIPT.lines().count()} LINES" } }
                    pre { code { "{ANALYZER_SCRIPT}" } }
                }
            }

            section { class: "profile-panel", aria_label: "Optional tokenmaxxing profile sync",
                div { class: "profile-copy",
                    p { class: "step-label", "OPTIONAL / PUBLIC PROFILE" }
                    h2 { "Keep a longer-running profile with tokenmaxxing." }
                    p { "tokenmaxxing can accumulate daily aggregates each time you sync. It cannot recover local logs that were already deleted, but it can retain data you have already synced." }
                    p { class: "profile-privacy", strong { "This uploads data publicly." } " It sends daily dates, model names, source names, token counts, and API-equivalent estimates. Prompts and session text are not uploaded." }
                    a { href: "https://tokenmaxxing.sh/", target: "_blank", rel: "noreferrer", "Read tokenmaxxing privacy and setup ↗" }
                }
                div { class: "profile-commands",
                    p { class: "profile-command-label", "macOS / Linux" }
                    pre { code { "if command -v bun >/dev/null 2>&1; then bun install -g @851-labs/tokenmaxxing@latest; else npm install -g @851-labs/tokenmaxxing@latest; fi && tokenmaxxing bootstrap" } }
                    p { class: "profile-command-label", "Windows PowerShell" }
                    pre { code { "if (Get-Command bun -ErrorAction SilentlyContinue) { bun install -g @851-labs/tokenmaxxing@latest } else { npm install -g @851-labs/tokenmaxxing@latest }; if ($?) { tokenmaxxing bootstrap }" } }
                }
            }

            footer { class: "footer",
                div { class: "privacy-line",
                    span { class: "privacy-dot" }
                    p { strong { "The local report keeps usage on this computer." } " It downloads public pricing and Go plan metadata, then opens a local file. Tokenmaxxing is a separate, opt-in command that publishes daily aggregates to a public profile." }
                }
                div { class: "footer-notes",
                    span { "API prices are estimates from the current LiteLLM registry." }
                    a { href: "https://ccusage.com/guide/all-reports", target: "_blank", rel: "noreferrer", "Supported sources ↗" }
                }
            }
        }
    }
}

fn main() {
    dioxus::launch(App);
}
