/**
 * NLP-compile-service dispatcher (sketch).
 *
 * Sits between the VSCode extension and GitHub Actions:
 *
 *   [extension] --POST /build-->  [this worker]
 *                                       |
 *                                       +-- store payload in R2
 *                                       +-- write job row in KV
 *                                       +-- POST GitHub API
 *                                            /repos/{owner}/{repo}/actions/workflows/
 *                                            compile-analyzer.yml/dispatches
 *                                       |
 *                                  returns { jobId }
 *
 *   [extension] --GET /jobs/:id--> [this worker] --(read KV)--> { status, artifactUrl? }
 *
 *   [GH Action] --POST /callback/:id--> [this worker] --(update KV)--> done
 *
 * Default host: Cloudflare Worker. Bindings expected in wrangler.toml:
 *   - R2 bucket   `BLOBS`     (stores payloads + built artifacts)
 *   - KV namespace `JOBS`     (one entry per job, JSON-encoded)
 *   - secrets:    `GH_TOKEN`  (fine-grained PAT with actions:write on the dispatch repo)
 *                 `GH_REPO`   (e.g. "VisualText/nlp-compile-service")
 *                 `CALLBACK_BASE` (public URL of this worker)
 *
 * Portability: only uses fetch, crypto.subtle, Web streams. Drop-in to Node 20+.
 */

export interface Env {
  BLOBS: R2Bucket;
  JOBS: KVNamespace;
  GH_TOKEN: string;
  GH_REPO: string;        // "owner/repo"
  CALLBACK_BASE: string;  // "https://compile.visualtext.org"
  JOB_TOKEN: string;      // shared secret runners present on uploads
}

type ArtifactKind = "lib" | "log" | "errors";
const ARTIFACT_KINDS: readonly ArtifactKind[] = ["lib", "log", "errors"];

type JobStatus = "queued" | "running" | "done" | "failed";

interface JobRow {
  id: string;
  status: JobStatus;
  engineVersion: string;
  platform: string;
  analyzerName: string;
  kbOnly: boolean;
  sourcesHash: string;
  payloadKey: string;       // R2 key of the uploaded tarball
  artifactKey?: string;     // R2 key once built
  artifactSha256?: string;
  buildLogKey?: string;
  errors?: unknown[];
  createdAt: number;
  updatedAt: number;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;

    try {
      if (req.method === "POST" && pathname === "/build") {
        return await handleBuild(req, env);
      }
      if (req.method === "GET" && pathname.startsWith("/jobs/")) {
        return await handleGetJob(pathname.slice("/jobs/".length), env);
      }
      if (req.method === "GET" && pathname.startsWith("/artifacts/")) {
        return await handleGetArtifact(pathname.slice("/artifacts/".length), env);
      }
      const putMatch = pathname.match(/^\/jobs\/([^/]+)\/artifacts\/([^/]+)$/);
      if (req.method === "PUT" && putMatch) {
        return await handlePutArtifact(putMatch[1], putMatch[2], req, env);
      }
      if (req.method === "POST" && pathname.startsWith("/callback/")) {
        return await handleCallback(pathname.slice("/callback/".length), req, env);
      }
      return new Response("not found", { status: 404 });
    } catch (err) {
      console.error(err);
      return new Response("internal error", { status: 500 });
    }
  },
};

