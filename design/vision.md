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

We don't want more apps that each hoard their own data. We want a **shared
data layer** — a local-first system that:

1. **Captures** events from your devices (screenshots, photos, notes, bookmarks, etc.)
2. **Logs** every action into an append-only event log
3. **Syncs** blobs to S3-compatible storage and documents to git
4. **Indexes** content for query across all types
5. **Publishes** views (web pages, galleries, feeds) from that same data

Apps still do real work — you still need a photo editor, a text editor, a
calendar. We don't modify those apps or ask them to cooperate. Instead, a
**daemon watches the filesystem** (and OS-level APIs like media managers)
for changes in directories we care about. When an app saves a photo or you
edit a markdown file, the daemon detects it and updates the event log
automatically. The data layer **unifies app outputs after the fact** — you
can combine, search, and publish across everything without import/export
gymnastics, and the apps never know we're there.

The primary interface to this data layer is an **agent**. Rather than
learning a CLI or building a custom UI, you describe what you want in
natural language — "make a gallery from last week's trip photos" — and the
agent handles the low-level calls: querying events, assembling markdown,
rendering HTML, publishing to S3. The agent is the app layer for most
interactions. The CLI and API exist so the agent (and power users) have
something solid to call.

At the end of the day, this is a **smart sync system with a static site
generator built in** — or more precisely, an asset manager that can feed
tools like Zola, but whose primary frontend is conversational.

---

## Principles

1. **Local-first.** The event log and content live on your device. The network
   is for sync and publish, not for operation. Everything works offline.

2. **Events, not files.** The atomic unit is an event — a timestamped,
   content-addressed record of something that happened. Files are payloads
   attached to events.

3. **Content-addressable.** Every blob gets a hash. References in markdown use
   a custom URI scheme (`smgr://sha256:abc123`) that resolves to local or
   remote paths at render time. No broken links when you move things around.

4. **Commodity storage.** S3 for blobs, git for documents. No proprietary sync
   protocol. You own your storage.

5. **Sync is not backup.** Sync means "this content is available in both
   places and stays in agreement." Backup is a separate concern — don't
   conflate them.

6. **Agent-first.** The primary way people interact with the data layer is
   through an AI agent that has access to the API/CLI. The API must be
   designed for agent consumption: consistent, well-typed, discoverable.
   Power users can use the CLI directly; everyone else talks to the agent.

7. **Composable content types.** Notes, photos, bookmarks, calendar entries —
   they all go through the same pipeline. New types are cheap to add because
   the primitives (event, sync, render) are shared.

---

## Who Is This For (v0)

Developers and power users who:
- Manage content across macOS / Android / web
- Want their data in formats they control (markdown, standard image formats)
- Are comfortable with a CLI and config files
- Want to publish without deploying a full CMS

---

## What Success Looks Like (v0)

1. I take a screenshot on my Mac. Within seconds, an event is logged and the
   image is synced to my S3 bucket.

2. I write a markdown note in my editor. It's committed to git automatically.
   The event log records the creation.

3. I open a CLI and query: "show me all photos tagged `travel` from last
   month." I get results with local paths and S3 URLs.

4. I run a command to publish a gallery. A static page is generated with links
   to S3-hosted images. I share the URL.

5. I open a web app on my phone. It shows the same index, lets me add a quick
   note, and syncs when I'm back online.

6. I tell an agent: "Put together a gallery from the photos I took in Paris
   last week, add captions, and publish it." The agent queries my event
   stream, selects photos, generates a markdown file with frontmatter
   (`type: gallery`), renders it to HTML, uploads everything to S3, and
   gives me a private link. The whole interaction is conversational — I
   never touch the CLI.

---

## The Agent as Primary Interface

The most important "app" is not a GUI — it's an AI agent with access to
the data layer. The workflow:

1. **User describes intent** in natural language ("make a gallery",
   "find all my bookmarks about Rust", "publish yesterday's notes as a blog post")
2. **Agent reads the event stream** via the query API to understand what
   data exists
3. **Agent generates markdown** with appropriate frontmatter and
   content-addressed `smgr://` references
4. **Agent calls the render/publish pipeline** to produce HTML and upload to S3
5. **Agent returns the result** — a link, a preview, a summary

This means the API and CLI must be designed as **agent tools**:
- Consistent, predictable output (JSON by default)
- Rich enough that an agent can complete tasks without ambiguity
- Composable operations (query → create → render → publish)

For Claude specifically, this looks like an MCP server or a Claude Code
skill that exposes the `smgr` CLI as tool calls. The agent gets access to
`smgr ls`, `smgr add`, `smgr publish`, `smgr resolve` — and that's enough
to build galleries, blogs, feeds, and anything else from natural language.
