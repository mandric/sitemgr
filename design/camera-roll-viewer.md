# Camera Roll Viewer

Browse and search your camera roll through natural language — after
you've synced your photos to S3.

The assumption: you already back up or sync your camera roll to an S3
bucket (via iCloud-to-S3, Syncthing, rclone, or a custom script). smgr
watches that bucket, indexes what it finds, enriches photos with LLM
descriptions, and lets you query everything conversationally.

---

## Use Case

You sync your phone's camera roll to S3. Maybe you use an app that
auto-uploads, or you run a nightly rclone job. Either way, your photos
land in a bucket:

```
s3://my-photos/DCIM/2024/IMG_20240115_143207.jpg
s3://my-photos/DCIM/2024/IMG_20240115_091422.jpg
s3://my-photos/DCIM/2024/VID_20240114_201533.mp4
...
```

smgr watches the bucket, detects new files, computes content hashes for
deduplication, and auto-enriches photos with LLM-generated descriptions.
You then talk to your library via WhatsApp (or any chat interface).

---

## Pipeline

```
Camera Roll → S3 sync → smgr watch → enrich → index → query via chat
```

| Step | Who does it | What happens |
|------|------------|--------------|
| Camera roll → S3 | You (rclone, Syncthing, app) | Photos land in your bucket |
| S3 → event store | `smgr watch` (polls) or webhook | Detects new objects, creates events |
| Enrich | Auto (on detect) | LLM describes each photo |
| Index | Automatic | FTS index updated with descriptions |
| Query | You, via WhatsApp | Natural language → search → response |

---

## What You Can Ask

```
"show me my recent photos"
"what photos did I take this week?"
"show the last 20 photos"
"find that photo of the cracked bed frame"
"how many photos do I have?"
"show me videos from January"
```

The agent translates these to database queries (on Supabase) or smgr
CLI calls (local), fetches results, and summarizes them conversationally.

---

## How It Works (Supabase)

```
WhatsApp message
    │
    ▼
Supabase Edge Function
    ├── Claude interprets the request
    ├── Queries Postgres (events + enrichments)
    ├── Full-text search on LLM descriptions
    └── Responds via Twilio
```

No CLI subprocess. The Edge Function queries the database directly.
See `design/supabase-deploy.md` for the full architecture.

---

## Conversation Examples

### Browsing

```
User: show me my camera roll
Bot:  You have 1,247 photos and 83 videos synced.
      Here are your 20 most recent:

      1. Jan 15, 2:32 PM — Outdoor shot of a garden path
      2. Jan 15, 9:14 AM — Close-up of coffee on a desk
      3. Jan 14, 10:30 PM — Screenshot of a recipe
      ...

      Want details on any of these?
```

### Search

```
User: find photos of the kitchen remodel
Bot:  Found 8 photos matching "kitchen remodel":

      1. Dec 3 — Demolished cabinets, exposed plumbing
      2. Dec 5 — New countertop being installed
      3. Dec 8 — Finished kitchen with new backsplash
      ...
```

### Stats

```
User: how many photos do I have?
Bot:  Your library:
      - 1,247 photos
      - 83 videos
      - 1,180 enriched (67 pending)
      - Oldest: Mar 2023
      - Newest: today
```

---

## Components

| Component | Technology | Role |
|-----------|-----------|------|
| S3 watcher | `smgr watch` / webhook | Detects new media in bucket |
| Event store | Supabase Postgres | Immutable event log |
| Enrichment | Claude / GPT-4o / Gemini | Photo descriptions, tags, objects |
| Full-text search | Postgres tsvector + GIN | Search over enrichment text |
| Chat interface | Supabase Edge Function + Twilio | WhatsApp bot |
| Agent brain | Claude Sonnet | Natural language → structured query |

---

## Future Ideas

- **Local + offline mode (backlog)** — `smgr scan ~/Photos` to index a
  local directory without S3 or internet using SQLite + FTS5. The
  agent-first cloud experience (WhatsApp bot, Supabase) takes priority
  for v1.

- **BYO S3 storage (backlog)** — Support any S3-compatible provider,
  not just Supabase Storage.

- **Enrichment metadata in S3** — Store enrichment results as sidecar
  JSON files alongside media in S3, making metadata portable.

- **Gallery view** — `smgr view` serving a local HTML gallery with
  thumbnails. Useful for browsing without chat.

- **Signed URL previews** — When you ask about a photo in WhatsApp,
  the bot sends the actual image (via Supabase Storage signed URL or
  S3 presigned URL) instead of just a text description.

- **Multi-device** — Track which device each photo came from via
  `device_id`. Query "photos from my phone" vs "photos from my tablet."

- **Smart albums** — Auto-group photos by location, date range, or
  content similarity using enrichment data.
