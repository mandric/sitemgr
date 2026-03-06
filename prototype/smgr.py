#!/usr/bin/env python3
"""
smgr prototype — S3-event-driven media indexer + enrichment pipeline.

Assumes media is already synced to an S3 bucket (via syncthing, rclone,
s3drive, etc). smgr watches the bucket for new objects, indexes them,
and enriches them via LLM.

Usage:
    python3 smgr.py init                        # Initialize the database
    python3 smgr.py scan <directory>             # Import local photos
    python3 smgr.py watch [--once]               # Watch S3 bucket for new objects
    python3 smgr.py enrich [--pending] [<id>]    # Enrich media via LLM
    python3 smgr.py query [--search Q] [...]     # Query events (with FTS)
    python3 smgr.py show <event_id>              # Show event details
    python3 smgr.py stats                        # Show database statistics
    python3 smgr.py webhook-server               # Start S3 event webhook listener

Environment:
    SMGR_S3_BUCKET          S3 bucket name (required for watch)
    SMGR_S3_PREFIX          S3 key prefix to watch (default: "")
    SMGR_S3_ENDPOINT        Custom S3 endpoint (for MinIO/R2)
    SMGR_S3_REGION          AWS region (default: us-east-1)
    SMGR_ENRICHMENT_PROVIDER  "anthropic" | "openai" | "gemini" (default: anthropic)
    ANTHROPIC_API_KEY       Anthropic API key (for enrichment)
    OPENAI_API_KEY          OpenAI API key (for enrichment)
    GEMINI_API_KEY          Google Gemini API key (for enrichment)
    SMGR_DEVICE_ID          Device identifier (default: prototype)
    SMGR_WATCH_INTERVAL     Poll interval in seconds (default: 30)
    SMGR_AUTO_ENRICH        Auto-enrich new objects (default: true)
"""

import argparse
import base64
import hashlib
import json
import mimetypes
import os
import signal
import sqlite3
import sys
import time
import uuid
from datetime import datetime, timezone
from typing import Optional

# --- Constants ---

DB_PATH = os.path.expanduser("~/.sitemgr/events.db")
DEVICE_ID = os.environ.get("SMGR_DEVICE_ID", "prototype")

MEDIA_EXTENSIONS = {
    ".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif",
    ".gif", ".bmp", ".tiff", ".tif",
    ".mp4", ".mov", ".avi", ".mkv", ".webm",
    ".mp3", ".wav", ".ogg", ".flac", ".m4a",
}

CONTENT_TYPE_MAP = {
    "image": "photo",
    "video": "video",
    "audio": "audio",
}

ENRICHMENT_PROMPT = """Analyze this image and return a JSON object with exactly these fields:
- "description": A detailed description of what you see (2-3 sentences)
- "objects": A list of notable objects, subjects, or elements
- "context": The likely activity or context (e.g., "furniture repair", "travel", "cooking")
- "suggested_tags": 3-5 short tags for categorization

Be specific and concrete. Describe what you actually see.
Return ONLY valid JSON, no markdown fences or extra text."""


# --- Database ---

SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    timestamp TEXT NOT NULL,
    device_id TEXT NOT NULL,
    type TEXT NOT NULL,
    content_type TEXT,
    content_hash TEXT,
    local_path TEXT,
    remote_path TEXT,
    metadata TEXT,  -- JSON
    parent_id TEXT,
    FOREIGN KEY (parent_id) REFERENCES events(id)
);

CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_content_type ON events(content_type);
CREATE INDEX IF NOT EXISTS idx_events_content_hash ON events(content_hash);
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
CREATE INDEX IF NOT EXISTS idx_events_device_id ON events(device_id);
CREATE INDEX IF NOT EXISTS idx_events_remote_path ON events(remote_path);

-- FTS5 for full-text search across enrichment data
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
    event_id,
    description,
    objects,
    context,
    tags,
    content='',
    tokenize='porter'
);

