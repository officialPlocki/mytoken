FROM rust:1.85-bookworm AS build

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*

RUN rustup target add wasm32-unknown-unknown \
    && curl -sSL https://dioxus.dev/install.sh | bash

ENV PATH="/root/.cargo/bin:${PATH}"
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
