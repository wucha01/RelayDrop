# RelayDrop implementation notes

This document describes the transport, authorization and storage contracts used by RelayDrop. It is not an exhaustive specification of the user interface. The source and tests define detailed limits. Build identities and commands are documented in README.md and docs/; validation coverage is described in docs/VERIFICATION.md. Shared folders, backup migration and native saved-file operations extend the base transfer protocol.

## Transport and trust

Production Node exposes TLS 1.2+ on the LAN port and a separate HTTP listener bound only to 127.0.0.1 for the native local UI. `await createSecureRelayServer(options)` constructs both, `listen()` returns the loopback port, and `securePort` returns the TLS port. Both listeners close together. CLI defaults PORT=8765, RELAY_HOST=0.0.0.0; RELAY_DATA selects persistent storage. The legacy synchronous `createRelayServer` is loopback-only for tests/development. Origin and Host must match the actual transport and listener port.

Node identity persists server UUID, RSA-3072 private key and SHA-256 self-signed certificate atomically; concurrent first creation cannot replace the winner. Existing corrupt or mismatched identity fails closed. Android server identity uses AndroidKeyStore. Public GET /api/identity returns {protocol:"relaydrop-tls-v1",serverId,certificateFingerprint,certificateExpiresAt}. Fingerprint is lowercase SHA-256 of the entire DER leaf certificate. No credential is required or exposed.

Android first probes without credentials, asks the user to compare full host fingerprint, then stores the confirmed serverId and fingerprint. Every authenticated native HTTPS request pins the actual certificate. An address change is accepted only after pin and identity verification. mDNS/NSD TXT version=2,tls=1,id,fp is an untrusted discovery hint, never authority to replace trust. Remote HTTP is rejected; only controlled local loopback UI may use HTTP. Legacy remote HTTP credentials must not be forwarded before establishing new trust.

Clients authenticate with existing random Bearer credentials inside TLS; this is pinned server identity plus paired client credentials, not mutual TLS. The file-pool host can read stored content. In optional remote mode, the inner TLS session runs from the client to that file-pool host; the separate forwarding broker cannot decrypt its content. State.security is {tlsEnabled,serverId,certificateFingerprint,certificateExpiresAt,transport:"tls"|"loopback"|"http"}; state.network.urls uses HTTPS in production.

## API and integrity

GET /api/health returns {ok:true,name:"RelayDrop",version:<application version>}. POST /api/pair accepts {code,name}; success returns {token,device}. Six-digit pairing codes expire and requests are rate limited. Host may POST /api/pairing/rotate and /api/devices/:id/revoke. Bearer credentials and host launch fragments must never be logged.

GET /api/state exposes only the caller's visible files, notes, tasks and public device metadata. Host id is "host". targetId=null means shared to paired devices. Targeted content is visible only to sender, recipient and host. Mutating/readback operations must recheck authorization after awaited body reads or decoding, so revocation in flight cannot grant a late write or disclosure.

POST /api/transfers {name,size,lastModified,fingerprint,targetId} requires fingerprint=entire original SHA-256, exactly 64 hex. Resume matches owner+name+size+fingerprint+target. GET /api/transfers/:id reports server offset. PUT accepts <=1 MiB with X-Offset and X-Chunk-SHA256; wrong offset=409, checksum=422. Updates serialize. Restart recovers actual partial file length.

POST /api/transfers/:id/complete checks exact size and full on-disk SHA before atomic publication. Repeated completion rechecks published bytes and returns the same file. Invalid full hash is 422 FILE_HASH_MISMATCH; never report success. DELETE transfer is sender/host only. Empty files work. Max original file size is 20 GiB subject to actual storage and platform limits.

POST /api/files/:id/ticket returns an expiring device/file-bound content URL. Revocation or deletion invalidates use. GET/HEAD content supports Range, strong SHA ETag, safe attachment filename and nosniff, streaming without whole-file allocation. No content ticket grants preview access.

POST /api/notes accepts text<=20000 chars, targetId, optional UUID clientId. Same sender+clientId+same content/target returns the original note; different content/target returns 409 CLIENT_ID_CONFLICT. Old callers without clientId remain valid. Notes render literally, never as HTML. DELETE notes is sender/host only.

All JSON errors contain error and code. Bodies, concurrency and cache sizes are bounded. Persist state atomically. Public static files use an allowlist; no arbitrary local file, credential or vendor directory serving.

## Organization and recycle bin

State schema remains version 1 for upgrades, adding private per-device preferences. Public file metadata includes category, previewKind, previewable, favorite:boolean and collection:string|null. Active state.files excludes deleted entries. state.trash includes deleted entries manageable by sender/host only. state.collections is the caller's private list, maximum100, each1..64 characters without controls. state.storage includes activeBytes,trashBytes,scope:"visible"|"host", host-only availableBytes where obtainable. state.capabilities advertises fileOrganization,trash,textPreview,richPreview.

