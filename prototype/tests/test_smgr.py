"""Unit tests for smgr.py pure functions and mocked external services."""

import json
import sys
import os
from datetime import datetime
from unittest.mock import patch, MagicMock

# Add prototype dir to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import smgr


# --- Pure function tests (no mocks needed) ---


class TestDetectContentType:
    def test_jpeg(self):
        assert smgr.detect_content_type("photo.jpg") == "photo"
        assert smgr.detect_content_type("photo.jpeg") == "photo"

    def test_png(self):
        assert smgr.detect_content_type("image.png") == "photo"

    def test_video(self):
        assert smgr.detect_content_type("clip.mp4") == "video"
        assert smgr.detect_content_type("clip.mov") == "video"

    def test_audio(self):
        assert smgr.detect_content_type("song.mp3") == "audio"
        assert smgr.detect_content_type("track.flac") == "audio"

    def test_unknown(self):
        assert smgr.detect_content_type("readme.txt") == "file"

    def test_no_extension(self):
        assert smgr.detect_content_type("noext") == "file"

    def test_nested_path(self):
        assert smgr.detect_content_type("/bucket/photos/2024/beach.heic") == "photo"

    def test_from_key(self):
        assert smgr.detect_content_type_from_key("photos/sunset.webp") == "photo"


class TestIsMediaKey:
    def test_media_extensions(self):
        assert smgr.is_media_key("photo.jpg") is True
        assert smgr.is_media_key("video.mp4") is True
        assert smgr.is_media_key("audio.flac") is True
        assert smgr.is_media_key("pic.heic") is True

    def test_non_media(self):
        assert smgr.is_media_key("readme.txt") is False
        assert smgr.is_media_key("data.json") is False
        assert smgr.is_media_key(".gitignore") is False

    def test_case_insensitive(self):
        assert smgr.is_media_key("PHOTO.JPG") is True
        assert smgr.is_media_key("Video.MOV") is True


class TestS3Metadata:
    def test_basic(self):
        meta = smgr.s3_metadata("photos/beach.jpg", 1024000, '"abc123"')
        assert meta["mime_type"] == "image/jpeg"
        assert meta["size_bytes"] == 1024000
        assert meta["source"] == "s3-watch"
        assert meta["s3_key"] == "photos/beach.jpg"
        assert meta["s3_etag"] == '"abc123"'

    def test_unknown_extension(self):
        meta = smgr.s3_metadata("data.noext_whatsoever", 100, '"etag"')
        assert meta["mime_type"] == "application/octet-stream"


class TestSha256Bytes:
    def test_deterministic(self):
        h1 = smgr.sha256_bytes(b"hello world")
        h2 = smgr.sha256_bytes(b"hello world")
        assert h1 == h2
        assert h1.startswith("sha256:")

    def test_different_inputs(self):
        h1 = smgr.sha256_bytes(b"a")
        h2 = smgr.sha256_bytes(b"b")
        assert h1 != h2


class TestNewEventId:
    def test_length(self):
        eid = smgr.new_event_id()
        assert len(eid) == 26

    def test_unique(self):
        ids = {smgr.new_event_id() for _ in range(100)}
        assert len(ids) == 100


class TestNowIso:
    def test_format(self):
        ts = smgr.now_iso()
        assert "T" in ts
        assert "+" in ts or "Z" in ts or ts.endswith("+00:00")


# --- Mocked external service tests ---


class TestEnrichImageAnthropic:
    def test_calls_claude_vision(self):
        mock_client = MagicMock()
        enrichment_json = json.dumps({
            "description": "A beach at sunset",
            "objects": ["sand", "ocean", "sun"],
            "context": "vacation photo",
            "suggested_tags": ["beach", "sunset", "travel"],
        })
        mock_response = MagicMock()
        mock_response.content = [MagicMock(text=enrichment_json)]
        mock_client.messages.create.return_value = mock_response

        mock_anthropic = MagicMock()
        mock_anthropic.Anthropic.return_value = mock_client

        with patch.dict("sys.modules", {"anthropic": mock_anthropic}):
            result = smgr.enrich_image_anthropic(b"fake-image-bytes", "image/jpeg")

        assert result["description"] == "A beach at sunset"
        assert "beach" in result["suggested_tags"]
        assert result["provider"] == "anthropic"

        call_args = mock_client.messages.create.call_args
        assert call_args.kwargs["model"] == "claude-haiku-4-5-20251001"
        messages = call_args.kwargs["messages"]
        content = messages[0]["content"]
        assert any(block.get("type") == "image" for block in content)


class TestListS3Objects:
    def test_lists_objects(self):
        mock_client = MagicMock()
        mock_client.list_objects_v2.return_value = {
            "Contents": [
                {"Key": "photos/a.jpg", "Size": 1000, "ETag": '"e1"', "LastModified": datetime(2024, 1, 1)},
                {"Key": "photos/b.png", "Size": 2000, "ETag": '"e2"', "LastModified": datetime(2024, 1, 2)},
            ],
            "IsTruncated": False,
        }

        result = smgr.list_s3_objects(mock_client, "my-bucket", "photos/")

        assert len(result) == 2
        assert result[0]["key"] == "photos/a.jpg"
        assert result[0]["size"] == 1000
        assert result[0]["etag"] == "e1"
        mock_client.list_objects_v2.assert_called_once()

    def test_empty_bucket(self):
        mock_client = MagicMock()
        mock_client.list_objects_v2.return_value = {
            "IsTruncated": False,
        }

        result = smgr.list_s3_objects(mock_client, "my-bucket")
        assert result == []
