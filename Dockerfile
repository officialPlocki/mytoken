FROM ubuntu:24.04 AS build

ENV CARGO_HOME="/root/.cargo" \
    RUSTUP_HOME="/root/.rustup" \
    PATH="/root/.cargo/bin:/root/.dx/bin:${PATH}"

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash build-essential binaryen ca-certificates curl pkg-config libssl-dev unzip \
    && rm -rf /var/lib/apt/lists/*

RUN set -e; \
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable; \
    target_installed=0; \
    for dist_server in https://rsproxy.cn https://mirrors.tuna.tsinghua.edu.cn/rustup https://static.rust-lang.org; do \
        if RUSTUP_DIST_SERVER="$dist_server" rustup target add wasm32-unknown-unknown; then target_installed=1; break; fi; \
    done; \
    [ "$target_installed" -eq 1 ]; \
    for attempt in 1 2 3 4 5; do \
        if curl --retry 3 --retry-all-errors --retry-delay 2 -fsSL https://dioxus.dev/install.sh -o /tmp/dioxus-install.sh \
            && bash /tmp/dioxus-install.sh \
            && command -v dx >/dev/null; then break; fi; \
        if [ "$attempt" -eq 5 ]; then exit 1; fi; \
        sleep $((attempt * 5)); \
    done

WORKDIR /app
COPY . .
RUN NO_DOWNLOADS=1 dx bundle --web --release \
    && bundle_dir="$(find target/dx -path '*/release/web/public/index.html' -print -quit | sed 's#/index.html$##')" \
    && test -n "$bundle_dir" \
    && mkdir -p /bundle \
    && cp -a "$bundle_dir"/. /bundle/ \
    && mkdir -p /bundle/scripts \
    && cp assets/scripts/usage-audit.* /bundle/scripts/

FROM busybox:1.37.0-musl

WORKDIR /srv
COPY --from=build /bundle/ /srv/

EXPOSE 3000

CMD ["httpd", "-f", "-p", "3000", "-h", "/srv"]
