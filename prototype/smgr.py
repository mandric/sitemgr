#!/usr/bin/env python3
"""
smgr prototype — camera roll viewer.

Minimal implementation of the sitemgr event store and query interface.
Exercises: scan → hash → event store → query → display.

Usage:
    python3 smgr.py scan <directory>         # Import photos from a directory
    python3 smgr.py query [--type TYPE] [--since DATE] [--until DATE] [--limit N] [--format FORMAT]
    python3 smgr.py show <event_id>          # Show event details
    python3 smgr.py stats                    # Show database statistics
    python3 smgr.py init                     # Initialize the database
"""

import argparse
import hashlib
import json
import mimetypes
import os
import sqlite3
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

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


def detect_content_type(path: str) -> str:
    mime, _ = mimetypes.guess_type(path)
    if mime:
        major = mime.split("/")[0]
        return CONTENT_TYPE_MAP.get(major, "file")
    return "file"


def new_event_id() -> str:
    """Generate a unique event ID. Uses UUID4 for the prototype;
    the Rust implementation will use ULIDs."""
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
    # Try to get image dimensions without Pillow
    if mime and mime.startswith("image/"):
        dims = _read_image_dimensions(path, mime)
        if dims:
            meta["dimensions"] = {"width": dims[0], "height": dims[1]}
    return meta


def _read_image_dimensions(path: str, mime: str) -> tuple | None:
    """Read image dimensions from file header without external dependencies."""
    try:
        with open(path, "rb") as f:
            header = f.read(32)

            # PNG: width/height at bytes 16-24
            if header[:8] == b"\x89PNG\r\n\x1a\n":
                import struct
                w, h = struct.unpack(">II", header[16:24])
                return (w, h)

            # JPEG: need to parse markers
            if header[:2] == b"\xff\xd8":
                return _jpeg_dimensions(f)

    except Exception:
        pass
    return None


def _jpeg_dimensions(f) -> tuple | None:
    """Parse JPEG markers to find image dimensions."""
    import struct
    f.seek(2)
    while True:
        marker = f.read(2)
        if len(marker) < 2:
            return None
        if marker[0] != 0xFF:
            return None
        # SOF markers (SOF0-SOF15, excluding DHT=0xC4, DAC=0xCC)
        if marker[1] in range(0xC0, 0xD0) and marker[1] not in (0xC4, 0xC8, 0xCC):
            length_data = f.read(3)  # length (2) + precision (1)
            if len(length_data) < 3:
                return None
            hw = f.read(4)
            if len(hw) < 4:
                return None
            h, w = struct.unpack(">HH", hw)
            return (w, h)
        else:
            # Skip this marker's data
            length_data = f.read(2)
            if len(length_data) < 2:
                return None
            length = struct.unpack(">H", length_data)[0]
            f.seek(length - 2, 1)


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

    # Get existing hashes to skip duplicates
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


def cmd_query(args):
    conn = get_db()
    init_db(conn)

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

    # Get total count
    total = conn.execute(f"SELECT COUNT(*) FROM events WHERE {where}", params).fetchone()[0]

    # Get results
    rows = conn.execute(
        f"SELECT * FROM events WHERE {where} ORDER BY timestamp DESC LIMIT ? OFFSET ?",
        params + [limit, offset],
    ).fetchall()

    conn.close()

    if args.format == "json":
        result = {
            "events": [dict(r) for r in rows],
            "total": total,
            "limit": limit,
            "offset": offset,
        }
        # Parse metadata JSON for each event
        for evt in result["events"]:
            if evt.get("metadata"):
                evt["metadata"] = json.loads(evt["metadata"])
        print(json.dumps(result, indent=2))
    else:
        # Table format
        print(f"\n{'ID':<28} {'Date':<22} {'Type':<8} {'Size':>10}  {'Path'}")
        print("─" * 100)
        for row in rows:
            meta = json.loads(row["metadata"]) if row["metadata"] else {}
            size = meta.get("size_bytes", 0)
            size_str = _human_size(size)
            ts = row["timestamp"][:19].replace("T", " ")
            path = row["local_path"] or ""
            # Shorten path for display
            if len(path) > 40:
                path = "..." + path[-37:]
            print(f"{row['id']:<28} {ts:<22} {row['content_type'] or '':<8} {size_str:>10}  {path}")

        print(f"\nShowing {len(rows)} of {total} events (offset {offset})")


def cmd_show(args):
    conn = get_db()
    init_db(conn)
    row = conn.execute("SELECT * FROM events WHERE id = ?", (args.event_id,)).fetchone()
    conn.close()

    if not row:
        print(f"Event not found: {args.event_id}", file=sys.stderr)
        sys.exit(1)

    event = dict(row)
    if event.get("metadata"):
        event["metadata"] = json.loads(event["metadata"])

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

    db_size = os.path.getsize(DB_PATH) if os.path.exists(DB_PATH) else 0

    conn.close()

    stats = {
        "total_events": total,
        "by_content_type": by_type,
        "by_event_type": by_event_type,
        "total_content_bytes": total_bytes,
        "total_content_human": _human_size(total_bytes),
        "events_db_bytes": db_size,
        "device_id": DEVICE_ID,
    }
    print(json.dumps(stats, indent=2))


def _human_size(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(n) < 1024:
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} PB"


# --- Main ---

def main():
    parser = argparse.ArgumentParser(prog="smgr", description="sitemgr prototype — camera roll viewer")
    sub = parser.add_subparsers(dest="command")

    # init
    sub.add_parser("init", help="Initialize the event database")

    # scan
    p_scan = sub.add_parser("scan", help="Scan a directory for media files")
    p_scan.add_argument("directory", help="Directory to scan")

    # query
    p_query = sub.add_parser("query", help="Query events")
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

    args = parser.parse_args()

    commands = {
        "init": cmd_init,
        "scan": cmd_scan,
        "query": cmd_query,
        "show": cmd_show,
        "stats": cmd_stats,
    }

    if args.command in commands:
        commands[args.command](args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
