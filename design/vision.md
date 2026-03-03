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
2. **Logs** every action into an append-only event log
3. **Enriches** media with LLM-generated metadata at capture time — descriptions,
   tags, detected objects, context — turning dumb files into searchable knowledge
4. **Syncs** blobs to your own storage (S3-compatible, BYO)
5. **Indexes** enriched content for semantic query across all types
6. **Generates** content from that indexed knowledge — blog posts, galleries,
   project summaries — grounded in real data, not hallucination

Apps still do real work — you still need a camera, a photo editor, a text
editor. We don't modify those apps or ask them to cooperate. On Android, a
**ContentObserver watches MediaStore** for new photos and videos. When you
take a photo, the system detects it, logs the event, sends the media to an
LLM for enrichment, and stores the result. The data layer **unifies app
outputs after the fact** — you can combine, search, and publish across
everything without import/export gymnastics, and the apps never know we're
there.

The primary interface to this data layer is an **agent**. Rather than
learning a CLI or building a custom UI, you describe what you want in
natural language — "give me all my photos from the bed repair project" — and
the agent queries the enriched index and returns results. Then: "write a blog
post about it" — and the agent pulls those events in chronological order,
reads the LLM-generated descriptions, and produces a grounded narrative with
embedded images. The agent is the app layer for most interactions. The CLI
and query API exist so the agent (and power users) have something solid to
call.

At the end of the day, this is a **capture → enrich → index → query → generate
pipeline** where you bring your own storage, your own LLM, and your own
device. sitemgr is the orchestration layer, not the platform.

---

## Principles

1. **Mobile-first.** Photos get taken on phones, not desktops. The primary
   capture device is Android. Desktop and CLI support follow, but the core
   loop must work on a phone.

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

6. **Agent-first.** The primary way people interact with the data layer is
   through an AI agent that has access to the query interface. The query
   interface must be designed for agent consumption: consistent, well-typed,
   discoverable. Power users can use the CLI directly; everyone else talks
   to the agent.

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
- Want their data in formats they control (ndjson events, standard image formats)
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
   gluing, clamping, sanding, finishing. Each one gets enriched automatically.
   The LLM recognizes the ongoing project context across photos.

3. I ask the agent: "give me all my photos related to the bed repair project."
   The agent queries the enriched index and returns a chronological set of
   events with descriptions, tags, and blob URIs. Fast — it's an index lookup,
   not a full re-analysis.

4. I ask the agent: "write a blog post about the bed repair project." The agent
   pulls those events in order, reads the enriched descriptions, and generates
   a narrative with embedded images. The content is grounded in real data — it
   knows what each photo shows because the LLM described it at capture time.

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

## The Agent as Primary Interface

The most important "app" is not a GUI — it's an AI agent with access to
the query interface. The workflow:

1. **User describes intent** in natural language ("give me all my bed repair
   photos", "write a blog post about the deck project", "find all screenshots
   from last week")
2. **Agent translates to a structured query** and calls the query interface
3. **Agent receives enriched events** — each with LLM-generated descriptions,
   tags, and blob URIs
4. **Agent generates content** — blog posts, galleries, summaries — grounded
   in the enriched metadata, not hallucination
5. **Agent calls the publish pipeline** if needed — render HTML, upload to S3,
   return a shareable URL

This means the query interface must be designed as an **agent tool**:
- Consistent, predictable output (JSON)
- Rich enough that an agent can complete tasks without ambiguity
- Composable operations (query → generate → render → publish)

For Claude specifically, this looks like an MCP server or a Claude Code
skill that exposes the query interface as tool calls. The agent gets access
to `smgr query`, `smgr show`, `smgr publish`, `smgr resolve` — and that's
enough to build galleries, blogs, feeds, and anything else from natural
language.

The key insight: the agent is a **consumer** of the query interface, not the
query interface itself. The agent's job is to translate natural language into
the right query calls. The index does the retrieval. Clean separation.
