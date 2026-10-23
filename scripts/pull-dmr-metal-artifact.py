#!/usr/bin/env python3
"""Pull Docker's macOS Metal distribution as a verified, unpacked OCI layout.

The Linux Docker daemon cannot import a darwin image. This downloader only
stages registry content; it never extracts layers or changes an installation.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shutil
import time
import urllib.error
import urllib.parse
import urllib.request


REPOSITORY = "docker/model-runner"
TAG = "vllm-metal-v0.2.0-20260420-142150"
INDEX_DIGEST = "sha256:c00a5b99f4c688565b370efa9795e4239682add876ed9901f8df4b1241728eca"
MANIFEST_DIGEST = "sha256:ea55261a8d30d0a578643eff9f1638935ec8370b334a499aaa12916eef954a83"
REGISTRY = "https://registry-1.docker.io"
ACCEPT = ", ".join([
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
])
ROOT = Path(__file__).resolve().parent.parent


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    """Registry blob redirects must not forward bearer tokens to a CDN."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urllib.parse.urlsplit(newurl).scheme != "https":
            raise RuntimeError("Refusing a non-HTTPS registry redirect")
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected is not None and urllib.parse.urlsplit(req.full_url).netloc != urllib.parse.urlsplit(newurl).netloc:
            redirected.remove_header("Authorization")
        return redirected


