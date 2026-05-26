# nlp-compile-service

Cloud-based compile service for [NLP++](https://github.com/VisualText/nlp-engine) analyzers. The VS Code extension [dehilster.nlp](https://github.com/VisualText/vscode-nlp) generates C++ from an analyzer's `.nlp` source, ships it here, and gets back a platform-specific shared library (`.dll` / `.dylib` / `.so`) without the user needing a local C++ toolchain.

## Status

> ⚠️ **Experimental.** Works end-to-end for analyzers without a `kb` pass. Analyzers that include a `kb` pass currently build cleanly but hard-crash at runtime during pass 16 — see [Known issues](#known-issues) below.

| Layer | Status |
|---|---|
| Extension → dispatcher (POST `/build`) | ✅ |
| Dispatcher → GitHub Actions (`workflow_dispatch`) | ✅ |
| Runner: fetch payload + engine compile libs | ✅ |
| Runner: cmake configure + build | ✅ |
| Runner: upload artifact + logs to dispatcher | ✅ |
| Extension: poll `/jobs/:id`, download artifact | ✅ |
| Compiled `run_analyzer` actually runs | ✅ (nlp-engine v3.1.23+) |
| Compiled passes 1–15 | ✅ |
| Compiled pass 16 (`kb` pass) | ❌ runtime crash, open issue |

## Architecture

```
┌─────────────────┐                        ┌──────────────────────┐
│  vscode-nlp     │  POST /build           │  Cloudflare Worker   │
│  extension      │ ─────────────────────▶ │  (this repo's        │
│  (user laptop)  │   tarball + manifest   │   dispatcher/)       │
└─────────────────┘                        └──────────┬───────────┘
        ▲                                             │
        │                                             │ workflow_dispatch
        │ GET /jobs/:id (poll)                        ▼
        │                            ┌──────────────────────────────┐
        │                            │  GitHub Actions runner       │
        │                            │  (.github/workflows/         │
        │ artifactUrl                │   compile-analyzer.yml)      │
        │                            │                              │
        │                            │  - fetch payload from R2     │
        │                            │  - gh release download       │
        │                            │    nlpengine-compile-libs    │
        │                            │  - synthesize CMakeLists.txt │
        │                            │  - cmake configure + build   │
        │                            │  - upload .dll/.dylib/.so    │
        │                            │    + build.log + errors.json │
        │                            └──────────────┬───────────────┘
        │                                           │ PUT /jobs/:id/artifacts/*
        │                                           │ POST /callback/:id
        │                                           ▼
        │                                  ┌────────────────────┐
        └──────────────────────────────────┤  R2 (artifacts)    │
                                           │  KV (job state)    │
                                           └────────────────────┘
```

## Components

### `dispatcher/` — Cloudflare Worker

Stateless HTTP API that brokers between the extension and GitHub Actions. Stores job rows in KV and binary artifacts (payload tarballs, built `.dll`s, build logs, error JSON) in R2.

Endpoints:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/build` | Extension submits a job. Body: tarball + manifest. Returns `{ jobId }`. Triggers `workflow_dispatch`. |
| `GET` | `/jobs/:id` | Extension polls. Returns `{ status, artifactUrl?, buildLogUrl?, errors? }`. |
| `GET` | `/artifacts/:key` | Public, hash-keyed download of any stored artifact (lib, log, errors). |
| `PUT` | `/jobs/:id/artifacts/:kind` | Runner uploads `lib` / `log` / `errors`. Auth: `Bearer $JOB_TOKEN`. |
| `POST` | `/callback/:id` | Runner notifies dispatcher of final status. |

Source: [`dispatcher/src/index.ts`](dispatcher/src/index.ts).

### `.github/workflows/compile-analyzer.yml` — Runner

Triggered by the dispatcher via `workflow_dispatch`. Inputs are passed as workflow inputs (job ID, payload URL, engine version, platform, analyzer name, KB-only flag, callback URL).

Steps:
1. Checkout this repo for the helper scripts
2. Fetch payload tarball from the dispatcher's R2 (signed URL)
3. `gh release download v<engineVersion>` of `nlpengine-compile-libs-<platform>.zip` from `VisualText/nlp-engine`
4. Synthesize `CMakeLists.txt` via [`scripts/emit-cmake.sh`](scripts/emit-cmake.sh)
5. `cmake -S work -B work/build && cmake --build work/build --config Release`
6. Locate the produced shared library
7. On failure: parse compile errors via [`scripts/parse-errors.py`](scripts/parse-errors.py) into a structured `errors.json`
8. Upload artifact + logs back to dispatcher via [`scripts/upload-result.sh`](scripts/upload-result.sh)
9. POST final status to `/callback/:id`

Platform matrix is hardcoded inline (Windows → `windows-latest`, macOS-arm64 → `macos-latest`, etc.).

### `scripts/`

| File | Purpose |
|---|---|
| `emit-cmake.sh` | Generates `CMakeLists.txt` for the analyzer's `run/*.cpp` + `kb/*.cpp` against the unzipped engine compile libs. Mirrors the local-compile cmake template in `vscode-nlp/src/compile.ts`. |
| `parse-errors.py` | Reads cmake/MSVC build log, extracts file/line/column/severity/message, maps generated `.cpp` line numbers back to source `.nlp` lines via `// nlp-source-file:` / `/* nlp-source: N */` provenance comments emitted by the engine. Writes `errors.json` for the extension to render. |
| `upload-result.sh` | PUTs artifacts (built lib, build.log, errors.json) to dispatcher endpoints using `$JOB_TOKEN`. |

## Deploying your own

You need:

- A **Cloudflare** account (free tier is fine) with **R2** enabled
- A **GitHub** repo that hosts a clone of this service's workflow (the dispatcher triggers `workflow_dispatch` on this repo)
- A **GitHub PAT** (fine-grained, `actions:write` scope) for the dispatcher to trigger workflows
- An **nlp-engine** with [compile libs published](https://github.com/VisualText/nlp-engine/releases) for the platforms you want to support

### 1. Set up Cloudflare resources

```bash
# Bucket
wrangler r2 bucket create nlp-compile-blobs

# KV namespace — copy the returned id into wrangler.toml
wrangler kv namespace create JOBS

# Worker secrets
wrangler secret put GH_TOKEN     # fine-grained PAT, actions:write
wrangler secret put JOB_TOKEN    # any random string, runners use it
```

### 2. Edit `dispatcher/wrangler.toml`

Update `[vars]` with your repo + worker URL, and the KV id from step 1.

### 3. Deploy the worker

```bash
cd dispatcher
npm install
wrangler deploy
```

Note the resulting `https://<name>.<account>.workers.dev` URL.

### 4. Configure GitHub repo secrets

In the repo whose workflow gets `workflow_dispatch`-triggered (the one that hosts `compile-analyzer.yml`):

| Name | Value |
|---|---|
| `DISPATCHER_URL` | The worker URL from step 3 |
| `JOB_TOKEN` | Same value you set for the worker secret |

### 5. Point the extension at your deployment

In VS Code user/workspace settings:

```jsonc
{
  "compile.mode": "cloud",
  "compile.dispatcherUrl": "https://<your-worker>.workers.dev"
}
```

## Local development

### Dispatcher

```bash
cd dispatcher
npm install
cp .dev.vars.example .dev.vars
# fill in GH_TOKEN, GH_REPO, JOB_TOKEN
wrangler dev
```

### Runner workflow

The runner workflow only runs in GitHub Actions. To test changes locally, the easiest path is `workflow_dispatch` on a fork. The `scripts/` directory can be exercised standalone:

```bash
bash scripts/emit-cmake.sh \
    --anapath /tmp/my-analyzer \
    --engine-libs /tmp/engine-libs \
    --analyzer my-analyzer \
    --kb-only false
```

## Known issues

- **Pass 16 (`kb` pass) hard-crashes at runtime in compiled mode.** The .dll builds and loads cleanly; passes 1–15 execute and produce correct intermediate trees. Pass 16 starts (writes `ana016.tree` handle) then hits a SIGSEGV (no error log, just exit). Likely a NULL deref inside one of the user-defined KB-mutating functions (`AddDate`, `AddTime`, etc.) emitted by the engine codegen. Needs a Windows-debugger session to diagnose. Tracked separately; not blocking analyzers that don't have a `kb` pass.
- **Free-tier GHA queues** for Windows runners can stall 5–10 minutes before a runner picks up. The extension polls up to 30 minutes; longer waits time out.
- **No auth on `POST /build`.** Anyone with the worker URL can trigger a build. Fine for low-volume / known-user deployments; add a shared `BUILD_TOKEN` or per-user auth if exposing more broadly.
- **No rate limiting.** Cloudflare free-tier worker invocation limits will kick in long before billing is a concern, but worth knowing.

## License

Same as [nlp-engine](https://github.com/VisualText/nlp-engine).
