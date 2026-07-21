# Animation plans

| Plan | Title | Severity | Status |
| --- | --- | --- | --- |
| [001](001-fluid-mobile-article-swap.md) | Make mobile article swaps fluid and reliable | HIGH | DONE |

## Execution order

1. Execute plan 001 as one cohesive change. Its gesture, navigation, and two-layer motion steps share the same state machine and should not be split across commits.

There are no external plan dependencies.
