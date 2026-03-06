# S3 Event-Driven Architecture

## The Core Assumption

Media sync to S3 is a solved problem — syncthing, rclone, s3drive, and
dozens of other tools handle it well. sitemgr doesn't own media capture
or sync.

**Assumption:** Media already lives in an S3-compatible bucket (Supabase
Storage for v1). sitemgr's job is to **watch, index, and enrich** — not
to move bytes around.

---

## Architecture

```
Phone / Camera                    Any S3-compatible bucket
┌──────────────┐    syncthing     ┌─────────────────────────┐
│  Camera roll  │───  rclone  ───▶│  photos/2024/           │
│              │    s3drive       │  photos/2025/           │
│              │    etc.          │  screenshots/           │
└──────────────┘                  └───────────┬─────────────┘
                                              │
                              ┌───────────────┼────────────────┐
                              │               │                │
                              ▼               ▼                ▼
                    ┌─────────────┐  ┌────────────────┐  ┌──────────┐
                    │ smgr watch  │  │ S3 Event       │  │ smgr     │
                    │ (polling)   │  │ Notification   │  │ webhook- │
                    │             │  │ → SNS/SQS      │  │ server   │
                    │ Poll every  │  │ → webhook      │  │          │
                    │ 30s, diff   │  │                │  │ Receives │
                    │ against     │  │ True event-    │  │ POST on  │
                    │ known keys  │  │ driven (v2)    │  │ new obj  │
                    └──────┬──────┘  └───────┬────────┘  └────┬─────┘
                           │                 │                │
                           └─────────────────┼────────────────┘
                                             ▼
                              ┌──────────────────────────┐
                              │  Event Store (Postgres)   │
                              │                          │
                              │  1. create event          │
                              │  2. enrich via LLM        │
                              │  3. index in tsvector     │
                              └──────────────┬───────────┘
                                             │
                              ┌──────────────┼──────────────┐
                              ▼              ▼              ▼
                        ┌──────────┐  ┌───────────┐  ┌───────────┐
                        │  CLI     │  │ OpenClaw  │  │ Future UI │
                        │ smgr     │  │ Agent     │  │           │
                        │ query    │  │ (WhatsApp │  │           │
                        │ smgr     │  │  bot)     │  │           │
                        │ show     │  │           │  │           │
                        └──────────┘  └───────────┘  └───────────┘
```

---

## Three Ways to Detect New Objects

### 1. Polling (`smgr watch`)

The simplest approach. Works with any S3-compatible provider.

```bash
# Run as a daemon
smgr watch

# Or one-shot (for cron)
smgr watch --once
```

**How it works:**
1. `ListObjectsV2` on the bucket/prefix
2. Diff against `watched_keys` table in Postgres
3. For each new key: download → hash → create event → enrich
4. Sleep, repeat

**Pros:** Universal, zero infrastructure, BYO-friendly.
**Cons:** Not instant (30s default delay), wastes API calls when quiet.

**Good for:** Getting started, small buckets, any S3-compatible provider.

### 2. S3 Event Notifications (push-based)

Configure your S3 bucket to send notifications on `s3:ObjectCreated:*`.

**AWS S3 → SNS → HTTP:**
```
S3 bucket
  → Event Notification (s3:ObjectCreated:*)
  → SNS Topic
  → HTTP subscription → smgr webhook-server
```

**MinIO webhook:**
```
mc event add myminio/photos arn:minio:sqs::1:webhook --event put
```

**Cloudflare R2:**
```
R2 bucket → Event Notification → Queue → worker → smgr webhook
```

### 3. Webhook Server (`smgr webhook-server`)

Receives push notifications from any of the above:

```bash
smgr webhook-server --port 8741
```

Accepts POST to `/webhook` with S3 event notification JSON.
Handles AWS S3, SNS-wrapped, MinIO, and simple `{"key": "..."}` formats.

**This is the recommended production setup.** Polling is for getting started;
webhooks are for when you want instant enrichment.

---

## Data Flow: New Photo Arrives

```
1. User takes photo on phone
2. Syncthing/rclone/s3drive syncs it to S3: photos/2025/03/IMG_1234.jpg
3. S3 event notification fires (or smgr watch polls and detects it)
4. smgr downloads the image bytes
5. Computes SHA-256 hash, checks for duplicates
6. INSERT create event into Postgres:
   { type: "create", content_type: "photo",
     content_hash: "sha256:...",
     remote_path: "s3://bucket/photos/2025/03/IMG_1234.jpg",
     metadata: { source: "s3-watch", s3_key: "...", size_bytes: 2450320 } }
7. Sends image to Claude vision API
8. INSERT enrich event into Postgres:
   { type: "enrich", parent_id: "...",
     metadata: { enrichment: {
       description: "Cracked wooden bed frame...",
       objects: ["bed frame", "wood", "crack"],
       suggested_tags: ["bed-repair", "woodworking"] } } }
9. tsvector index updated — now searchable
```