-- Track S3 objects we've already seen (avoids re-downloading)
CREATE TABLE IF NOT EXISTS watched_keys (
    s3_key TEXT PRIMARY KEY,
    first_seen TEXT NOT NULL,
    event_id TEXT,
    etag TEXT,
    size_bytes INTEGER,
    FOREIGN KEY (event_id) REFERENCES events(id)
);
"""


def get_db() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.row_factory = sqlite3.Row
    return conn


def init_db(conn: sqlite3.Connection):
    conn.executescript(SCHEMA)
    conn.commit()


# --- Helpers ---

def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return f"sha256:{h.hexdigest()}"


def sha256_bytes(data: bytes) -> str:
    return f"sha256:{hashlib.sha256(data).hexdigest()}"


def detect_content_type(path: str) -> str:
    mime, _ = mimetypes.guess_type(path)
    if mime:
        major = mime.split("/")[0]
        return CONTENT_TYPE_MAP.get(major, "file")
    return "file"


def detect_content_type_from_key(key: str) -> str:
    """Detect content type from an S3 key."""
    return detect_content_type(key)


def is_media_key(key: str) -> bool:
    """Check if an S3 key looks like a media file."""
    ext = os.path.splitext(key)[1].lower()
    return ext in MEDIA_EXTENSIONS


def new_event_id() -> str:
    return uuid.uuid4().hex[:26]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def file_metadata(path: str) -> dict:
    stat = os.stat(path)
    mime, _ = mimetypes.guess_type(path)
    meta = {
        "mime_type": mime or "application/octet-stream",
        "size_bytes": stat.st_size,
        "source": "local-scan",
    }
    if mime and mime.startswith("image/"):
        dims = _read_image_dimensions(path, mime)
        if dims:
            meta["dimensions"] = {"width": dims[0], "height": dims[1]}
    return meta


def s3_metadata(key: str, size: int, etag: str) -> dict:
    """Build metadata dict for an S3-sourced object."""
    mime, _ = mimetypes.guess_type(key)
    return {
        "mime_type": mime or "application/octet-stream",
        "size_bytes": size,
        "source": "s3-watch",
        "s3_key": key,
        "s3_etag": etag,
    }


def _read_image_dimensions(path: str, mime: str) -> Optional[tuple]:
    try:
        with open(path, "rb") as f:
            header = f.read(32)
            if header[:8] == b"\x89PNG\r\n\x1a\n":
                import struct
                w, h = struct.unpack(">II", header[16:24])
                return (w, h)
            if header[:2] == b"\xff\xd8":
                return _jpeg_dimensions(f)
    except Exception:
        pass
    return None


def _jpeg_dimensions(f) -> Optional[tuple]:
    import struct
    f.seek(2)
    while True:
        marker = f.read(2)
        if len(marker) < 2:
            return None
        if marker[0] != 0xFF:
            return None
        if marker[1] in range(0xC0, 0xD0) and marker[1] not in (0xC4, 0xC8, 0xCC):
            length_data = f.read(3)
            if len(length_data) < 3:
                return None
            hw = f.read(4)
            if len(hw) < 4:
                return None
            h, w = struct.unpack(">HH", hw)
            return (w, h)
        else:
            length_data = f.read(2)
            if len(length_data) < 2:
                return None
            length = struct.unpack(">H", length_data)[0]
            f.seek(length - 2, 1)


# --- S3 Client ---

def get_s3_client():
    """Create a boto3 S3 client from environment config."""
    import boto3

    kwargs = {}
    endpoint = os.environ.get("SMGR_S3_ENDPOINT")
    region = os.environ.get("SMGR_S3_REGION", "us-east-1")

    if endpoint:
        kwargs["endpoint_url"] = endpoint
    kwargs["region_name"] = region

    return boto3.client("s3", **kwargs)


def list_s3_objects(s3, bucket: str, prefix: str = "") -> list[dict]:
    """List all objects in an S3 bucket/prefix. Handles pagination."""
    objects = []
    continuation_token = None

    while True:
        kwargs = {"Bucket": bucket, "MaxKeys": 1000}
        if prefix:
            kwargs["Prefix"] = prefix
        if continuation_token:
            kwargs["ContinuationToken"] = continuation_token

        response = s3.list_objects_v2(**kwargs)

        for obj in response.get("Contents", []):
            objects.append({
                "key": obj["Key"],
                "size": obj["Size"],
                "etag": obj["ETag"].strip('"'),
                "last_modified": obj["LastModified"].isoformat(),
            })

        if response.get("IsTruncated"):
            continuation_token = response["NextContinuationToken"]
        else:
            break

    return objects


def download_s3_object(s3, bucket: str, key: str) -> bytes:
    """Download an S3 object and return its bytes."""
    response = s3.get_object(Bucket=bucket, Key=key)
    return response["Body"].read()


# --- Enrichment ---

def enrich_image_anthropic(image_bytes: bytes, mime_type: str) -> dict:
    """Enrich an image using Claude's vision API."""
    import anthropic

    client = anthropic.Anthropic()
    b64 = base64.b64encode(image_bytes).decode("utf-8")

    # Map common mime types to what Claude accepts
    media_type = mime_type
    if media_type == "image/jpg":
        media_type = "image/jpeg"

    response = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=1024,
        messages=[{
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": media_type,
                        "data": b64,
                    },
                },
                {
                    "type": "text",
                    "text": ENRICHMENT_PROMPT,
                },
            ],
        }],
    )

    raw_response = response.content[0].text

    # Parse JSON from response (handle potential markdown fences)
    text = raw_response.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1]
        text = text.rsplit("```", 1)[0]

    result = json.loads(text)
    result["provider"] = "anthropic"
    result["model"] = "claude-haiku-4-5-20251001"
    result["raw_response"] = raw_response

    return result


