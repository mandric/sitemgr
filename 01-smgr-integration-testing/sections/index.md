# Section Index: smgr Integration Testing

## Sections

| # | Filename | Title | Dependencies |
|---|----------|-------|-------------|
| 1 | section-01-db-migration.md | Database Migration — model_configs Table | None |
| 2 | section-02-enrichment-code.md | Enrichment Code — Configurable Model Endpoint | Section 1 |
| 3 | section-03-cli-startup.md | CLI Startup — Model Config Loading | Section 2 |
| 4 | section-04-docker-compose.md | Docker Compose — Ollama Service | None |
| 5 | section-05-fixture-images.md | Test Fixture Images | None |
| 6 | section-06-integration-test.md | Integration Test — smgr-e2e.test.ts | Sections 1-5 |
| 7 | section-07-ci-pipeline.md | CI Pipeline Changes | Sections 4, 6 |

## Execution Order

**Batch 1** (parallel): Sections 1, 4, 5 (no dependencies)
**Batch 2** (parallel): Sections 2, 3 (depend on Section 1)
**Batch 3** (parallel): Sections 6, 7 (depend on all prior)

## Source Files

- Plan: `claude-plan.md`
- TDD: `claude-plan-tdd.md`
- Research: `claude-research.md`
- Spec: `claude-spec.md`
