# Vision

## Working Title: sitemgr

### Name Candidates

The system needs a short, memorable name. Some directions:

| Name       | Rationale                                                  |
|------------|------------------------------------------------------------|
| **Basis**  | The foundation layer all your data sits on                 |
| **Logbook**| Everything is an entry in a log — events, not files        |
| **Trunk**  | The main trunk; branches are apps/views                    |
| **Relay**  | Captures and relays data between devices and storage       |
| **Manifest**| A ship's cargo list — every piece of data accounted for   |
| **Plinth** | The base a statue stands on — your data, your apps on top  |

For now we use **sitemgr** as the working title.

---

## Problem

Your data is scattered across apps that each maintain their own silo — photos
in one app, notes in another, bookmarks in a third, calendar in a fourth. You
can't search across them, combine them, or move them without losing context.
Sync is an afterthought, usually locked to a vendor's cloud. Publishing
(sharing a gallery, a note, a feed) requires yet another tool.

Worse: every photo you take is a dumb file. It has EXIF data — timestamps,
GPS coordinates, maybe a camera model — but nothing about what's *in* the
photo. You can't search your own camera roll for "that photo of the cracked
bed frame" because no system ever looked at the image and described it. The
metadata gap between what you captured and what you can find later is massive.

We don't want more apps that each hoard their own data. We want a **shared
data layer** — a mobile-first system that:

1. **Captures** events from your devices (photos, videos, screenshots, notes, etc.)
2. **Logs** every action into an append-only event store
3. **Enriches** media with LLM-generated metadata at capture time — descriptions,
   tags, detected objects, context — turning dumb files into searchable knowledge
4. **Syncs** blobs to your own storage (S3-compatible, BYO)
5. **Indexes** enriched content for semantic query across all types
6. **Generates** content from that indexed knowledge — blog posts, galleries,
   project summaries — grounded in real data, not hallucination

Apps still do real work — you still need a camera, a photo editor, a text
editor. We don't modify those apps or ask them to cooperate. Content enters
the system through explicit user action — `smgr add` on the CLI, or the
agent triggering sync on demand via chat. When you add a photo, the system
logs the event, sends the media to an LLM for enrichment, and stores the
result. The data layer **unifies app outputs after the fact** — you can
combine, search, and publish across everything without import/export
gymnastics.

The foundation is a **CLI** — a composable, scriptable interface that
exposes every operation in the system. `smgr query`, `smgr enrich`,
`smgr sync`, `smgr publish`. This is the primitive layer: explicit, debuggable,
pipeable. Power users and developers interact here directly. More importantly,
the CLI is the **skill layer that agents learn**. An AI agent doesn't need a
custom integration — it calls the same CLI commands a human would, reads the
same JSON output, and composes the same operations.

For most users, the primary interface is an **agent** that has access to
these CLI tools. You describe what you want in natural language — "give me all
my photos from the bed repair project" — and the agent queries the enriched
index and returns results. Then: "write a blog post about it" — and the agent
pulls those events in chronological order, reads the LLM-generated
descriptions, and produces a grounded narrative with embedded images. The
agent is the app layer for most interactions, but it's built on top of the
CLI — not instead of it.

At the end of the day, this is a **capture → enrich → index → query → generate
pipeline** where you bring your own storage, your own LLM, and your own
device. sitemgr is the orchestration layer, not the platform.

---

## Principles

1. **CLI-first, mobile eventually.** Photos get taken on phones, but the
   core pipeline (capture → enrich → sync → query) is validated on the
   desktop CLI first. The same Rust core library can later be called from
   Android via JNI/NDK.

2. **Events, not files.** The atomic unit is an event — a timestamped,
   content-addressed record of something that happened. Files are payloads
   attached to events.

