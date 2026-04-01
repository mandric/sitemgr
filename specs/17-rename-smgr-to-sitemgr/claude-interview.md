# Interview Transcript: Spec 17 — Rename smgr to sitemgr

## Q1: Should the npm script name also change from `npm run smgr` to `npm run sitemgr`?

**Answer:** Yes, rename to sitemgr. (`npm run sitemgr stats`, `npm run sitemgr watch`, etc.)

## Q2: The CI workflow sets SMGR_OLLAMA_URL and SMGR_VISION_MODEL which aren't in the spec's env var list. Should these also be renamed to SITEMGR_*?

**Answer:** Yes, rename all SMGR_ prefixed vars — comprehensive rename including SMGR_OLLAMA_URL, SMGR_VISION_MODEL.

## Q3: The Dockerfile references smgr.ts and SMGR_* env vars. Should it be updated too?

**Answer:** Yes, update Dockerfile (env vars and CMD).
