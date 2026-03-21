# Section 5: Test Fixture Images

## Goal

Create three real JPEG photographs as test fixtures for the smgr e2e integration test. Each image depicts a visually distinct subject so that after AI enrichment, full-text search can reliably find the correct images and exclude the wrong ones.

## Files to Create

All files go in `web/__tests__/integration/fixtures/` (create the directory if it does not exist):

| File | Subject | Size Target | Search Term That Must Appear in AI Description |
|------|---------|-------------|------------------------------------------------|
| `pineapple.jpg` | Close-up of a pineapple | 10–30 KB | "pineapple" |
| `dog.jpg` | Clear photo of a dog | 10–30 KB | "dog" |
| `beach.jpg` | Beach / ocean scene | 10–30 KB | "beach" |

## Image Requirements

1. **Real photographs**, not illustrations or clipart. Vision models describe photos more reliably than artwork.
2. **Single dominant subject** to reduce ambiguity in model descriptions.
3. **Small file size** (10–30 KB each). The repository should stay light, but the image must contain enough detail for the model to identify the content.
4. **Open license**. Use Unsplash (unsplash.com) or Pexels (pexels.com) — both offer free commercial-use licenses with no attribution required.
5. **JPEG format** to match the most common media type in the pipeline.
6. **Resize to approximately 320×240 pixels** or smaller. This is just enough for the model to work with.

## Step-by-Step Sourcing Procedure

### 1. Create the fixtures directory

```bash
mkdir -p web/__tests__/integration/fixtures
```

### 2. Download source images

Visit Unsplash or Pexels and search for each subject ("pineapple", "dog", "beach"). Pick a photo where the subject is unambiguous — centered in frame, well-lit, no competing objects.

Download one photo per subject.

### 3. Resize and compress with ImageMagick

For each downloaded image, resize to 320×240 at 75% JPEG quality:

```bash
convert pineapple-original.jpg -resize 320x240 -quality 75 web/__tests__/integration/fixtures/pineapple.jpg
convert dog-original.jpg       -resize 320x240 -quality 75 web/__tests__/integration/fixtures/dog.jpg
convert beach-original.jpg     -resize 320x240 -quality 75 web/__tests__/integration/fixtures/beach.jpg
```

### 4. Verify file sizes

Every file must be between 10 KB and 30 KB:

```bash
ls -lh web/__tests__/integration/fixtures/*.jpg
```

If a file is too large, lower the `-quality` value (try 60, then 50). If too small, pick a more detailed source photo or raise quality.

### 5. Validate with the vision model

This is the critical step. Each image must produce an AI description that contains its expected search term. The e2e test (Section 6) depends on this property.

Start Ollama and pull the model:

```bash
ollama serve &
ollama pull moondream:1.8b
```

Test each image:

```bash
# Test pineapple.jpg — output must contain the word "pineapple"
echo '{"model":"moondream:1.8b","prompt":"Describe this image","images":["'"$(base64 -w0 web/__tests__/integration/fixtures/pineapple.jpg)"'"]}' | \
  curl -s http://localhost:11434/api/generate -d @- | jq -r '.response'

# Test dog.jpg — output must contain the word "dog"
echo '{"model":"moondream:1.8b","prompt":"Describe this image","images":["'"$(base64 -w0 web/__tests__/integration/fixtures/dog.jpg)"'"]}' | \
  curl -s http://localhost:11434/api/generate -d @- | jq -r '.response'

# Test beach.jpg — output must contain the word "beach"
echo '{"model":"moondream:1.8b","prompt":"Describe this image","images":["'"$(base64 -w0 web/__tests__/integration/fixtures/beach.jpg)"'"]}' | \
  curl -s http://localhost:11434/api/generate -d @- | jq -r '.response'
```

If the model does not mention the expected subject word, discard that photo and try a different one from Unsplash/Pexels. Repeat from step 2 for that subject.

### 6. Final directory structure

After completion, the fixtures directory should contain exactly:

```
web/__tests__/integration/fixtures/
├── pineapple.jpg
├── dog.jpg
└── beach.jpg
```

## Acceptance Criteria

- [ ] Three JPEG files exist at the paths listed above.
- [ ] Each file is a real photograph (not an illustration).
- [ ] Each file is between 10 KB and 30 KB.
- [ ] Each file is approximately 320×240 pixels.
- [ ] The moondream:1.8b model produces a description containing the expected subject word for each image (verified manually during sourcing).

## No Automated Tests

These are test inputs, not code. Validation is performed manually during the sourcing procedure (step 5) and confirmed end-to-end by the integration test in Section 6.
