# scripts/

Runtime-fetch and protocol-update tooling. Each script is invoked from
the repo root.

## `fetch-runtime.sh`

Downloads `python-build-standalone` and `uv` for a target triple, into
`runtime/python/<triple>/` and `runtime/uv/<triple>/`. Idempotent —
re-running with the same versions is a no-op (`--force` to wipe and
re-fetch).

```sh
scripts/fetch-runtime.sh                         # host triple
scripts/fetch-runtime.sh x86_64-pc-windows-msvc  # cross-target
```

Versions come from env vars (`PYTHON_VERSION`, `PBS_RELEASE`,
`UV_VERSION`) with built-in defaults. CI sets them via the `env:` block
at the top of `.github/workflows/desktop.yml`.

`desktop/scripts/package.mjs` puts the fetched tree beside the core in the
packaged application; `src/bot/runtime.rs` finds it there.

The `runtime/` tree is gitignored. Each per-triple subtree caches under
the same key in CI (`Cache bundled runtime` step), so a second run on
the same target hits the cache and skips network entirely.

## `extract_liqi.py`

Polled daily by `.github/workflows/auto-liqi.yml`. Reconstructs the Mahjong
Soul liqi protocol **directly from the live Unity client asset bundles** —
the protobuf descriptors shipped as Lua in `Protol/*_pb.lua` and the service
table in `docs/proto_config.bytes` — and writes:

- `src/bridge/majsoul/proto/liqi.proto` — flat proto3 schema (`package lq`),
- `src/bridge/majsoul/liqi.json` — flat rpc-map `".lq.Svc.method" → {req, resp}`.

It exposes `product_version`, `bundle_hash`, and `changed=true/false` as GHA
outputs; the workflow opens a PR on `main` when the schema moved. Requires
`requests`, `UnityPy`, and `protobuf`. There is no dependency on any external
proto release or on the legacy `res/proto/liqi.json` CDN file (a lagging
Laya-era artifact since Mahjong Soul's Unity WASM migration).

Offline mode for local validation reads pre-extracted assets from a directory
instead of downloading:

```sh
python scripts/extract_liqi.py --from-raw <dir-with-lua-and-proto_config>
```

## CI integration

`.github/workflows/desktop.yml` ties it together: build the core, build the
interface, `fetch-runtime.sh`, then `desktop/scripts/package.mjs`, and upload
one application folder per target (linux-x64, macos-arm64, windows-x64).