PATCH /api/files/:id accepts a nonempty subset {favorite?,collection?}; reject unknown fields, wrong types and nonexistent collection. POST /api/collections {name} returns200; DELETE /api/collections/:name removes private classification only, never content. These choices never modify another device's preferences or content permissions.

DELETE /api/files/:id soft deletes, sender/host only. POST /api/files/:id/restore restores a trashed file. DELETE /api/files/:id/permanent requires an already trashed file and permanently deletes bytes/metadata. Deleted content, previews and tickets are inaccessible. Recycle-bin bytes still occupy storage. Restore preserves original bytes.

## Bounded previews

GET/HEAD /api/files/:id/preview requires Bearer authorization. Small thumbnails are JPEG<=320px maximum edge and<=300KiB, no-store/nosniff. Source limits are 32MiB for images, 128MiB for PDFs and 512MiB for video; complete SHA is verified, including cache hits. Raster images are limited to40M pixels. Detail/page previews have separate output limits and cache keys. Decoder support depends on the host. Unsupported/encrypted/malformed media fails safely while original remains downloadable.

Desktop decoding uses a disposable sandboxed WebContentsView with no Node or external network, exact local vendor allowlist, timeout12s and cancellation. PDF.js6.4.299 is local with eval/Wasm/network fetch disabled, print intent avoids hidden view frame waits. Android uses PdfRenderer and MediaMetadataRetriever. Preview cache<=8MiB/64 items; full source SHA is checked before decoding/cache lookup, then authorization and source metadata are rechecked after decoding. UI limits2 concurrent and48 retained object URLs, releases on logout/remove/close.

GET /api/files/:id/text: source<=256KiB, complete SHA and size checked. Decode strict UTF-8 or BOM UTF-16; reject invalid encoding/NUL. Return text/plain UTF-8<=768KiB. UI uses textContent, never Markdown/HTML execution. Optional original image view is user initiated,<=16MiB/40M pixels and full SHA before objectURL, with cancellation and release.

## Native clients

Desktop main accepts narrow IPC only from its exact trusted main frame. Renderer has no Node. External HTTP(S) links require an appropriate user action; credential/control-character URLs and unsafe protocols are blocked. File saves use streamed size/SHA validation, closed-file readback and exclusive final publication where no overwrite was requested. Batch1..200 unique file IDs chooses one folder; fixed-folder mode skips picker but still requires explicit save action. Same names get suffixes. Opening saved location accepts only a tracked completed request, not arbitrary renderer paths.

Close defaults to tray retention, persisted settings; actual exit confirms active tasks. Background throttling is disabled. Portable extraction directory is unique per launch. Installed mode is marked only by installer, supports optional login start and SendTo. SendTo arguments are validated once and passed via single-instance additionalData, never silently uploaded; native confirmation required, app/state/private-key files refused. Per-user NSIS creates shortcuts and SendTo, uninstall retains user data.

Android ACTION_SEND/ACTION_SEND_MULTIPLE handles explicit text or up to100 content URIs. Connection tokens are AndroidKeyStore AES-GCM protected. Native file picker entrance uses a narrow trusted-user-gesture relaydrop://choose-files URL, no general JavaScript bridge.

Foreground upload queue stages source to app-private storage and fsyncs, records SHA/size/job identity with AtomicFile, persists remote transfer ID. Reopening verifies staged SHA and resumes remote offset. Notes have persistent clientId. Pause/cancel interrupt IO; pause retains staged payload, cancel cleans it. Transient network failures retry with bounded backoff; identity failure blocks until user resolves trust, never auto accepts a new certificate. System force-stop needs user reopen; interrupted staging requires the source again. Background uploader is separate from foreground verified-save flow. Native saved copies require content length, strong SHA ETag, closed SAF stream and full readback before success.

Android Bluetooth remains a separate secure paired RFCOMM path with user confirmation and full original/receive/export SHA checks; no application resume. Windows OBEX is system-assisted and outside application integrity claims.

## Build and verification

Application version 1.9.3 uses Android versionCode 14. Development builds use separate application identities and temporary development signing. Runtime versions and vendor licenses are pinned. ASAR and APK assets must match their build inputs; packages exclude runtime data, signing keys and test assets. See docs/VERIFICATION.md for build checks and validation coverage. Physical-device and cross-network behavior require tests in the target environment.

## Optional remote transport

See REMOTE-CONTRACT.md for the authenticated TLS tunnel, dedicated loopback endpoint and invitation format. Remote connections are disabled until a reachable relay is configured. The transport does not provide cloud storage. Remote requests never accept the local host administrator credential.
