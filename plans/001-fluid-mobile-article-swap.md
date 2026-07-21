# 001 — Make mobile article swaps fluid and reliable

- **Status**: DONE
- **Commit**: 73d94ea
- **Severity**: HIGH
- **Category**: Gesture reliability, interruptibility, spatial consistency
- **Estimated scope**: 5 files, roughly 200–300 lines including focused business-logic tests

## Problem

The production mobile article swap recognizes gestures by distance and an arbitrary maximum duration, then runs the outgoing and incoming articles as separate fixed-duration animations. Valid flicks and deliberate drags are rejected, the outgoing article can complete in 90ms with an accelerating curve, and the next article is not present until the old article has nearly disappeared.

```ts
// src/client/article-swipe.ts:1 — current
const MINIMUM_SWIPE_DISTANCE = 64;
const MAXIMUM_SWIPE_DURATION = 700;
const HORIZONTAL_DOMINANCE = 1.25;

if (
  durationMs < 0 ||
  durationMs > MAXIMUM_SWIPE_DURATION ||
  Math.abs(horizontalDistance) < MINIMUM_SWIPE_DISTANCE ||
  Math.abs(horizontalDistance) < Math.abs(verticalDistance) * HORIZONTAL_DOMINANCE
) {
  return null;
}
```

```ts
// src/client/reader.tsx:1234 — current
const exitX = directionSign * Math.max(surface.clientWidth * 0.55, 180);
const remainingDistance = Math.abs(exitX - currentX);
const velocityDuration = releaseVelocity
  ? (remainingDistance / Math.max(Math.abs(releaseVelocity), 700)) * 1000
  : SWIPE_EXIT_DURATION;
const duration = Math.min(180, Math.max(90, velocityDuration));

const animation = surface.animate(
  [start, { transform: `translate3d(${exitX}px, 0, 0)`, opacity: 0.08 }],
  {
    duration,
    easing: "cubic-bezier(0.4, 0, 1, 1)",
    fill: "forwards",
  },
);
```

```ts
// src/client/reader.tsx:1254 — current
animation.onfinish = () => {
  pendingNavigation.current = direction;
  const navigationResult = navigate();
  animateSurfaceBack();
  void Promise.resolve(navigationResult).then((moved) => {
    if (moved || pendingNavigation.current !== direction) return;
    pendingNavigation.current = null;
  });
};
```

This delays navigation until the exit finishes. At a pagination boundary the old article leaves, returns while the network request runs, and a retry can overwrite or clear the shared pending direction.

## Target

Implement one continuous, velocity-aware article track with these exact behaviors:

- A gesture commits when horizontal distance is at least `64px` **or** absolute horizontal velocity exceeds `0.11px/ms`, provided horizontal movement remains at least `1.25` times vertical movement. Remove the maximum gesture duration.
- Track the last five pointer samples, discarding samples older than `100ms`, and hand their horizontal release velocity to the settling animation in pixels per second.
- Call the navigation handler immediately when a gesture commits. Keep one immutable pending navigation request until it succeeds or fails. A repeated release while that request is unresolved must restore the visible surface without starting another navigation request.
- If the article prop changes for the pending request, keep the outgoing article DOM mounted and mount the incoming article beside it. For a next article, the incoming surface starts exactly one surface width to the right of the outgoing surface; for a previous article, it starts exactly one surface width to the left. There must never be a blank gap between the two surfaces.
- Settle both surfaces with one critically damped spring using Apple-style `damping: 1.0` and `response: 0.4`. Use the analytical critical-damping solution with `omega = 2 * Math.PI / response`, start from the current computed transform, and hand off the recent pointer velocity. Stop once position is within `0.5px` and velocity is below `5px/s`.
- Update only `transform` and `opacity` during the spring. The outgoing article fades toward `0.35`; the incoming article begins at `0.65` and reaches `1` as the track settles. Apply transforms directly to each animated element; do not drive them through an inherited CSS variable.
- An interrupted spring must cancel its animation frame, preserve the active article's current computed transform, remove the obsolete outgoing layer, and let the new pointer gesture continue from that on-screen position.
- If navigation is still awaiting pagination after one animation frame, restore the current surface to rest with the same critically damped spring. When the article eventually arrives, start its two-layer transition from the then-current presentation value with zero inherited release velocity.
- A failed or unavailable navigation restores the current article without making it disappear. Do not add a full-exit boundary animation.
- Under `prefers-reduced-motion: reduce`, do not move either surface. Cross-fade opacity for `200ms` with `ease`, preserving the current reduced-motion behavior.
- Keep keyboard `J`/`K` navigation instant. Only touch gestures and the visible previous/next buttons use the swap animation.

## Repo conventions to follow

