/**
 * Shared constants for media handling
 */

export const MEDIA_EXTENSIONS = new Set([
  // Images
  ".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif",
  ".gif", ".bmp", ".tiff", ".tif",
  // Video
  ".mp4", ".mov", ".avi", ".mkv", ".webm",
  // Audio
  ".mp3", ".wav", ".ogg", ".flac", ".m4a",
]);

export const CONTENT_TYPE_PHOTO = "photo";
export const CONTENT_TYPE_VIDEO = "video";
export const CONTENT_TYPE_AUDIO = "audio";
export const CONTENT_TYPE_FILE = "file";

/**
 * Event op values. Namespaced (`kind:verb`) so the schema is extensible to
 * future operations (e.g. `s3:delete`, `enrich:complete`) without ambiguous
 * labels. Spec 21 replaced the vague `type='create'` with these.
 */
export const EVENT_OP_S3_PUT = "s3:put";

export const CONTENT_TYPE_MAP: Record<string, string> = {
  image: CONTENT_TYPE_PHOTO,
  video: CONTENT_TYPE_VIDEO,
  audio: CONTENT_TYPE_AUDIO,
};

export const ENRICHMENT_PROMPT = `Analyze this image and return a JSON object with exactly these fields:
- "description": A detailed description of what you see (2-3 sentences)
- "objects": A list of notable objects, subjects, or elements
- "context": The likely activity or context (e.g., "furniture repair", "travel", "cooking")
- "suggested_tags": 3-5 short tags for categorization

Be specific and concrete. Describe what you actually see.
Return ONLY valid JSON, no markdown fences or extra text.`;
