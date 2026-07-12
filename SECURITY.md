# Security

This project fetches data from a third-party radio station and renders remote
images, so the trust boundary is simple: **everything that comes back from the
network is untrusted** — the "now playing" JSON, the `CoverLink` URL inside it,
and the cover image bytes. The two threats worth defending against are a
**compromised/hostile station** and a **man-in-the-middle (MITM)** on the wire.

## Mitigated

| Risk | Mitigation | Where |
|------|-----------|-------|
| Cleartext MITM (Windows) | All requests go over **HTTPS:443 via WinHTTP**, with TLS certificate validation from the OS store | [`lib/http_client.cpp`](lib/http_client.cpp) |
| SSRF via `CoverLink` (e.g. `169.254.169.254`, LAN hosts) | `CoverLink` host is pinned to the configured station (exact host or a subdomain); everything else is rejected before any fetch | `isTrustedCoverUrl` in [`lib/coverfetch.cpp`](lib/coverfetch.cpp) |
| SSRF via **redirect** (a 3xx from the pinned host escaping the pin) | Redirects are **not followed** (`WINHTTP_OPTION_REDIRECT_POLICY_NEVER`); a 3xx is handed back as a failed fetch. The station's endpoints don't legitimately redirect | [`lib/http_client.cpp`](lib/http_client.cpp) |
| HTTP request injection via `CoverLink` (CRLF, control bytes) | Any control byte (`< 0x20` or `0x7F`) in the URL rejects it | `isTrustedCoverUrl` |
| Image decompression bomb (a valid image declaring e.g. `65500×65500` → multi-gigapixel decode on the UI thread) | The frame's header-reported size is checked **before** decode and anything over `4096`/axis is refused | `coverDimsOk` in [`shared/image_limits.h`](shared/image_limits.h), gated in [`shared/d2d_renderer.cpp`](shared/d2d_renderer.cpp) |
| Response-flood DoS (endless stream → `bad_alloc`) | Every response body is capped at **16 MB** | `kMaxResponseBytes` in [`lib/http_client.cpp`](lib/http_client.cpp) |
| Chunked-decode integer overflow (32-bit) → infinite re-scan / unbounded growth | Chunk size is clamped against the remaining bytes by subtraction, never `pos + size` | `dechunk` in [`lib/http_client.cpp`](lib/http_client.cpp) |

These are covered by unit tests in [`lib/tests/test_coverfetch.cpp`](lib/tests/test_coverfetch.cpp):
the CoverLink allow/deny cases, the oversized-chunk clamp, and the image size gate —
including a **crafted oversized cover** run through real WIC to prove the bomb is
rejected on its header before any pixels are decoded.

## Open items

These are known, accepted for now, and tracked to future work rather than fixed
in the current release.

### 1. Untrusted image decode (WIC codec vulnerability)

Cover bytes are handed to **WIC / Direct2D** to decode and display
([`shared/d2d_*.cpp`](shared/)). A malformed image that triggers a decoder
vulnerability is a theoretical code-execution vector. (The *resource-exhaustion*
side of this — a decompression bomb — is now mitigated by the pre-decode
dimension cap above; what remains here is a codec memory-safety bug.)

- **Why it's low risk today:** WIC is the OS image stack, patched through Windows
  Update; the input is size-capped (16 MB), now dimension-capped before decode,
  and never executed; and on Windows the fetch is HTTPS with certificate
  validation, so reaching the decoder with attacker-chosen bytes requires an
  actual **station compromise**, not a passive MITM.
- **Inherent:** displaying remote artwork means decoding remote bytes; this can't
  be fully eliminated, only contained.
- **Future:** revisit only if a stricter decode sandbox or a hardened/allowlisted
  codec becomes warranted.

### 2. Cleartext transport on non-Windows

The dependency-free **plain-socket path (HTTP:80)** is still used on non-Windows
platforms, because no TLS library is bundled there yet. On that path the request
(including the User-Agent) travels in cleartext and a MITM could tamper with the
feed; the `CoverLink` host allowlist, the size cap, and the `dechunk` overflow
guard remain the active defenses.

- **Scope:** Windows (the only shipping front-ends today) is unaffected — it uses
  WinHTTP/TLS.
- **Future:** route non-Windows through the platform-native TLS stacks the same
  way Windows uses WinHTTP — **iOS → NSURLSession**, **Android → OkHttp / Cronet**
  — at which point the cleartext path is retired.

## Reporting

This is a private repository; report suspected vulnerabilities to the maintainer
directly rather than opening a public issue.