- Shared motion tokens live at `src/client/styles.css:34`:

  ```css
  --duration-fast: 140ms;
  --duration-surface: 180ms;
  --duration-reduced: 200ms;
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
  --ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);
  ```

- The existing swipe code correctly uses Pointer Events, pointer capture, `translate3d`, direct element styles, conditional `will-change`, and a reduced-motion branch. Preserve those choices.
- `src/client/App.tsx:819` already returns `Promise<boolean>` from article navigation. Keep that contract; do not move animation concerns into the application state layer.
- Business-logic tests belong in `tests/client/article-swipe.test.ts` and must assert observable gesture decisions without mocks.

## Steps

1. In `src/client/article-swipe.ts`, replace the maximum-duration rule with the exact distance-or-velocity rule above. Accept recent horizontal velocity as an explicit input so the classifier and spring use the same release measurement.
2. Update `tests/client/article-swipe.test.ts` to prove all four behaviors: a normal 100px swipe commits; a 52px/110ms flick commits; a 100px/850ms deliberate drag commits; a short slow movement and vertically dominant movement do not commit.
3. Add `src/client/swipe-motion.ts` with a single reusable `animateHorizontalSpring` primitive. It must implement the exact critically damped formula, expose `cancel()`, update through `requestAnimationFrame`, accept initial position/velocity/target, and report normalized progress to its caller. Do not add a package.
4. Refactor `ReaderPane` in `src/client/reader.tsx` so the currently displayed article view is retained internally until prop changes are reconciled in a layout effect. Store the outgoing article, full-content visibility, and summary state for the duration of the transition.
5. Extract the repeated action-bar and `ArticleDocument` markup into one local article-surface renderer. During a transition render the outgoing surface as `aria-hidden` and inert, and render the incoming surface as the only interactive layer. Preserve unique title IDs.
6. Replace the exit-then-entry WAAPI sequence with a single two-surface spring. Position the incoming surface adjacent to the outgoing surface using the surface's measured width and the navigation direction. Remove the `0.84` overshoot keyframe and every `cubic-bezier(0.4, 0, 1, 1)` use.
7. Replace the mutable direction-only pending ref with an immutable request record containing a monotonically increasing request ID, direction, release velocity, and restore-frame handle. Start navigation on release; suppress duplicate commits until that request resolves; ignore stale promise completions by request ID.
8. Preserve interruption: on a new primary pointer, cancel the active spring, read the live transform, finalize the incoming article as the active surface, and begin tracking from that exact value. Keep the existing multi-touch protection and pointer capture.
9. In `src/client/styles.css`, add a positioned article-swipe stage and outgoing/incoming layer rules. Only the inactive layer is absolute and non-interactive; the active layer must continue to determine document height after settling. Keep `will-change` limited to active motion.
10. Reset the outer reader scroll position to the top when the active article changes, matching the current keyed reader behavior.
11. Run the full project checks and fix every failure without weakening existing coverage.

## Boundaries

- Do NOT add Motion, Framer Motion, React Spring, or another dependency.
- Do NOT change server APIs, article ordering, route history, read/star behavior, or pagination semantics.
- Do NOT animate keyboard-initiated `J`/`K` navigation.
- Do NOT animate layout properties such as width, height, top, left, margin, or padding.
- Do NOT add mocked animation tests or tests that merely assert source text.
- Use a hard cutover; remove the old exit/entry animation path rather than retaining a fallback implementation.
- If the current code differs materially from commit `73d94ea`, stop and report the drift instead of improvising.

## Verification

- **Mechanical**: `npm run typecheck`
- **Mechanical**: `npm run lint`
- **Mechanical**: `npm test`
- **Mechanical**: `npm run build`
- **Feel check**: in a `390px`-wide mobile viewport, drag an article 100px and release. The current article and next article must remain edge-to-edge throughout the settle, with no blank frame.
- **Feel check**: perform a short fast flick under 64px. It must navigate. Perform a slow drag longer than 700ms and beyond 64px. It must also navigate.
- **Feel check**: reverse direction by grabbing the incoming article before it settles. It must continue from its current on-screen position without a jump.
- **Feel check**: repeatedly swipe at the oldest/newest boundary. The article must resist/restore and never fully disappear.
- **Feel check**: throttle the articles request, reach a pagination boundary, and retry while loading. Only one article navigation may commit and the eventual incoming article must animate exactly once.
- **Feel check**: enable reduced motion. The content must cross-fade for `200ms` without horizontal movement.
- **Feel check**: inspect at 10% playback speed and confirm the two panes remain exactly adjacent and opacity changes stay synchronized.
- **Done when**: valid flicks and deliberate drags navigate reliably; outgoing/incoming surfaces move as one continuous track; interruption starts from the presentation value; pagination cannot clear or duplicate the pending transition; reduced motion and keyboard behavior remain correct.