def enrich_image_openai(image_bytes: bytes, mime_type: str) -> dict:
    """Enrich an image using OpenAI's vision API."""
    import openai

    client = openai.OpenAI()
    b64 = base64.b64encode(image_bytes).decode("utf-8")
    data_url = f"data:{mime_type};base64,{b64}"

    response = client.chat.completions.create(
        model="gpt-4o",
        max_tokens=1024,
        messages=[{
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": data_url}},
                {"type": "text", "text": ENRICHMENT_PROMPT},
            ],
        }],
    )

    raw_response = response.choices[0].message.content
    text = raw_response.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1]
        text = text.rsplit("```", 1)[0]

    result = json.loads(text)
    result["provider"] = "openai"
    result["model"] = "gpt-4o"
    result["raw_response"] = raw_response

    return result


def enrich_image_gemini(image_bytes: bytes, mime_type: str) -> dict:
    """Enrich an image using Google Gemini Flash (free tier available)."""
    import openai

    client = openai.OpenAI(
        base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
        api_key=os.environ["GEMINI_API_KEY"],
    )
    b64 = base64.b64encode(image_bytes).decode("utf-8")
    data_url = f"data:{mime_type};base64,{b64}"

    response = client.chat.completions.create(
        model="gemini-2.0-flash",
        max_tokens=1024,
        messages=[{
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": data_url}},
                {"type": "text", "text": ENRICHMENT_PROMPT},
            ],
        }],
    )

    raw_response = response.choices[0].message.content
    text = raw_response.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1]
        text = text.rsplit("```", 1)[0]

    result = json.loads(text)
    result["provider"] = "gemini"
    result["model"] = "gemini-2.0-flash"
    result["raw_response"] = raw_response

    return result


def enrich_image(image_bytes: bytes, mime_type: str) -> dict:
    """Enrich an image using the configured provider."""
    provider = os.environ.get("SMGR_ENRICHMENT_PROVIDER", "anthropic")
    if provider == "openai":
        return enrich_image_openai(image_bytes, mime_type)
    if provider == "gemini":
        return enrich_image_gemini(image_bytes, mime_type)
    return enrich_image_anthropic(image_bytes, mime_type)


def do_enrich(conn: sqlite3.Connection, event_id: str, image_bytes: bytes, mime_type: str) -> Optional[str]:
    """Run enrichment for a single event. Returns enrich event ID or None on failure."""
    try:
        result = enrich_image(image_bytes, mime_type)
        enrich_id = new_event_id()

        # Get the parent event's content_hash and content_type
        parent = conn.execute(
            "SELECT content_hash, content_type FROM events WHERE id = ?", (event_id,)
        ).fetchone()

        conn.execute(
            "INSERT INTO events (id, timestamp, device_id, type, content_type, content_hash, metadata, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (enrich_id, now_iso(), DEVICE_ID, "enrich", parent["content_type"], parent["content_hash"],
             json.dumps({"source": "enrichment", "enrichment": result}), event_id),
        )

        # Update FTS index
        conn.execute(
            "INSERT INTO fts (event_id, description, objects, context, tags) VALUES (?, ?, ?, ?, ?)",
            (event_id,
             result.get("description", ""),
             " ".join(result.get("objects", [])),
             result.get("context", ""),
             " ".join(result.get("suggested_tags", []))),
        )

        conn.commit()
        return enrich_id

    except Exception as e:
        # Record enrichment failure
        fail_id = new_event_id()
        parent = conn.execute(
            "SELECT content_hash, content_type FROM events WHERE id = ?", (event_id,)
        ).fetchone()

        conn.execute(
            "INSERT INTO events (id, timestamp, device_id, type, content_type, content_hash, metadata, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (fail_id, now_iso(), DEVICE_ID, "enrich_failed",
             parent["content_type"] if parent else None,
             parent["content_hash"] if parent else None,
             json.dumps({"source": "enrichment", "error": str(e), "provider": os.environ.get("SMGR_ENRICHMENT_PROVIDER", "anthropic")}),
             event_id),
        )
        conn.commit()
        print(f"  Enrichment failed for {event_id}: {e}", file=sys.stderr)
        return None


# --- Commands ---

def cmd_init(_args):
    conn = get_db()
    init_db(conn)
    conn.close()
    print(f"Initialized database at {DB_PATH}")


def cmd_scan(args):
    directory = os.path.expanduser(args.directory)
    if not os.path.isdir(directory):
        print(f"Error: {directory} is not a directory", file=sys.stderr)
        sys.exit(1)

    conn = get_db()
    init_db(conn)

    existing = set()
    for row in conn.execute("SELECT content_hash FROM events WHERE type = 'create' AND content_hash IS NOT NULL"):
        existing.add(row["content_hash"])

    found = 0
    created = 0
    skipped = 0

    for root, _dirs, files in os.walk(directory):
        for name in sorted(files):
            ext = os.path.splitext(name)[1].lower()
            if ext not in MEDIA_EXTENSIONS:
                continue

            found += 1
            filepath = os.path.join(root, name)
            content_hash = sha256_file(filepath)

            if content_hash in existing:
                skipped += 1
                continue

            content_type = detect_content_type(filepath)
            meta = file_metadata(filepath)
            event_id = new_event_id()

            conn.execute(
                "INSERT INTO events (id, timestamp, device_id, type, content_type, content_hash, local_path, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (event_id, now_iso(), DEVICE_ID, "create", content_type, content_hash, filepath, json.dumps(meta)),
            )
            existing.add(content_hash)
            created += 1

    conn.commit()
    conn.close()

    print(f"Scanning {directory}...")
    print(f"Found {found} media files, {created} new, {skipped} already imported.")


