# Case study results

Measured 2026-10-19 on 11th Gen Intel(R) Core(TM) i5-11400H @ 2.70GHz, Node v24.20.0, Postgres 16.15, WSL2.
Fake API on localhost (in-memory, pages of 100). `latency` is an artificial delay per response.

| Scenario | Rows read | Rows written | HTTP requests | DB queries | HTTP ms | DB ms | Total ms | Rows/s |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Backfill 50k rows, latency 0 | 50,000 | 50,000 | 500 | 2008 | 1834 | 4874 | 6987 | 7,156 |
| Sync, 1,000 changed rows | 1,058 | 1,000 | 11 | 49 | 116 | 148 | 273 | 3,875 |
| Sync, no changes (median of 21) | 61 | 0 | 1 | 8 | 3 | 18 | 22 | - |
| Backfill 10k rows, latency 50 ms | 10,000 | 10,000 | 100 | 408 | 5466 | 1236 | 6762 | 1,479 |
| Sync, 100 changed rows, latency 50 ms | 160 | 100 | 2 | 13 | 115 | 37 | 153 | 1,046 |
| Sync, no changes, latency 50 ms (median of 11) | 61 | 0 | 1 | 8 | 54 | 16 | 70 | - |

Health check with 100,000 rows in the runs table (5 sources): median 1.9 ms for `mirror.health()` end to end (21 calls), 1 query.
Last-ok lookup, `EXPLAIN ANALYZE`: 0.155 ms, plan uses `runs_source_last_ok_idx`.

```
Nested Loop Left Join  (cost=0.42..3.96 rows=5 width=40) (actual time=0.059..0.131 rows=5 loops=1)
  Buffers: shared hit=20
  ->  Function Scan on unnest n  (cost=0.00..0.05 rows=5 width=32) (actual time=0.007..0.008 rows=5 loops=1)
  ->  Limit  (cost=0.42..0.77 rows=1 width=8) (actual time=0.024..0.024 rows=1 loops=5)
        Buffers: shared hit=20
        ->  Index Only Scan using runs_source_last_ok_idx on runs r  (cost=0.42..5764.91 rows=16329 width=8) (actual time=0.023..0.023 rows=1 loops=5)
              Index Cond: (source = n.name)
              Heap Fetches: 5
              Buffers: shared hit=20
Planning Time: 0.176 ms
Execution Time: 0.155 ms
```
