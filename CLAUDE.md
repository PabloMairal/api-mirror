# CLAUDE.md: api-mirror

TypeScript library + CLI that mirrors a REST API into Postgres tables,
incrementally, with a runs table and a health endpoint. Public portfolio repo:
code, README and UI in English; no secrets, no client code or data.

## Stack

* Node 24 running TypeScript directly (type stripping): only erasable syntax,
  relative imports end in `.ts`. `tsc` typechecks and builds `dist/`.
* Node from `~/.local/node-v24.20.0-linux-x64/bin` (the one on PATH is the
  Windows one and does not run).
* Runtime dependency: `pg` only. No ORM, no HTTP client, no CLI framework.
* Postgres 16 local: database `api_mirror`, tests on `api_mirror_test`
  (connection strings in `.env`, see `.env.example`).

## Invariants (the point of the project; tests guard each one)

* A page's upsert and the cursor update commit in the same transaction.
* A row is only overwritten by a strictly newer `modifiedAt`. Replays write
  nothing.
* One writer per source: session advisory lock on a dedicated connection.
* Sync reads from `cursor - overlap`, ordered by `modifiedAt` ascending. A
  row that reappears with a newer timestamp in the same pass means offset
  pagination shifted: restart from its old timestamp.
* Backfill saves the next page URL with each page, and on completion sets the
  cursor to when it started (min of our clock and the server's `Date`).

Changing any of these needs a test that fails before the change.

## Performance and queries

* A sync with no changes: 1 HTTP request and about 10 queries. Each run
  records `http_requests` and `db_queries` in the runs table; a change that
  raises either for the idle case gets justified in the commit.
* One upsert statement per page (`jsonb_to_recordset`), never one per row.
* Every column in a `where`, `join` or `order by` has an index, created in the
  same migration or the same `ensureTargetTable` call.
* No functions on indexed columns in `where`/`join`. Normalize when writing.
* Aggregate in SQL. Top-1-per-group lookups go through `lateral ... limit 1` on
  an index, and the plan is checked with `EXPLAIN ANALYZE` on a large runs table.
* A query change that alters results is a bug: compare old and new on the same
  data and put the number of compared cases in the commit.
* No cache in this project. If one is ever added, it caches data with
  low-cardinality keys and is invalidated by the event that changes it.
* Migrations are forward-only and additive. Never edit a shipped one; append.

## Tests

* Vitest against the real test database and a fake HTTP API
  (`test/support/fake-api.ts`). Never a real external API in tests.
* Every bug found gets a failing test first.
* Tests run before every commit that touches logic: `npm test`.

## External APIs

* The GitHub demo spends rate limit: only run it against the real API with
  Pablo's explicit OK.

## Alarm signals: stop and measure

* A query inside a loop over rows, or an upsert per row.
* `get`-everything-then-filter in JS.
* "It is slow locally": count queries and requests per run first.