def cmd_watch(args):
    """Watch an S3 bucket for new media objects. Poll-based with checkpoint."""
    bucket = os.environ.get("SMGR_S3_BUCKET")
    if not bucket:
        print("Error: SMGR_S3_BUCKET environment variable is required", file=sys.stderr)
        sys.exit(1)

    prefix = os.environ.get("SMGR_S3_PREFIX", "")
    interval = int(os.environ.get("SMGR_WATCH_INTERVAL", "30"))
    auto_enrich = os.environ.get("SMGR_AUTO_ENRICH", "true").lower() in ("true", "1", "yes")

    conn = get_db()
    init_db(conn)
    s3 = get_s3_client()

    print(f"Watching s3://{bucket}/{prefix}")
    print(f"Poll interval: {interval}s | Auto-enrich: {auto_enrich}")
    print("Press Ctrl+C to stop.\n")

    # Graceful shutdown
    running = True
    def handle_signal(sig, frame):
        nonlocal running
        running = False
        print("\nShutting down...")
    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    while running:
        new_count = _poll_bucket(conn, s3, bucket, prefix, auto_enrich)
        if new_count > 0:
            print(f"[{datetime.now().strftime('%H:%M:%S')}] Processed {new_count} new objects")

        if args.once:
            break

        # Sleep in small increments so we can respond to signals
        for _ in range(interval):
            if not running:
                break
            time.sleep(1)

    conn.close()


def _poll_bucket(conn: sqlite3.Connection, s3, bucket: str, prefix: str, auto_enrich: bool) -> int:
    """Poll S3 bucket once. Returns count of new objects processed."""
    objects = list_s3_objects(s3, bucket, prefix)

    # Filter to media files only
    media_objects = [o for o in objects if is_media_key(o["key"])]

    # Get already-seen keys
    seen_keys = set()
    for row in conn.execute("SELECT s3_key FROM watched_keys"):
        seen_keys.add(row["s3_key"])

    new_objects = [o for o in media_objects if o["key"] not in seen_keys]

    if not new_objects:
        return 0

    print(f"[{datetime.now().strftime('%H:%M:%S')}] Found {len(new_objects)} new objects in s3://{bucket}/{prefix}")

    processed = 0
    for obj in new_objects:
        key = obj["key"]
        print(f"  Processing: {key}")

        try:
            # Download the object
            image_bytes = download_s3_object(s3, bucket, key)
            content_hash = sha256_bytes(image_bytes)

            # Check if we already have this content (by hash)
            existing = conn.execute(
                "SELECT id FROM events WHERE type = 'create' AND content_hash = ?",
                (content_hash,)
            ).fetchone()

            if existing:
                # Content exists (maybe from a local scan), just record the S3 key
                conn.execute(
                    "INSERT OR IGNORE INTO watched_keys (s3_key, first_seen, event_id, etag, size_bytes) VALUES (?, ?, ?, ?, ?)",
                    (key, now_iso(), existing["id"], obj["etag"], obj["size"]),
                )
                conn.commit()
                print(f"    Already indexed (hash match), linked to event {existing['id']}")
                processed += 1
                continue

            # Create event
            event_id = new_event_id()
            content_type = detect_content_type_from_key(key)
            meta = s3_metadata(key, obj["size"], obj["etag"])
            remote_path = f"s3://{bucket}/{key}"

            conn.execute(
                "INSERT INTO events (id, timestamp, device_id, type, content_type, content_hash, remote_path, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (event_id, now_iso(), DEVICE_ID, "create", content_type, content_hash, remote_path, json.dumps(meta)),
            )

            # Record the watched key
            conn.execute(
                "INSERT OR IGNORE INTO watched_keys (s3_key, first_seen, event_id, etag, size_bytes) VALUES (?, ?, ?, ?, ?)",
                (key, now_iso(), event_id, obj["etag"], obj["size"]),
            )

            conn.commit()
            print(f"    Created event {event_id}")

            # Auto-enrich if enabled and it's an image
            if auto_enrich and content_type == "photo":
                mime, _ = mimetypes.guess_type(key)
                if mime and mime.startswith("image/"):
                    print("    Enriching...")
                    enrich_id = do_enrich(conn, event_id, image_bytes, mime)
                    if enrich_id:
                        print(f"    Enriched → {enrich_id}")

            processed += 1

        except Exception as e:
            print(f"    Error processing {key}: {e}", file=sys.stderr)
            # Still record the key so we don't retry on every poll
            conn.execute(
                "INSERT OR IGNORE INTO watched_keys (s3_key, first_seen, etag, size_bytes) VALUES (?, ?, ?, ?)",
                (key, now_iso(), obj["etag"], obj["size"]),
            )
            conn.commit()

    return processed


