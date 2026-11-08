FROM ubuntu:24.04 AS build

ENV CARGO_HOME="/root/.cargo" \
    RUSTUP_HOME="/root/.rustup" \
    PATH="/root/.cargo/bin:/root/.dx/bin:${PATH}"

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash build-essential ca-certificates curl pkg-config libssl-dev unzip \
    && rm -rf /var/lib/apt/lists/*

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain 1.85.1 \
    && rustup target add wasm32-unknown-unknown \
    && curl -sSL https://dioxus.dev/install.sh | bash

WORKDIR /app
COPY . .
RUN dx bundle --web --release \
    && bundle_dir="$(find target/dx -path '*/release/web/public/index.html' -print -quit | sed 's#/index.html$##')" \
    && test -n "$bundle_dir" \
    && mkdir -p /bundle \
    && cp -a "$bundle_dir"/. /bundle/

FROM busybox:1.37.0-musl

WORKDIR /srv
COPY --from=build /bundle/ /srv/

EXPOSE 3000

CMD ["httpd", "-f", "-p", "3000", "-h", "/srv"]