def digest_bytes(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def valid_blob(path, digest, size):
    if not path.is_file() or path.stat().st_size != size:
        return False
    hasher = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(chunk)
    return "sha256:" + hasher.hexdigest() == digest


def blob_path(directory, digest):
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", digest):
        raise ValueError("Unsupported or invalid registry digest")
    return directory / "blobs" / "sha256" / digest.split(":", 1)[1]


def atomic_write(path, data):
    temporary = path.with_name(path.name + ".part")
    temporary.write_bytes(data)
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / ".runtime" / "artifacts" / TAG)
    parser.add_argument("--record", type=Path, default=ROOT / "docs" / "docker-metal-artifact.json")
    args = parser.parse_args()
    directory = args.output.expanduser().resolve()
    (directory / "blobs" / "sha256").mkdir(parents=True, exist_ok=True)
    opener = urllib.request.build_opener(SafeRedirect())
    token = None

    def request(url):
        nonlocal token
        headers = {"Accept": ACCEPT, "User-Agent": "responsible-api-oci-pull/1"}
        if urllib.parse.urlsplit(url).netloc == "registry-1.docker.io":
            if token is None:
                query = urllib.parse.urlencode({"service": "registry.docker.io", "scope": f"repository:{REPOSITORY}:pull"})
                with opener.open("https://auth.docker.io/token?" + query, timeout=30) as response:
                    token = json.load(response)["token"]
            headers["Authorization"] = "Bearer " + token
        return opener.open(urllib.request.Request(url, headers=headers), timeout=30)

    def read_manifest(reference, expected_digest, expected_size=None):
        url = f"{REGISTRY}/v2/{REPOSITORY}/manifests/{reference}"
        with request(url) as response:
            data = response.read(8 * 1024 * 1024 + 1)
        if len(data) > 8 * 1024 * 1024 or digest_bytes(data) != expected_digest:
            raise ValueError("Registry manifest failed its pinned SHA-256 check")
        if expected_size is not None and len(data) != expected_size:
            raise ValueError("Registry manifest failed its declared size check")
        value = json.loads(data)
        if value.get("schemaVersion") != 2:
            raise ValueError("Unsupported registry manifest schema")
        atomic_write(blob_path(directory, expected_digest), data)
        return value, len(data)

    print(f"Inspecting {REPOSITORY}:{TAG} (darwin/arm64)", flush=True)
    index, index_size = read_manifest(TAG, INDEX_DIGEST)
    selected = [item for item in index.get("manifests", []) if item.get("platform", {}).get("os") == "darwin" and item.get("platform", {}).get("architecture") == "arm64"]
    if len(selected) != 1 or selected[0]["digest"] != MANIFEST_DIGEST:
        raise ValueError("Registry index does not contain the pinned darwin/arm64 manifest")
    descriptor = selected[0]
    manifest, manifest_size = read_manifest(MANIFEST_DIGEST, MANIFEST_DIGEST, descriptor["size"])
    descriptors = [manifest["config"], *manifest["layers"]]
    for item in descriptors:
        blob_path(directory, item["digest"])
        if not isinstance(item["size"], int) or item["size"] < 0:
            raise ValueError("Invalid blob size")
    remaining = sum(item["size"] for item in descriptors if not valid_blob(blob_path(directory, item["digest"]), item["digest"], item["size"]))
    if shutil.disk_usage(directory).free < remaining + 64 * 1024 * 1024:
        raise RuntimeError("Insufficient free disk space for the verified artifact")

    for number, item in enumerate(descriptors, 1):
        target = blob_path(directory, item["digest"])
        label = f"Blob {number}/{len(descriptors)} {item['digest'][7:19]}"
        if valid_blob(target, item["digest"], item["size"]):
            print(f"{label}: verified existing ({item['size']} bytes)", flush=True)
            continue
        temporary = target.with_name(target.name + ".part")
        for attempt in range(1, 5):
            try:
                hasher = hashlib.sha256()
                received = 0
                last_progress = time.monotonic()
                print(f"{label}: downloading {item['size']} bytes (attempt {attempt})", flush=True)
                with request(f"{REGISTRY}/v2/{REPOSITORY}/blobs/{item['digest']}") as response, temporary.open("wb") as stream:
                    while chunk := response.read(1024 * 1024):
                        received += len(chunk)
                        if received > item["size"]:
                            raise ValueError("Blob exceeds its declared size")
                        stream.write(chunk)
                        hasher.update(chunk)
                        if time.monotonic() - last_progress >= 15:
                            print(f"{label}: {received}/{item['size']} bytes ({100 * received / max(item['size'], 1):.1f}%)", flush=True)
                            last_progress = time.monotonic()
                if received != item["size"] or "sha256:" + hasher.hexdigest() != item["digest"]:
                    raise ValueError("Downloaded blob failed SHA-256 or size verification")
                temporary.replace(target)
                print(f"{label}: verified ({received} bytes)", flush=True)
                break
            except (OSError, urllib.error.URLError) as error:
                temporary.unlink(missing_ok=True)
                # Do not print redirected, signed CDN URLs or authentication data.
                token = None
                if attempt == 4:
                    raise RuntimeError(f"Blob download failed after four attempts ({type(error).__name__})") from None
                print(f"{label}: transient network failure; retrying", flush=True)
                time.sleep(min(attempt * 2, 6))
            except Exception:
                temporary.unlink(missing_ok=True)
                raise

    # OCI layout root selects only the downloaded platform. The original
    # multi-platform index is retained as a verified provenance blob; its
    # unrelated attestation descriptors are not advertised as local content.
    layout_index = {"schemaVersion": 2, "mediaType": "application/vnd.oci.image.index.v1+json", "manifests": [{**descriptor, "annotations": {**descriptor.get("annotations", {}), "org.opencontainers.image.ref.name": f"{REPOSITORY}:{TAG}"}}]}
    atomic_write(directory / "oci-layout", b'{"imageLayoutVersion":"1.0.0"}\n')
    atomic_write(directory / "index.json", (json.dumps(layout_index, indent=2) + "\n").encode())
    config = json.loads(blob_path(directory, manifest["config"]["digest"]).read_bytes())
    if config.get("os") != "darwin" or config.get("architecture") != "arm64":
        raise ValueError("Image configuration platform does not match darwin/arm64")
    record = {
        "verified_at": datetime.now(timezone.utc).isoformat(),
        "status": "downloaded_verified_not_installed",
        "repository": REPOSITORY, "tag": TAG, "platform": "darwin/arm64",
        "source_index_digest": INDEX_DIGEST, "source_index_size": index_size,
        "manifest_digest": MANIFEST_DIGEST, "manifest_size": manifest_size,
        "config": manifest["config"], "layers": manifest["layers"],
        "downloaded_blob_count": len(descriptors) + 2,
        "downloaded_bytes": index_size + manifest_size + sum(item["size"] for item in descriptors),
        "oci_layout_path": str(directory),
        "verification": "SHA-256 and manifest-declared size verified for every selected config/layer blob; source index and platform manifest verified against pinned digests.",
        "live_installation_changed": False,
        "source_urls": [
            "https://hub.docker.com/r/docker/model-runner/tags?name=vllm-metal",
            "https://github.com/docker/model-runner/blob/v1.2.9/pkg/inference/backends/vllm/vllm_metal.go",
            "https://www.docker.com/blog/docker-model-runner-vllm-metal-macos/",
        ],
    }
    args.record.parent.mkdir(parents=True, exist_ok=True)
    atomic_write(args.record, (json.dumps(record, indent=2) + "\n").encode())
    atomic_write(directory / "verification.json", (json.dumps(record, indent=2) + "\n").encode())
    print(f"Verified OCI artifact saved: {directory}", flush=True)
    print("Layers were not extracted; no live installation was changed.", flush=True)


if __name__ == "__main__":
    try:
        main()
    except (urllib.error.URLError, OSError) as error:
        raise SystemExit(f"Artifact pull failed ({type(error).__name__}); verified blobs are retained for retry.") from None