def cmd_enrich(args):
    """Enrich events via LLM."""
    conn = get_db()
    init_db(conn)

    if args.event_id:
        # Enrich a specific event
        event = conn.execute("SELECT * FROM events WHERE id = ?", (args.event_id,)).fetchone()
        if not event:
            print(f"Event not found: {args.event_id}", file=sys.stderr)
            sys.exit(1)

        # Check if already enriched (unless --force)
        if not args.force:
            existing = conn.execute(
                "SELECT id FROM events WHERE type = 'enrich' AND parent_id = ?",
                (args.event_id,)
            ).fetchone()
            if existing:
                print(f"Already enriched (event {existing['id']}). Use --force to re-enrich.")
                sys.exit(0)

        # Get the image bytes
        image_bytes = _get_event_image_bytes(conn, event)
        if not image_bytes:
            print(f"Cannot get image bytes for event {args.event_id}", file=sys.stderr)
            sys.exit(1)

        meta = json.loads(event["metadata"]) if event["metadata"] else {}
        mime = meta.get("mime_type", "image/jpeg")

        print(f"Enriching event {args.event_id}...")
        enrich_id = do_enrich(conn, args.event_id, image_bytes, mime)
        if enrich_id:
            print(f"Done → enrich event {enrich_id}")

    elif args.pending:
        # Enrich all un-enriched media events
        pending = conn.execute("""
            SELECT e.id, e.content_hash, e.content_type, e.local_path, e.remote_path, e.metadata
            FROM events e
            WHERE e.type = 'create'
              AND e.content_type = 'photo'
              AND NOT EXISTS (
                  SELECT 1 FROM events e2
                  WHERE e2.type = 'enrich' AND e2.parent_id = e.id
              )
            ORDER BY e.timestamp DESC
        """).fetchall()

        if not pending:
            print("No pending enrichments.")
            conn.close()
            return

        print(f"Found {len(pending)} items pending enrichment.")

        s3 = None
        bucket = os.environ.get("SMGR_S3_BUCKET")

        for i, event in enumerate(pending, 1):
            print(f"[{i}/{len(pending)}] Enriching {event['id']}...")

            image_bytes = _get_event_image_bytes(conn, event, s3=s3, bucket=bucket)
            if not image_bytes:
                print("  Skipping — cannot get image bytes")
                continue

            meta = json.loads(event["metadata"]) if event["metadata"] else {}
            mime = meta.get("mime_type", "image/jpeg")

            enrich_id = do_enrich(conn, event["id"], image_bytes, mime)
            if enrich_id:
                print(f"  Done → {enrich_id}")

    elif args.status:
        # Show enrichment status
        total = conn.execute("SELECT COUNT(*) FROM events WHERE type = 'create' AND content_type = 'photo'").fetchone()[0]
        enriched = conn.execute("SELECT COUNT(DISTINCT parent_id) FROM events WHERE type = 'enrich'").fetchone()[0]
        failed = conn.execute("SELECT COUNT(DISTINCT parent_id) FROM events WHERE type = 'enrich_failed'").fetchone()[0]
        pending = total - enriched

        print(json.dumps({
            "total_media": total,
            "enriched": enriched,
            "pending": pending,
            "failed": failed,
        }, indent=2))

    else:
        print("Specify --pending, --status, or an event ID.", file=sys.stderr)
        sys.exit(1)

    conn.close()


def _get_event_image_bytes(conn, event, s3=None, bucket=None) -> Optional[bytes]:
    """Get image bytes for an event, from local path or S3."""
    # Try local path first
    local_path = event["local_path"] if isinstance(event, dict) else event[6]  # local_path column
    if local_path and os.path.exists(local_path):
        with open(local_path, "rb") as f:
            return f.read()

    # Try S3
    remote_path = event["remote_path"] if isinstance(event, dict) else event[7]
    if remote_path and remote_path.startswith("s3://"):
        if s3 is None:
            s3 = get_s3_client()
        if bucket is None:
            bucket = os.environ.get("SMGR_S3_BUCKET")

        # Parse s3://bucket/key
        parts = remote_path[5:].split("/", 1)
        if len(parts) == 2:
            s3_bucket, key = parts
        else:
            s3_bucket = bucket
            key = parts[0]

        try:
            return download_s3_object(s3, s3_bucket, key)
        except Exception as e:
            print(f"  Failed to download from S3: {e}", file=sys.stderr)

    # Try to find the key from metadata
    meta = event["metadata"] if isinstance(event, dict) else event[8]
    if meta:
        meta = json.loads(meta) if isinstance(meta, str) else meta
        s3_key = meta.get("s3_key")
        if s3_key and bucket:
            if s3 is None:
                s3 = get_s3_client()
            try:
                return download_s3_object(s3, bucket, s3_key)
            except Exception as e:
                print(f"  Failed to download from S3: {e}", file=sys.stderr)

    return None


def cmd_query(args):
    conn = get_db()
    init_db(conn)

    # If search query provided, use FTS
    if args.search:
        _query_fts(conn, args)
    else:
        _query_standard(conn, args)

    conn.close()


