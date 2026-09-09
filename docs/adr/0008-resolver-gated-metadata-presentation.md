# ADR 0008: Resolver-gated metadata presentation across clients

Date: 2026-09-09
Status: Accepted

## Context

The station feed is the authoritative source for the current Album, Track and
Artist fields, but those values are not always presentation-ready. In particular,
catalogue spelling such as `Crown, The: Season 2` must be displayed as
`The Crown: Season 2`. `/api/media` owns that normalization and returns it in the
independent `metadata: { album, track, artist }` object even when no screen work or
artwork is found.

Showing the raw station title before the resolver returns creates a visible title
flash at startup. It can also make the result depend on layout: landscape and
portrait artwork use separate caches and requests, but changing orientation must
not restore an already normalized title to its raw spelling.

The web player and the shared Windows engine need one presentation contract. Future
clients, including planned React Native mobile apps, must be able to implement the
same behavior without copying title-normalization rules into the client.

## Decision

Treat station metadata and display metadata as separate state:

- **Raw metadata** is the validated Album, Track and Artist from the station feed.
  It is resolver input and the last-resort display fallback.
- **Canonical metadata** is the validated `metadata` object returned by
  `/api/media`. It is the preferred display value and remains authoritative for the
  current track once accepted.
- **Artwork state** is independent. Landscape/portrait and HD/4K artwork may have
  separate cache entries, requests and retries without resetting display metadata.

Clients use the following handoff states:

| State | Information panel behavior |
| --- | --- |
| No current track | Hidden; no placeholder or stale raw title is shown. |
| Resolver pending, no accepted result | Keep the panel hidden. Outgoing content may remain only for its exit transition. Do not render the new raw title. |
| Valid canonical metadata available from cache, queue prefetch or `/api/media` | Format and reveal the canonical Album, Track and Artist. |
| Resolver settled without valid canonical metadata | Reveal the validated raw station fields as fallback. This includes endpoint HTTP/transport failure, timeout, invalid response and compatibility with an older endpoint that omits `metadata`. |
| Station ident, for which no media request is made | Display the validated station-ident fields directly; replace only the album marker `StationID` or `Station ID` with the selected station's display name. |

A provider miss is not itself a metadata failure. A normal `/api/media` response can
contain `media: null` and `backdrop: null` while still returning canonical metadata;
the client must display that metadata rather than fall back to raw values.

The information panel becomes visible only after the current track has reached one
of the two settled display states. At cold start this prevents any raw-title flash.
On a track change, outgoing content is kept until its exit fade completes, then the
new settled content fades in. The information-panel fade uses the same duration and
easing as the backdrop crossfade. Reduced-motion settings may remove these fades.

### Latency-free station-ident exception

Inserted jingles are not reliably announced in the queue, so clients cannot depend
on a prefetched resolver result when one starts. Resolving the jingle only after it
appears in current-playing would add a network round trip to a short-lived display.
Even a metadata-only server response would introduce this delay without providing
new information: the selected station's display name is already known locally.

Therefore, keep this narrowly scoped presentation rule in the clients: for an item
already classified as a station ident, replace the entire album marker `StationID`
or `Station ID` with the selected station's local display name. Match the marker
case-insensitively after trimming surrounding whitespace. Display it through the
normal UI transition without waiting for an API response or a jingle cache entry.

Keep raw metadata and track identity unchanged, preserve track/artist fields and
other album labels, and do not add a resolver or provider request for this label.
No new API parameter or explicit jingle-status field is needed. Existing ident
detection remains unchanged: a normal track with a trusted cover is not relabeled
merely because its album is named `StationID`.

This exception applies equally to web, the shared Windows engine and future mobile
clients. It substitutes a known station label for a technical placeholder; it does
not move metadata normalization back into clients. HTML entity decoding, article
rotation and soundtrack/provider-title cleanup remain server-owned for regular
tracks. Routing this label through `/api/media` was considered and rejected because
the extra display latency outweighs centralizing this small, deterministic rule.

## Cache and orientation rules

- Queue prefetch may populate canonical metadata before a track becomes current.
  A matching prefetched value may therefore be installed immediately at handoff.
- Metadata cache identity starts with the raw Album, Track and Artist plus the
  resolver cache version. A result from a different track must never be reused.
- Artwork cache identity additionally includes provider configuration and
  landscape/portrait orientation and HD/4K resolution class. These artwork dimensions do not make canonical
  metadata layout-specific.
- A same-track station poll may refresh duration and the raw fallback, but it must
  not overwrite accepted canonical metadata.
- An orientation or resolution-class change keeps the accepted title visible while the newly active
  artwork variant is loaded. It must neither re-hide the panel nor restore raw
  spelling.
- Landscape and portrait queue caches may both be retained for fast switching, but
  an entry is reusable only while its raw track identity still matches the
  corresponding current or queued item. After queue drift, the client discards or
  replaces the stale entry.
- A revalidation miss or failure must not erase an accepted canonical title. It may
  affect artwork and ratings according to their own retry/fallback rules.

## Concurrency rules

Every current-track handoff receives a generation or epoch. Resolver, prefetch and
orientation results may publish display metadata only when both their generation and
raw track identity still match the active track. Late results may fill their keyed
cache, but cannot alter the visible title, artist, artwork, tint or ratings.

Formatting is client-owned but normalization is not. Clients may combine canonical
Album and Track and append duration for display; they must not implement article
rotation, soundtrack mappings or provider-title cleanup locally.

## Consequences

The Windows implementation uses one retained `InfoPresentation` state machine under
the engine's publication lock. It keeps outgoing text through the exit fade, pending
text while resolution is incomplete, and an explicit canonical flag. A fallback-only
result cannot downgrade an accepted canonical value, even during manual retry or
artwork reconfiguration. The resolver marks that provenance only after validating
the entire metadata object; a partial object cannot mix canonical and raw fields.

- Startup can briefly show no information panel while the first resolver request is
  pending. This is intentional and preferable to displaying incorrect metadata.
- Resolver outages still leave a usable player: after the bounded request settles,
  validated station metadata is shown and normal retry policy continues in the
  background.
- Layout and orientation can change independently from title presentation.
- Jingle labels are independent of resolver latency and availability; their display
  does not require predicting or pre-caching the jingle itself.
- New web, Windows or React Native clients need the same small state machine, cache
  identities and stale-result guard, but no resolver-specific normalization code.
- Tests for every client must cover cold start, canonical success, provider miss with
  canonical metadata, endpoint failure fallback, same-track polling, queue-prefetch
  handoff, orientation change and stale-response rejection.
- Station-ident tests must cover each station's local display name, preservation of
  non-placeholder album/track/artist data and the absence of media requests for the
  label substitution.

## Relationship to earlier decisions

ADR 0001 defines `/api/media` and makes normalized metadata independent of artwork.
ADR 0002 defines the shared Windows resolver, cache and publication machinery. This
ADR defines how all clients turn those resolver results into visible metadata and is
the contract to use when adding React Native applications.