**Total latency from S3 arrival to searchable:** ~5-10 seconds (webhook)
or up to 30 seconds (polling).

---

## Data Flow: WhatsApp Query

```
1. User sends WhatsApp message: "show me photos from the bed repair"
2. Twilio webhook → bot.py
3. Claude interprets → structured query intent → Postgres query
4. tsvector searches enrichment descriptions, returns matching events
5. Claude summarizes results conversationally
6. Bot sends response via WhatsApp:
   "Found 8 photos of your bed repair project from January.
    The earliest shows the initial crack, then the gluing
    process, and the final result. Want me to share any of them?"
```

---

## OpenClaw Integration

The WhatsApp bot (`bot.py`) is a minimal OpenClaw agent. It follows the
same pattern:

1. **Receive** natural language message
2. **Plan** which smgr commands to run (via Claude)
3. **Execute** smgr commands (subprocess)
4. **Summarize** results (via Claude)
5. **Respond** in chat

The smgr CLI is the skill layer. The agent doesn't need special APIs —
it calls the same commands a human would. This means:

- Any new smgr feature is immediately available to the agent
- The agent can be tested by running `python3 bot.py --stdio`
- Switching from WhatsApp to Telegram/Discord only changes the transport

---

## Configuration

All via environment variables (12-factor friendly):

```bash
# S3 bucket (required)
export SMGR_S3_BUCKET=my-photos
export SMGR_S3_PREFIX=photos/         # optional prefix filter
export SMGR_S3_ENDPOINT=https://...   # for MinIO/R2
export SMGR_S3_REGION=us-east-1

# Enrichment
export SMGR_ENRICHMENT_PROVIDER=anthropic  # or openai
export ANTHROPIC_API_KEY=sk-...
export SMGR_AUTO_ENRICH=true

# Watcher
export SMGR_WATCH_INTERVAL=30  # seconds between polls

# WhatsApp bot
export TWILIO_ACCOUNT_SID=AC...
export TWILIO_AUTH_TOKEN=...
export TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
```

---

## Running the Prototype

```bash
cd prototype/
pip install -r requirements.txt

# 1. Initialize the database
python3 smgr.py init

# 2. Start watching S3 (pick one)
python3 smgr.py watch              # polling mode (runs forever)
python3 smgr.py watch --once       # poll once and exit
python3 smgr.py webhook-server     # push mode (receives S3 events)

# 3. Query your indexed media
python3 smgr.py query --format table
python3 smgr.py query --search "bed repair"
python3 smgr.py stats

# 4. Start the WhatsApp bot
python3 bot.py                     # WhatsApp webhook mode
python3 bot.py --stdio             # interactive testing mode

# 5. Manually enrich items
python3 smgr.py enrich --status
python3 smgr.py enrich --pending
```

---

## What This Replaces

The original architecture had sitemgr owning the full pipeline:
capture → event → blob sync → enrichment → query.

The current architecture splits responsibility:

| Concern | Old | v1 |
|---------|-----|-----|
| Media capture | sitemgr (Android app) | Phone camera (existing) |
| Media sync to S3 | sitemgr (blob sync) | syncthing/rclone/s3drive |
| Detect new media | FS watcher / Android MediaStore | S3 polling / event notifications |
| Event store | Per-device SQLite | Supabase Postgres (shared) |
| Full-text search | SQLite FTS5 | Postgres tsvector + GIN |
| Index + enrich | sitemgr | sitemgr |
| Query | sitemgr CLI | Supabase Edge Function (+ CLI) |
| Agent interface | OpenClaw (planned) | WhatsApp bot (Supabase Edge Function) |

sitemgr gets **simpler** by letting commodity tools handle sync and
focusing on what's actually unique: the enrichment + index + agent layer.

---

## Future: Beyond Polling

The polling approach works but has limits. The upgrade path:

1. **Now:** `smgr watch` (polling, works everywhere)
2. **Soon:** `smgr webhook-server` (push, needs S3 event config)
3. **Later:** Native SQS consumer (for AWS-heavy setups)
4. **Eventually:** CloudEvents / EventBridge integration

Each step is additive — polling keeps working, you just add faster paths.