def _query_fts(conn, args):
    """Full-text search query using FTS5."""
    search_query = args.search

    # Build the query joining FTS results with events
    sql = """
        SELECT e.*, fts.description as enrichment_description,
               fts.objects as enrichment_objects, fts.context as enrichment_context,
               fts.tags as enrichment_tags
        FROM fts
        JOIN events e ON e.id = fts.event_id
        WHERE fts MATCH ?
          AND e.type = 'create'
    """
    params = [search_query]

    if args.type:
        sql += " AND e.content_type = ?"
        params.append(args.type)
    if args.since:
        sql += " AND e.timestamp >= ?"
        params.append(args.since)
    if args.until:
        sql += " AND e.timestamp <= ?"
        params.append(args.until)

    sql += " ORDER BY rank LIMIT ? OFFSET ?"
    limit = args.limit or 20
    offset = args.offset or 0
    params.extend([limit, offset])

    rows = conn.execute(sql, params).fetchall()

    if args.format == "json":
        events = []
        for row in rows:
            evt = dict(row)
            if evt.get("metadata"):
                evt["metadata"] = json.loads(evt["metadata"])
            # Include enrichment summary
            evt["enrichment_summary"] = {
                "description": evt.pop("enrichment_description", None),
                "objects": evt.pop("enrichment_objects", "").split(),
                "context": evt.pop("enrichment_context", None),
                "tags": evt.pop("enrichment_tags", "").split(),
            }
            events.append(evt)

        print(json.dumps({"events": events, "query": search_query, "limit": limit, "offset": offset}, indent=2))
    else:
        print(f"\nSearch results for: \"{search_query}\"\n")
        print(f"{'ID':<28} {'Date':<22} {'Type':<8} {'Description'}")
        print("─" * 100)
        for row in rows:
            ts = row["timestamp"][:19].replace("T", " ")
            desc = row["enrichment_description"] or ""
            if len(desc) > 50:
                desc = desc[:47] + "..."
            print(f"{row['id']:<28} {ts:<22} {row['content_type'] or '':<8} {desc}")
        print(f"\nShowing {len(rows)} results")


def _query_standard(conn, args):
    """Standard query without FTS."""
    clauses = ["type = 'create'"]
    params = []

    if args.type:
        clauses.append("content_type = ?")
        params.append(args.type)
    if args.since:
        clauses.append("timestamp >= ?")
        params.append(args.since)
    if args.until:
        clauses.append("timestamp <= ?")
        params.append(args.until)
    if args.device:
        clauses.append("device_id = ?")
        params.append(args.device)

    where = " AND ".join(clauses)
    limit = args.limit or 20
    offset = args.offset or 0

    total = conn.execute(f"SELECT COUNT(*) FROM events WHERE {where}", params).fetchone()[0]

    rows = conn.execute(
        f"SELECT * FROM events WHERE {where} ORDER BY timestamp DESC LIMIT ? OFFSET ?",
        params + [limit, offset],
    ).fetchall()

    if args.format == "json":
        result = {
            "events": [dict(r) for r in rows],
            "total": total,
            "limit": limit,
            "offset": offset,
        }
        for evt in result["events"]:
            if evt.get("metadata"):
                evt["metadata"] = json.loads(evt["metadata"])
            # Attach enrichment if available
            enrich = conn.execute(
                "SELECT metadata FROM events WHERE type = 'enrich' AND parent_id = ?",
                (evt["id"],)
            ).fetchone()
            if enrich:
                enrich_meta = json.loads(enrich["metadata"])
                evt["enrichment"] = enrich_meta.get("enrichment")
        print(json.dumps(result, indent=2))
    else:
        print(f"\n{'ID':<28} {'Date':<22} {'Type':<8} {'Size':>10}  {'Path/Key'}")
        print("─" * 100)
        for row in rows:
            meta = json.loads(row["metadata"]) if row["metadata"] else {}
            size = meta.get("size_bytes", 0)
            size_str = _human_size(size)
            ts = row["timestamp"][:19].replace("T", " ")
            path = row["local_path"] or row["remote_path"] or meta.get("s3_key", "")
            if len(path) > 40:
                path = "..." + path[-37:]
            print(f"{row['id']:<28} {ts:<22} {row['content_type'] or '':<8} {size_str:>10}  {path}")
        print(f"\nShowing {len(rows)} of {total} events (offset {offset})")


def cmd_show(args):
    conn = get_db()
    init_db(conn)
    row = conn.execute("SELECT * FROM events WHERE id = ?", (args.event_id,)).fetchone()

    if not row:
        print(f"Event not found: {args.event_id}", file=sys.stderr)
        sys.exit(1)

    event = dict(row)
    if event.get("metadata"):
        event["metadata"] = json.loads(event["metadata"])

    # Attach enrichment if this is a create event
    if event["type"] == "create":
        enrich = conn.execute(
            "SELECT metadata FROM events WHERE type = 'enrich' AND parent_id = ?",
            (args.event_id,)
        ).fetchone()
        if enrich:
            enrich_meta = json.loads(enrich["metadata"])
            event["enrichment"] = enrich_meta.get("enrichment")

    conn.close()
    print(json.dumps(event, indent=2))