// ---------------------------------------------------------------------------
// POST /build  — accept manifest + tarball, dedupe by hash, dispatch workflow.
// ---------------------------------------------------------------------------
//
// Request: multipart/form-data
//   manifest: JSON blob (see schema in the README of this repo)
//   payload:  application/gzip (tarball of run/, kb/, StdAfx.h, manifest.json)
//
// Response: { jobId, cached: boolean, artifactUrl? }
async function handleBuild(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const manifestRaw = form.get("manifest");
  const payload = form.get("payload");
  if (typeof manifestRaw !== "string" || !(payload instanceof File)) {
    return json({ error: "manifest (string) and payload (file) required" }, 400);
  }

  const manifest = JSON.parse(manifestRaw) as {
    engineVersion: string;
    platform: string;
    analyzerName: string;
    kbOnly: boolean;
    sourcesHash: string;
  };

  // Cache key: same inputs + same engine version = same artifact.
  const cacheKey = `cache/${manifest.platform}/${manifest.engineVersion}/${manifest.sourcesHash}/${manifest.kbOnly ? "kb" : "full"}`;
  const cached = await env.BLOBS.head(cacheKey);
  if (cached) {
    return json({
      jobId: cacheKey,
      cached: true,
      artifactUrl: `${env.CALLBACK_BASE}/artifacts/${encodeURIComponent(cacheKey)}`,
    });
  }

  // New job: persist payload + a job row, then dispatch the workflow.
  const jobId = crypto.randomUUID();
  const payloadKey = `payloads/${jobId}.tar.gz`;
  await env.BLOBS.put(payloadKey, payload.stream());

  const now = Date.now();
  const row: JobRow = {
    id: jobId,
    status: "queued",
    engineVersion: manifest.engineVersion,
    platform: manifest.platform,
    analyzerName: manifest.analyzerName,
    kbOnly: manifest.kbOnly,
    sourcesHash: manifest.sourcesHash,
    payloadKey,
    createdAt: now,
    updatedAt: now,
  };
  await env.JOBS.put(jobId, JSON.stringify(row));

  // The workflow needs a URL it can curl. R2 supports signed URLs via the S3
  // API; for the sketch we route it through this worker so we don't need to
  // wire signing yet.
  const payloadUrl = `${env.CALLBACK_BASE}/artifacts/${encodeURIComponent(payloadKey)}`;
  // Local-dev escape hatch: with no GH_TOKEN configured we still accept and
  // persist the job, but skip workflow_dispatch. Lets the extension end of
  // the pipeline be exercised without burning real CI minutes.
  if (env.GH_TOKEN) {
    await dispatchWorkflow(env, {
      jobId,
      payloadUrl,
      engineVersion: manifest.engineVersion,
      platform: manifest.platform,
      analyzerName: manifest.analyzerName,
      kbOnly: manifest.kbOnly,
      callbackUrl: `${env.CALLBACK_BASE}/callback/${jobId}`,
    });
  } else {
    console.warn(`POST /build: GH_TOKEN empty, skipping workflow_dispatch for jobId=${jobId}`);
  }

  return json({ jobId, cached: false }, 202);
}

// ---------------------------------------------------------------------------
// GET /jobs/:id  — extension polls this until status === "done" | "failed".
// ---------------------------------------------------------------------------
async function handleGetJob(id: string, env: Env): Promise<Response> {
  const raw = await env.JOBS.get(id);
  if (!raw) return new Response("not found", { status: 404 });
  const row = JSON.parse(raw) as JobRow;
  return json({
    jobId: row.id,
    status: row.status,
    artifactUrl: row.artifactKey
      ? `${env.CALLBACK_BASE}/artifacts/${encodeURIComponent(row.artifactKey)}`
      : undefined,
    artifactSha256: row.artifactSha256,
    buildLogUrl: row.buildLogKey
      ? `${env.CALLBACK_BASE}/artifacts/${encodeURIComponent(row.buildLogKey)}`
      : undefined,
    errors: row.errors,
  });
}

// ---------------------------------------------------------------------------
// GET /artifacts/:key  — proxy R2 read. Production: swap for signed URLs.
// ---------------------------------------------------------------------------
async function handleGetArtifact(keyEnc: string, env: Env): Promise<Response> {
  const key = decodeURIComponent(keyEnc);
  const obj = await env.BLOBS.get(key);
  if (!obj) return new Response("not found", { status: 404 });
  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream",
      "etag": obj.httpEtag,
    },
  });
}

