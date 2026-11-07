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
    let script_url = format!(
        "{}/scripts/{}",
        SITE_ORIGIN,
        if is_windows {
            "usage-audit.ps1"
        } else {
            "usage-audit.sh"
        }
    );
    let command = if is_windows {
        format!(
            "$env:MYTOKEN_SITE_ORIGIN='{}'; try {{ irm '{}' | iex }} finally {{ Remove-Item Env:MYTOKEN_SITE_ORIGIN -ErrorAction SilentlyContinue }}",
            SITE_ORIGIN, script_url
        )
    } else {
        format!(
            "MYTOKEN_SITE_ORIGIN='{}' bash -c \"$(curl -fsSL '{}')\"",
            SITE_ORIGIN, script_url
        )
    };
    let copied_command = command.clone();

    rsx! {
        main { class: "page-shell",
            header { class: "topbar",
                a { class: "brand", href: "#top", aria_label: "mytoken home",
                    img { class: "brand-mark", src: "/assets/mytoken-mark.svg", alt: "", aria_hidden: "true" }
                    span { "MYTOKEN" }
                }
                a { class: "source-link", href: "https://ccusage.com/guide/", target: "_blank", rel: "noreferrer", "Powered by ccusage ↗" }
            }

            section { id: "top", class: "hero",
                p { class: "eyebrow", "TOKEN COST AUDIT" }
                h1 { "See what your tokens would cost anywhere." }
                p { class: "lede", "A single local script reads every supported ccusage source on this computer, groups usage by day, week, and month, then reprices the same token mix against current API rates." }
            }

            section { class: "command-panel", aria_label: "Run the local report",
                div { class: "panel-heading",
                    div {
                        p { class: "step-label", "01 / CHOOSE YOUR SYSTEM" }
                        h2 { "Run it from your terminal" }
                    }
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
                    div { strong { "Compare" } p { "Every priced API provider, automatically" } }
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

            footer { class: "footer",
                div { class: "privacy-line",
                    span { class: "privacy-dot" }
                    p { strong { "Usage records stay on this device." } " The analyzer writes the report locally and does not upload records to mytoken or include them in anonymous analytics. The launcher downloads ccusage; the analyzer fetches public API prices and, when relevant, OpenCode Go plan data. The site host and contacted services may receive ordinary connection metadata, such as your IP address." }
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