def cmd_stats(_args):
    conn = get_db()
    init_db(conn)

    total = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]

    by_type = {}
    for row in conn.execute("SELECT content_type, COUNT(*) as cnt FROM events WHERE type = 'create' GROUP BY content_type"):
        by_type[row["content_type"] or "unknown"] = row["cnt"]

    by_event_type = {}
    for row in conn.execute("SELECT type, COUNT(*) as cnt FROM events GROUP BY type"):
        by_event_type[row["type"]] = row["cnt"]

    total_bytes = conn.execute(
        "SELECT COALESCE(SUM(json_extract(metadata, '$.size_bytes')), 0) FROM events WHERE type = 'create'"
    ).fetchone()[0]

    watched = conn.execute("SELECT COUNT(*) FROM watched_keys").fetchone()[0]
    enriched = conn.execute("SELECT COUNT(DISTINCT parent_id) FROM events WHERE type = 'enrich'").fetchone()[0]
    pending = (by_type.get("photo", 0)) - enriched

    db_size = os.path.getsize(DB_PATH) if os.path.exists(DB_PATH) else 0

    conn.close()

    stats = {
        "total_events": total,
        "by_content_type": by_type,
        "by_event_type": by_event_type,
        "total_content_bytes": total_bytes,
        "total_content_human": _human_size(total_bytes),
        "watched_s3_keys": watched,
        "enriched": enriched,
        "pending_enrichment": max(0, pending),
        "events_db_bytes": db_size,
        "device_id": DEVICE_ID,
    }
    print(json.dumps(stats, indent=2))


def cmd_webhook_server(args):
    """Start an HTTP server that receives S3 event notifications.

    Accepts POST /webhook with S3 event notification JSON.
    This is the event-driven alternative to polling.
    Works with S3 Event Notifications → SNS → HTTP, MinIO webhooks,
    or any system that can POST S3-format event JSON.
    """
    from http.server import HTTPServer, BaseHTTPRequestHandler

    conn = get_db()
    init_db(conn)

    bucket = os.environ.get("SMGR_S3_BUCKET")
    auto_enrich = os.environ.get("SMGR_AUTO_ENRICH", "true").lower() in ("true", "1", "yes")
    s3 = None

    class WebhookHandler(BaseHTTPRequestHandler):
        def do_POST(self):
            if self.path != "/webhook":
                self.send_response(404)
                self.end_headers()
                return

            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)

            try:
                payload = json.loads(body)
                records = _extract_s3_records(payload)

                processed = 0
                for record in records:
                    key = record["key"]
                    if not is_media_key(key):
                        continue

                    s3_bucket = record.get("bucket", bucket)
                    print(f"Webhook: new object {key} in {s3_bucket}")

                    nonlocal s3
                    if s3 is None:
                        s3 = get_s3_client()

                    try:
                        image_bytes = download_s3_object(s3, s3_bucket, key)
                        content_hash = sha256_bytes(image_bytes)
                        content_type = detect_content_type_from_key(key)

                        # Check for duplicates
                        existing = conn.execute(
                            "SELECT id FROM events WHERE type = 'create' AND content_hash = ?",
                            (content_hash,)
                        ).fetchone()

                        if existing:
                            conn.execute(
                                "INSERT OR IGNORE INTO watched_keys (s3_key, first_seen, event_id, etag, size_bytes) VALUES (?, ?, ?, ?, ?)",
                                (key, now_iso(), existing["id"], record.get("etag", ""), record.get("size", 0)),
                            )
                            conn.commit()
                            print("  Already indexed (hash match)")
                            continue

                        event_id = new_event_id()
                        meta = s3_metadata(key, record.get("size", len(image_bytes)), record.get("etag", ""))
                        remote_path = f"s3://{s3_bucket}/{key}"

                        conn.execute(
                            "INSERT INTO events (id, timestamp, device_id, type, content_type, content_hash, remote_path, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                            (event_id, now_iso(), DEVICE_ID, "create", content_type, content_hash, remote_path, json.dumps(meta)),
                        )
                        conn.execute(
                            "INSERT OR IGNORE INTO watched_keys (s3_key, first_seen, event_id, etag, size_bytes) VALUES (?, ?, ?, ?, ?)",
                            (key, now_iso(), event_id, record.get("etag", ""), record.get("size", len(image_bytes))),
                        )
                        conn.commit()

                        print(f"  Created event {event_id}")

                        if auto_enrich and content_type == "photo":
                            mime, _ = mimetypes.guess_type(key)
                            if mime and mime.startswith("image/"):
                                enrich_id = do_enrich(conn, event_id, image_bytes, mime)
                                if enrich_id:
                                    print(f"  Enriched → {enrich_id}")

                        processed += 1

                    except Exception as e:
                        print(f"  Error processing {key}: {e}", file=sys.stderr)

                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"processed": processed}).encode())

            except Exception as e:
                print(f"Webhook error: {e}", file=sys.stderr)
                self.send_response(400)
                self.end_headers()
                self.wfile.write(str(e).encode())

        def do_GET(self):
            if self.path == "/health":
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"status":"ok"}')
            else:
                self.send_response(404)
                self.end_headers()

        def log_message(self, format, *args):
            # Quieter logging
            print(f"[webhook] {args[0]}")

    def _extract_s3_records(payload: dict) -> list[dict]:
        """Extract S3 object records from various notification formats."""
        records = []

        # AWS S3 Event Notification format (via SNS or direct)
        if "Records" in payload:
            for record in payload["Records"]:
                s3_info = record.get("s3", {})
                bucket_info = s3_info.get("bucket", {})
                object_info = s3_info.get("object", {})
                records.append({
                    "key": object_info.get("key", ""),
                    "bucket": bucket_info.get("name", ""),
                    "size": object_info.get("size", 0),
                    "etag": object_info.get("eTag", ""),
                    "event": record.get("eventName", ""),
                })

        # SNS wrapper (S3 → SNS → HTTP)
        elif "Message" in payload:
            try:
                message = json.loads(payload["Message"])
                return _extract_s3_records(message)
            except (json.JSONDecodeError, TypeError):
                pass

        # MinIO webhook format
        elif "EventName" in payload:
            key_info = payload.get("Key", "")
            # MinIO Key format: bucket/key
            parts = key_info.split("/", 1)
            records.append({
                "key": parts[1] if len(parts) > 1 else key_info,
                "bucket": parts[0] if len(parts) > 1 else "",
                "size": payload.get("Records", [{}])[0].get("s3", {}).get("object", {}).get("size", 0),
                "etag": "",
                "event": payload.get("EventName", ""),
            })

        # Simple format: just a key (for testing)
        elif "key" in payload:
            records.append({
                "key": payload["key"],
                "bucket": payload.get("bucket", ""),
                "size": payload.get("size", 0),
                "etag": payload.get("etag", ""),
            })

        return records

    port = args.port
    server = HTTPServer(("0.0.0.0", port), WebhookHandler)
    print(f"Webhook server listening on http://0.0.0.0:{port}/webhook")
    print(f"Auto-enrich: {auto_enrich}")
    print(f"Health check: http://0.0.0.0:{port}/health")
    print("Press Ctrl+C to stop.\n")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
    finally:
        server.server_close()
        conn.close()


