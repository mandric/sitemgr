# Design Decisions — Interview Notes

Captured 2026-03-04. These decisions refine and in some cases override the
original design docs (vision.md, architecture.md, interfaces.md).

---

## v0 Scope

**Photos only.** No video, audio, notes, bookmarks, documents, or galleries
in v0. All other content types come later.

**No publishing in v0.** The pipeline stops at capture → enrich → sync →
query. Rendering and `smgr publish` come in a later phase.

**Headless first.** Phase 1a is "done" when the CLI works end-to-end — no
UI required for the first milestone.

**v0 deliverables:** Rust CLI + OpenClaw skills integration. The desktop CLI
validates the full pipeline; OpenClaw makes it conversational.

---

## Build Order (Revised)

The original phasing started with Android. The revised order starts with
the desktop CLI because it validates the core pipeline without Android
complexity — and the core library can later be called from Android via
JNI/NDK.

| Phase | Deliverable | Description |
|-------|-------------|-------------|
| 1a    | Desktop CLI (Rust) | `smgr add`, `smgr enrich`, `smgr query`, `smgr show`, `smgr resolve`, `smgr sync push/pull`. Manual `smgr add <photo>` for desktop capture. |
| 1b    | OpenClaw integration | smgr CLI commands exposed as OpenClaw skills. Agent drives sync, enrichment, and queries via chat (WhatsApp, Telegram, etc.). |
| 1c    | Minimal Android app | Creates events + uploads photos to S3. Dumb sync agent — no enrichment, no chat, no query on-device. |
| 2     | Publishing + expand | `smgr render`, `smgr publish`, more content types, file system watcher daemon. |

---

## Android UX Model (Revised)

**Original design:** Background ContentObserver running as a foreground
service with persistent notification. Always-on event detection.

**Revised:** The always-on background service is dropped for v0. Modern
Android is hostile to background services (Doze, battery optimization, OEM
kill), and the user can't generate media content while sitemgr is
foregrounded. Instead:

### Chat-first via OpenClaw

The primary user interface is **OpenClaw** — an open-source personal AI
assistant framework (https://openclaw.ai/) that runs on the user's desktop
and is accessible via messaging apps (WhatsApp, Telegram, Discord, iMessage).

The smgr CLI commands are registered as OpenClaw skills. The user interacts
naturally:

```
User: "sync my photos from today"
Agent: Found 8 new photos on your phone. Syncing...
       ✓ 8/8 synced to S3. Enrich them?
User: "yes"
Agent: Enriching... ✓ 8/8 done.
User: "what did I photograph?"
Agent: [queries enriched metadata, returns summary]
```

**The agent drives the sync process.** Rather than automatic background
sync, the user (through the agent) decides when to pull photos, what to
enrich, and what to query. This gives full control over API costs and
processing.

### When a native Android app exists (Phase 1c+)

- **No background service.** App processes photos when opened.
- **Auto-detect + confirm batch.** On launch, scan MediaStore for new photos
  since last run. Show the batch to the user for confirmation before
  syncing/enriching.
- **In-app settings screen** for S3 credentials and Anthropic API key.
  Keys stored in Android Keystore / EncryptedSharedPreferences.
- **Events created on-device.** The Android app creates events in its local
  SQLite — events are never re-created by the desktop when pulling blobs.
  Events propagate between devices via the replication mechanism.

---

## Agent Layer

**OpenClaw IS the agent layer.** We don't build our own agent framework.
The smgr CLI is the skill layer; OpenClaw is the runtime that exposes those
skills to the user via chat.

- Single model to start (Claude) for both conversation and enrichment
- smgr CLI commands registered as OpenClaw skills
- The agent composes CLI calls to handle complex workflows
- The agent triggers sync, enrichment, and queries on demand

---

## Event Provenance

**Events are always created on the originating device.** If you take a photo
on your phone, the phone creates the `create` event. The desktop never
re-creates events for content it receives — it pulls the event data from the
originating device's database.

This is a hard rule. The desktop CLI only creates events for content added
locally (via `smgr add`).

---

## Replication (Open)

The mechanism for syncing events between devices is still being explored.
Constraints:

- Events are append-only with ULIDs — no conflicts possible
- Each device only writes its own events
- S3 is the sync point (user already has a bucket)
- The design doc's "S3 Database Export" model is the baseline

**Options under consideration:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| Snapshot export | Each device periodically uploads `events.db` to S3. Others download and ATTACH. | Zero dependencies, already designed, simple | Coarse-grained, full db transfer each time |
| Litestream | Streams SQLite WAL changes to S3 continuously. | Near-real-time, proven, efficient deltas | New dependency, one-writer-per-db (fine for us), need to understand WAL streaming |
| Dual-write | Write events to both local and remote db when remote is available. | Data always available from S3 | SQLite can't write directly to S3; needs a remote db or intermediary |
| cr-sqlite | CRDT-based SQLite merge. | Multi-writer merge | Likely overkill — we never have conflicts with append-only + per-device writes |

Decision deferred — v0 can work with just `smgr add` on desktop (no
cross-device sync needed yet). Cross-device sync becomes critical in Phase
1c when the Android app exists.

---

## Desktop Capture

**Manual first.** For v0, the user runs `smgr add <photo>` to add photos to
the event store. No file system watcher daemon.

File system watcher (using the `notify` crate) comes in a later phase.

---

## Enrichment

**Both modes supported:**

- `smgr add --enrich <file>` — add and immediately enrich (one-off)
- `smgr enrich --pending` — enrich all un-enriched items (batch catch-up)
- `smgr enrich <event_id>` — enrich a specific item

**Show estimated cost** when processing a batch, if feasible. Claude vision
API charges per-token regardless of subscription plan (~$0.01-0.05 per
photo depending on resolution).

---

## Technology

- **Language:** Rust wherever possible. Native APIs (Kotlin/Swift) only
  when required or when there's an important performance gain.
- **Config:** TOML (as designed)
- **Event store:** SQLite + FTS5
- **Starting point:** Greenfield — design docs are the only artifact
- **S3:** Bucket already provisioned and ready

---

## Summary of Changes from Original Design

| Area | Original | Revised |
|------|----------|---------|
| Build order | Android first | Desktop CLI first |
| Android UX | Background ContentObserver (foreground service) | Chat-first via OpenClaw; on-open batch processing when native app exists |
| Agent | Custom MCP server or Claude Code skill | OpenClaw with smgr skills |
| Phase 1a scope | Android capture + sync + basic UI | Desktop CLI (headless) + OpenClaw integration |
| Content types (v0) | Implicitly all | Photos only |
| Publishing (v0) | Implicitly included | Deferred to later phase |
| Sync trigger | Automatic (background service) | Agent-driven (user triggers via chat) |
| Desktop capture | FS watcher daemon | Manual `smgr add` |