// ---------------------------------------------------------------------------
// PUT /jobs/:id/artifacts/:kind  — runner uploads lib / log / errors.
// ---------------------------------------------------------------------------
//
// Auth: bearer token shared between runners and dispatcher (env.JOB_TOKEN).
// Stores at deterministic key `artifacts/{jobId}/{kind}` so the callback
// step doesn't need to round-trip storage keys.
async function handlePutArtifact(
  id: string,
  kind: string,
  req: Request,
  env: Env,
): Promise<Response> {
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${env.JOB_TOKEN}`) {
    return new Response("unauthorized", { status: 401 });
  }
  if (!ARTIFACT_KINDS.includes(kind as ArtifactKind)) {
    return new Response("bad kind", { status: 400 });
  }
  if (!(await env.JOBS.get(id))) {
    return new Response("unknown job", { status: 404 });
  }
  if (!req.body) {
    return new Response("body required", { status: 400 });
  }

  const key = `artifacts/${id}/${kind}`;
  await env.BLOBS.put(key, req.body, {
    httpMetadata: { contentType: req.headers.get("content-type") ?? "application/octet-stream" },
  });
  return json({ key });
}

// ---------------------------------------------------------------------------
// POST /callback/:id  — workflow notifies us when a build finishes.
// ---------------------------------------------------------------------------
//
// Runner has already PUT lib/log/errors to deterministic keys under
// artifacts/{id}/{kind}. This callback just flips the status, inlines the
// parsed errors JSON if present, and promotes a successful build into cache.
async function handleCallback(id: string, req: Request, env: Env): Promise<Response> {
  const body = await req.json() as { status: "success" | "failure" | "cancelled" };
  const raw = await env.JOBS.get(id);
  if (!raw) return new Response("not found", { status: 404 });
  const row = JSON.parse(raw) as JobRow;

  row.status = body.status === "success" ? "done" : "failed";
  row.updatedAt = Date.now();

  const libKey = `artifacts/${id}/lib`;
  const logKey = `artifacts/${id}/log`;
  const errKey = `artifacts/${id}/errors`;

  if (await env.BLOBS.head(libKey)) row.artifactKey = libKey;
  if (await env.BLOBS.head(logKey)) row.buildLogKey = logKey;
  const errObj = await env.BLOBS.get(errKey);
  if (errObj) {
    try {
      row.errors = await errObj.json() as unknown[];
    } catch { /* leave undefined */ }
  }

  // On success, promote into the cache namespace so the next identical
  // request short-circuits in handleBuild.
  if (row.status === "done" && row.artifactKey) {
    const cacheKey = `cache/${row.platform}/${row.engineVersion}/${row.sourcesHash}/${row.kbOnly ? "kb" : "full"}`;
    const obj = await env.BLOBS.get(row.artifactKey);
    if (obj) await env.BLOBS.put(cacheKey, obj.body);
  }

  await env.JOBS.put(id, JSON.stringify(row));
  return new Response("ok");
}

// ---------------------------------------------------------------------------
// GitHub workflow_dispatch
// ---------------------------------------------------------------------------
async function dispatchWorkflow(
  env: Env,
  inputs: {
    jobId: string;
    payloadUrl: string;
    engineVersion: string;
    platform: string;
    analyzerName: string;
    kbOnly: boolean;
    callbackUrl: string;
  },
): Promise<void> {
  const url = `https://api.github.com/repos/${env.GH_REPO}/actions/workflows/compile-analyzer.yml/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "accept": "application/vnd.github+json",
      "authorization": `Bearer ${env.GH_TOKEN}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "nlp-compile-service",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      ref: "main",
      inputs: {
        jobId: inputs.jobId,
        payloadUrl: inputs.payloadUrl,
        engineVersion: inputs.engineVersion,
        platform: inputs.platform,
        analyzerName: inputs.analyzerName,
        kbOnly: String(inputs.kbOnly),
        callbackUrl: inputs.callbackUrl,
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`workflow_dispatch failed: ${res.status} ${await res.text()}`);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