3. **Enrich at capture.** Every piece of media gets sent to an LLM at capture
   time. The LLM returns structured metadata — descriptions, tags, detected
   objects, inferred context. This turns dumb files into queryable knowledge.
   Enrichment is async (don't block the user) and provider-agnostic (BYO LLM).

4. **Content-addressable.** Every blob gets a hash. References use a custom
   URI scheme (`smgr://sha256:abc123`) that resolves to local or remote paths
   at render time. No broken links when you move things around.

5. **BYO everything.** Bring your own storage (S3, R2, GCS, local disk).
   Bring your own LLM (Claude, GPT, Gemini, Ollama). Bring your own device.
   sitemgr is the orchestration layer — no accounts, no hosted service, no
   vendor lock-in. You own your data, your keys, your infra.

6. **CLI as skill layer, agent as interface.** The CLI is the foundational
   capability — every operation is a composable, scriptable command with
   structured output. The CLI is also the skill layer that agents learn:
   an AI agent calls the same commands a human would. The query interface
   must be designed for both human and agent consumption: consistent,
   well-typed, JSON by default. Most users will interact through an agent;
   the CLI ensures they don't have to.

7. **Composable content types.** Notes, photos, bookmarks, calendar entries —
   they all go through the same pipeline. New types are cheap to add because
   the primitives (event, enrich, sync, index, query) are shared.

8. **Sync is not backup.** Sync means "this content is available in both
   places and stays in agreement." Backup is a separate concern — don't
   conflate them.

---

## Who Is This For (v0)

Developers and power users who:
- Take photos on Android and want them enriched, indexed, and queryable
- Want their data in formats they control (SQLite events, standard image formats)
- Bring their own cloud storage (S3-compatible) and LLM API keys
- Want to go from "I have 50 photos of a project" to "here's a blog post
  about it" without manual curation

---

## What Success Looks Like (v0)

1. I take a photo of a cracked bed frame on my Android phone. Within seconds,
   an event is logged with the file metadata. In the background, the photo is
   sent to Claude, which returns: "Broken wooden bed frame, split along the
   side rail near the center support. Tags: bed-repair, woodworking,
   damage-assessment."

2. I take 10 more photos over the next week — buying lumber, cutting joints,
   gluing, clamping, sanding, finishing. Each one gets enriched independently
   at capture time. Photo 3 gets: "Close-up of a freshly cut mortise-and-tenon
   joint in pine." Photo 7 gets: "Wood clamp holding a glued rail to a bed
   frame." Each enrichment stands alone — no cross-photo context needed yet.

3. I ask the agent: "write a blog post about my bed repair that I've been
   working on the last few months." The agent queries the enriched index —
   searching descriptions, tags, and context fields — and finds 12 photos
   spanning two months. Because each photo already has a detailed description,
   the agent can see the full arc of the project without re-analyzing any
   images. It assembles the project context from the collection of enriched
   events at query time.

4. The agent generates a narrative with embedded images, ordered
   chronologically, grounded in the enrichment data. It knows what each photo
   shows because the LLM described it at capture time. The blog post writes
   itself from pre-existing metadata — fast and cheap, no additional LLM
   vision calls needed.

5. I publish the blog post. A static page is generated with links to
   S3-hosted images. I share the URL.

6. All of this works with my S3 bucket, my Claude API key, my phone. No
   accounts, no cloud service, no subscription. I swap Claude for Ollama
   and it still works — same pipeline, local enrichment.

---

## The Three BYO Contracts

sitemgr is orchestration, not platform. Everything pluggable hangs off three
provider interfaces:

### 1. Storage Provider
Put and get blobs. Content-addressed.

```
put(hash, bytes) → remote_path
get(hash) → bytes
exists(hash) → bool
delete(hash) → void
```

Implementations: S3, R2, GCS, local disk.

### 2. Enrichment Provider
Media in, structured metadata out.

```
enrich(media_bytes, mime_type) → EnrichmentResult {
    description: string
    objects: string[]
    context: string
    suggested_tags: string[]
    raw_response: string  // full LLM output for future re-processing
}
```

Implementations: Anthropic (Claude), OpenAI, Google (Gemini), Ollama (local).

### 3. Query Provider
Filter in, events out. Abstracts the index backend.

```
query(filter) → Event[]
```

Where filter supports: tags, content_type, date range, full-text search,
semantic search (if the backend supports it).

Implementations: SQLite + FTS5, Postgres, Tantivy, etc.

The agent, CLI, and any future UI are all **consumers** of the query provider.
The agent doesn't know about SQLite. The CLI doesn't know about SQLite. They
both call the query interface.

---

## The CLI as Skill Layer

The CLI (`smgr`) is the foundational interface. Every operation in the system
is a composable, scriptable command with structured JSON output. A developer
can pipe `smgr query` into `jq`, script a publishing workflow in bash, or
inspect enrichment results by hand. The CLI must be excellent on its own —
predictable, fast, well-documented.

The CLI is also the **skill layer that agents learn**. An AI agent doesn't
need a custom API integration — it calls `smgr query`, `smgr show`,
`smgr publish`, `smgr resolve`, and reads the same JSON a human would. The
agent composes the same operations. This is the key architectural insight:
build the CLI right, and agent access comes for free.

## The Agent as User Interface

For most users, the agent is the primary way they interact with sitemgr.
The workflow:

1. **User describes intent** in natural language ("give me all my bed repair
   photos", "write a blog post about the deck project", "find all screenshots
   from last week")
2. **Agent translates to CLI calls** — `smgr query --search "bed repair"
   --type photo --format json`
3. **Agent receives enriched events** — each with LLM-generated descriptions,
   tags, and blob URIs
4. **Agent generates content** — blog posts, galleries, summaries — grounded
   in the enriched metadata, not hallucination
5. **Agent calls the publish pipeline** — `smgr publish` renders HTML, uploads
   to S3, returns a shareable URL

The agent can also drive operations that go beyond simple queries: "regenerate
the enrichment data for all my photos from last week" or "re-enrich these
photos as a group with shared context." The agent calls `smgr enrich` with
the right flags — the CLI does the work.

The primary agent interface is **OpenClaw** — an open-source personal AI
assistant framework that runs on the user's desktop and is accessible via
messaging apps (WhatsApp, Telegram, Discord, iMessage). The smgr CLI
commands are registered as OpenClaw skills. The agent gets the full `smgr`
command set and composes it into workflows.

The key insight: the agent is a **consumer** of the CLI, not a replacement
for it. The CLI is the contract. The agent is one client. Power users are
another. Both use the same interface.