def _human_size(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(n) < 1024:
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} PB"


# --- Main ---

def main():
    parser = argparse.ArgumentParser(prog="smgr", description="sitemgr — S3-event-driven media indexer")
    sub = parser.add_subparsers(dest="command")

    # init
    sub.add_parser("init", help="Initialize the event database")

    # scan
    p_scan = sub.add_parser("scan", help="Scan a local directory for media files")
    p_scan.add_argument("directory", help="Directory to scan")

    # watch
    p_watch = sub.add_parser("watch", help="Watch S3 bucket for new media objects")
    p_watch.add_argument("--once", action="store_true", help="Poll once and exit (no loop)")

    # enrich
    p_enrich = sub.add_parser("enrich", help="Enrich media events via LLM")
    p_enrich.add_argument("event_id", nargs="?", help="Specific event ID to enrich")
    p_enrich.add_argument("--pending", action="store_true", help="Enrich all un-enriched items")
    p_enrich.add_argument("--status", action="store_true", help="Show enrichment status")
    p_enrich.add_argument("--force", action="store_true", help="Re-enrich even if already enriched")

    # query
    p_query = sub.add_parser("query", help="Query events")
    p_query.add_argument("--search", help="Full-text search query (searches enrichment data)")
    p_query.add_argument("--type", help="Filter by content type (photo, video, audio)")
    p_query.add_argument("--since", help="Events after this date (ISO 8601)")
    p_query.add_argument("--until", help="Events before this date (ISO 8601)")
    p_query.add_argument("--device", help="Filter by device ID")
    p_query.add_argument("--limit", type=int, default=20, help="Max results (default 20)")
    p_query.add_argument("--offset", type=int, default=0, help="Pagination offset")
    p_query.add_argument("--format", choices=["table", "json"], default="table", help="Output format")

    # show
    p_show = sub.add_parser("show", help="Show event details")
    p_show.add_argument("event_id", help="Event ID to show")

    # stats
    sub.add_parser("stats", help="Show database statistics")

    # webhook-server
    p_webhook = sub.add_parser("webhook-server", help="Start S3 event notification webhook listener")
    p_webhook.add_argument("--port", type=int, default=8741, help="Port to listen on (default 8741)")

    args = parser.parse_args()

    commands = {
        "init": cmd_init,
        "scan": cmd_scan,
        "watch": cmd_watch,
        "enrich": cmd_enrich,
        "query": cmd_query,
        "show": cmd_show,
        "stats": cmd_stats,
        "webhook-server": cmd_webhook_server,
    }

    if args.command in commands:
        commands[args.command](args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
