# 04-web-application — Spec

## Overview

Next.js web application with authentication, S3 bucket configuration, media browsing/search UI, and agent chat interface. This is the primary user-facing interface for managing and exploring media collections.

## Requirements Reference

See `REQUIREMENTS.md` sections: Core Features §6 (Web UI), Tech Stack (Frontend).

## Scope

### Authentication
- Supabase Auth with email/password
- Pages: login, signup, password reset, email confirmation
- Protected routes with auth middleware
- User profile management (phone number linking)

### Bucket Configuration
- Add S3 bucket credentials (name, endpoint, region, access key, secret key)
- List configured buckets
- Delete bucket configurations
- Credentials encrypted at rest before storage

### Media Browsing (NOT YET IMPLEMENTED)
- Media gallery/grid view showing indexed photos/videos
- Thumbnail generation or lazy loading from S3
- Pagination or infinite scroll
- Content type filtering

### Search UI (NOT YET IMPLEMENTED)
- Search input with full-text query
- Search results display with media previews
- Filters: content type, date range, device
- Results from `search_events()` RPC

### Media Detail (NOT YET IMPLEMENTED)
- Individual media view (full-size image/video)
- Display enrichment data: description, objects, context, tags
- Event history chain (parent references)

### Agent Chat Interface
- Chat UI component for natural language queries
- Server actions calling agent API
- Message history display

### Design System
- React 19 with Next.js App Router
- Tailwind CSS for styling
- Radix UI component primitives
- Responsive design

## Implementation Status

**Partially implemented (~60%):**
- Auth flows: complete and working
- Bucket config UI: complete (add/list/delete)
- Agent chat: basic implementation working
- **Missing:** Media gallery/grid view
- **Missing:** Search results display
- **Missing:** Media detail page with enrichments

### Key Files
- `web/app/` — All pages and layouts
- `web/app/auth/` — Auth pages (login, signup, reset, confirm)
- `web/app/buckets/` — Bucket configuration pages
- `web/app/agent/` — Chat interface page
- `web/components/` — React components (auth, buckets, agent, ui)
- `web/e2e/agent.spec.ts` — E2E test for chat interface

## Dependencies

**Depends on:**
- 01-data-foundation (Supabase Auth, client helpers)
- 02-media-pipeline (media data, search results, S3 URLs)
- 03-agent-messaging (agent API for chat)

## Key Decisions
- Next.js App Router (not Pages Router)
- Server components by default, client components where needed
- Supabase SSR for server-side auth
- No offline support in v1
