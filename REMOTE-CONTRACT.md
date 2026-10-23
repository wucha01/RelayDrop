# RelayDrop remote transport v1

This document specifies remote transport protocol v1. Protocol version and application version are separate.

This feature is optional and disabled until explicitly configured. No production relay is supplied or deployed. Local test brokers bind loopback only. File-pool devices must remain online. This transport does not provide cloud storage, offline delivery, public links, NAT traversal or WebRTC.

## Two separate TLS sessions

Every participant establishes an outbound TLS 1.2+ socket to a configured `tls://host:port` broker. Normal certificate-chain and hostname validation is mandatory unless the user explicitly configures the complete SHA-256 leaf-certificate pin. A configured pin is checked before sending any broker credential. Certificate validity is still checked. This is a TLS stream protocol, not an HTTP website or a generic HTTPS reverse proxy.

Inside that connection, the client establishes a second, independent TLS session with the original file-pool identity. The broker only forwards these encrypted bytes. Original device identity, full certificate pin and normal application pairing remain required. The intermediary sees connection metadata and traffic volumes but cannot decrypt file content. The file-pool host can read the stored files. Existing local files are not additionally encrypted at rest.

Client listeners bind only 127.0.0.1. They forward encrypted TLS unchanged, never plaintext HTTP or a local administrator session. File-pool hosts expose a separate loopback-only TLS listener for remote transport, with the same original identity and data store. Only this dedicated listener accepts the client's virtual `127.0.0.1:port` authority. Normal LAN Host/Origin validation stays unchanged. Remote requests reject the local host-administrator credential; remote clients use ordinary paired guest credentials.

## Broker handshake

Bounded UTF-8 newline-delimited JSON is used before switching to byte forwarding. All connection handshakes include `v:1`. Invalid input, unsupported fields where restricted, failed credentials and timeout fail closed. Credentials are 32 random bytes encoded as 43 unpadded base64url characters.

- Host: `{v:1,op:"host",room,serviceKey,hostKey,joinKey}`. The room is the file-pool server UUID. `serviceKey` authenticates an authorized host to the broker. `hostKey` identifies the room owner. `joinKey` grants tunnel access but does not grant access to file content. Success is `{ok:true}` and leaves a persistent control channel.
- Control: host sends `{op:"ping"}`, broker replies `{op:"pong"}`. Broker sends `{op:"open",id,ticket}` for a pending stream.
- Guest: `{v:1,op:"join",room,joinKey}`. Success is delayed until the host attaches.
- Host data channel: `{v:1,op:"attach",room,id,ticket}`. Ticket is random, single-use, session-bound and expires after 15 seconds. On successful matching both data sockets receive `{ok:true}` then carry opaque inner-TLS bytes with backpressure.
- Host disconnect/stop terminates its pending and active streams. Active streams are bounded and idle streams time out. No arbitrary forwarding destination is accepted from a broker or invitation: host agents connect only to their own dedicated loopback TLS endpoint.

The broker is not a trusted device-identity authority. A malicious broker cannot replace the expected file-pool certificate. Relay registration and file-pool pairing are separate. Users exchange the invitation through a trusted channel and compare the host's complete fingerprint before first connection. Regenerating the invitation rotates tunnel access; device revocation invalidates the separate file-pool credential.

## Invitation

`relaydrop-remote://v1/<base64url UTF-8 JSON>` with `{v:1,relay,relayFingerprint,room,joinKey,serverId,fingerprint}`. `relayFingerprint` is null for system trust, or the complete lowercase SHA-256 broker certificate pin. `room` equals `serverId`. `fingerprint` is the complete original file-pool certificate SHA-256. No serviceKey, hostKey, private key, administrator token or paired client credential is included. Invitations still contain a tunnel-access secret and should only be shared with the intended devices.

## Validation and release scope

Local tests cover authenticated host/guest/attach, certificate substitution, failure boundaries, file integrity, resume, device revocation and lifecycle cleanup. See docs/VERIFICATION.md for validation coverage and release checks. Single-computer tests do not establish reachability or performance across campus networks, mobile data or public relays. Each deployment requires validation on its intended networks and devices.
