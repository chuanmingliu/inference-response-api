# Docker vLLM Metal artifact update

Checked and downloaded on **22 October 2026**. The newest published Docker Metal distribution is staged locally and verified. **The active Docker-managed inference engine remains the existing repaired 0.1.0 installation.** Downloading the distribution does not install it or upgrade Docker Desktop.

| Component | Observed version or state |
| --- | --- |
| Active Docker Desktop | 4.62.0 |
| Active Docker Model Runner CLI / embedded library | 1.0.12 / 1.0.18 |
| Active Docker-managed Metal distribution | `v0.1.0-20260126-121650`, with this project's compatibility repair |
| Downloaded Docker Metal distribution | `docker/model-runner:vllm-metal-v0.2.0-20260420-142150` |
| Downloaded platform | `darwin/arm64` |
| Download result | Complete; all selected content verified; not installed |
| Latest released Docker Model Runner checked | [1.2.9, released 22 October 2026](https://github.com/docker/model-runner/releases/tag/v1.2.9) |
| Latest released Docker Desktop checked | [4.96.2, released 22 October 2026](https://docs.docker.com/desktop/release-notes/#4962) |

The Docker distribution version and upstream vLLM Metal version are separate release tracks. The native Service B environment already uses upstream Metal 0.32.0. The latest available Docker artifact does not imply that it contains that upstream version. [Docker's release pin](https://github.com/docker/model-runner/blob/v1.2.9/pkg/inference/backends/vllm/vllm_metal.go) and [published tags](https://hub.docker.com/r/docker/model-runner/tags?name=vllm-metal) identify the April 0.2.0 distribution.

## Downloaded content

The artifact is a portable macOS Python environment packaged in OCI format. Docker's integration downloads its image, extracts it onto the Mac, and starts inference as a native host process to access Metal. [Docker architecture and installation explanation](https://www.docker.com/blog/docker-model-runner-vllm-metal-macos/)

The Linux Docker daemon rejected a normal `docker pull --platform darwin/arm64` with an unsupported operating-system error. The project therefore downloaded the same official registry artifact directly into an **OCI image layout**:

```text
.runtime/artifacts/vllm-metal-v0.2.0-20260420-142150/
  oci-layout
  index.json
  verification.json
  blobs/sha256/...
```

This layout selects the Darwin ARM64 image. Its original registry index is retained as a verified provenance blob; unrelated attestation manifests are not advertised as locally downloaded content. The image is not imported into Docker's Linux image store and will not appear as a newly installed runtime in `docker model status`.

| Verified item | Value |
| --- | --- |
| Registry index SHA-256 | `c00a5b99f4c688565b370efa9795e4239682add876ed9901f8df4b1241728eca` |
| Darwin ARM64 manifest SHA-256 | `ea55261a8d30d0a578643eff9f1638935ec8370b334a499aaa12916eef954a83` |
| Config SHA-256 | `d8bd5aec596f1bc4af8d0a9dcb3cb5e4c9eb4ed14756df82a1493d1dd3f3299a` |
| Compressed layer SHA-256 | `525d8d0c1c7e2a89d409a2e54c8a203ac12b266e351bbce9040e3d822c833578` |
| Compressed layer size | 382,894,603 bytes |
| Total verified index, manifest, config and layer content | 382,896,428 bytes |

The machine-readable [artifact record](docker-metal-artifact.json) contains the verification timestamp, platform, descriptors and local path. No layers were extracted, no package code was executed, and the active runtime directory was not changed.

## Reproduce or verify the download

From the project root:

```bash
python3 scripts/pull-dmr-metal-artifact.py
```

The script requires only Python's standard library. Its tag, registry-index digest and platform-manifest digest are pinned. It checks every selected config and layer blob against its SHA-256 digest and declared size, writes files atomically, and skips existing blobs only after verifying them again. Incomplete downloads can be retried with the same command; completed verified blobs are retained. Anonymous registry tokens are never logged and are removed from cross-host redirects.

An optional destination can be selected with `--output /absolute/path`; `--record /absolute/path.json` selects the verification record. The script downloads content only and has no extraction or installation mode.

## Compatible live upgrade path

The installed DMR 1.0.18 pins the January distribution and launches `python -m vllm_metal.server`. Its installer accepts its pinned version or a development marker and otherwise replaces the runtime directory. [Installed-version backend source](https://github.com/docker/model-runner/blob/v1.0.18/pkg/inference/backends/vllmmetal/vllmmetal.go)

The April distribution no longer includes `vllm_metal/server.py`. DMR 1.2.9 launches `python -m vllm.entrypoints.openai.api_server` instead and pins the April artifact. Replacing only the files behind the old daemon would therefore introduce an entrypoint mismatch and can be undone by the old daemon's version check. [Current backend source](https://github.com/docker/model-runner/blob/v1.2.9/pkg/inference/backends/vllm/vllm_metal.go), [Metal 0.2.0 source](https://github.com/vllm-project/vllm-metal/tree/v0.2.0-20260420-142150)

For a supported live upgrade:

1. Preserve the current runtime and project configuration for rollback, and arrange a Docker Desktop maintenance window because its restart affects other containers on this Mac.
2. Update Docker Desktop to a compatible current release, then use its backend installation command: `docker model install-runner --backend vllm`.
3. Verify the actual `docker model status` result and inspect the installed package versions. The release published on the website may roll out to the installed app later.
4. Reapply the model's 32,768-token context configuration and run Chat Completions, Responses gateway, streaming, model-alias and long-context checks. Check prefix reuse against actual cached-token counters and repeat-prompt timings before declaring it supported.
5. Apply only compatibility changes validated for the new runtime. The existing `repair-dmr-entrypoint.py` deliberately refuses anything except the January package and must not be forced onto the new package.

These installation steps have **not** been performed. The staged artifact satisfies the image-download request while the deployed Service A remains operational on its recorded runtime. The native vLLM and SGLang services are unaffected by this download.
