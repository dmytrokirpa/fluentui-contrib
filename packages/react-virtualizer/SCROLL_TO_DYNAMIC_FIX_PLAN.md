# ScrollTo Dynamic Items - Investigation & Fix Plan

## Executive Summary

The `scrollTo` functionality in `VirtualizerScrollViewDynamic` has fundamental issues when dealing with:

1. **Unmounted items** - Items that haven't been rendered yet use estimated heights
2. **Dynamic content** - Items that change height after rendering (lazy images, embeds, async content)

This document outlines the root causes and proposes solutions.

---

## Problem Investigation

### Problem 1: Inaccurate Position Calculation for Unmounted Items

#### Root Cause

When `scrollTo(index)` is called, the `scrollToItemDynamic` function calculates the scroll position:

```typescript
// From: imperativeScrollingDynamic.ts
let itemDepth = 0;
for (let i = 0; i < index; i++) {
  itemDepth += getItemSize(i) + gap;
}
```

The `getItemSize` function either:

1. Uses user-provided `props.getItemSize` callback
2. Or uses auto-generated `getChildSizeAuto` that reads from `sizeTrackingArray`

**The Issue**: For items that haven't been measured yet (not in DOM), `sizeTrackingArray` contains the default `itemSize` value (initial estimate), not the actual measured size.

**Example Scenario**:

- Default `itemSize` = 100px
- Actual item sizes after measurement = 150-400px
- Scrolling to item #50 means calculating: 50 × 100px = 5000px
- But real position might be: sum of actual sizes ≈ 12,000px
- Result: **Wrong item in viewport**

#### Location in Code

```
packages/react-virtualizer/src/components/VirtualizerScrollViewDynamic/useVirtualizerScrollViewDynamic.tsx
├── sizeTrackingArray (line 38-40) - initialized with default itemSize
├── getChildSizeAuto (line 42-54) - returns default if not measured
└── scrollTo (line 132-157) - uses getChildSizeAuto for position calculation

packages/react-virtualizer/src/utilities/ImperativeScrolling/imperativeScrollingDynamic.ts
└── scrollToItemDynamic (lines 1-47) - calculates position using getItemSize
```

---

### Problem 2: Dynamic Height Changes After Scroll

#### Root Cause

Even if we somehow scroll to the correct position initially:

1. Elements before the target continue loading (images, lazy content, embeds)
2. When they grow, `useMeasureList` detects size changes via `ResizeObserver`
3. The `handleIndexUpdate` function is called and may trigger `requestScrollBy`
4. However, the scroll compensation logic has issues

**Current Scroll Anchor Logic** (from `useMeasureList.ts:64-74`):

```typescript
const sizeDifference = containerSize - sizeTrackingArray.current[index];
if (sizeDifference !== 0) {
  const itemPosition = boundClientRect.bottom - SCROLL_ALLOWANCE;
  if (axis === 'vertical' && itemPosition <= sizeDifference) {
    requestScrollBy?.(sizeDifference);
  }
}
```

**Issues with this logic**:

1. Only compensates when `itemPosition <= sizeDifference` - this seems incorrect
2. Uses `boundClientRect.bottom - 100` for position check - arbitrary constant
3. Doesn't account for which items are above vs below the target
4. Only works when `enableScrollAnchor` is explicitly set to `true`

#### The "Push Out" Effect

When scrolling to item #50:

1. Item #50 enters viewport ✅
2. Callback fires: "Reached index: 50" ✅ (but premature!)
3. Items #0-#49 continue loading and growing
4. Item #50 gets pushed down and exits viewport ❌
5. User sees wrong item

---

### Problem 3: Callback Fires Too Early

#### Root Cause

The callback mechanism in `useVirtualizer.ts:612-623`:

```typescript
React.useEffect(() => {
  if (!onRenderedFlaggedIndex || flaggedIndex.current === null) {
    return;
  }
  if (actualIndex <= flaggedIndex.current && actualIndex + virtualizerLength >= flaggedIndex.current) {
    onRenderedFlaggedIndex(flaggedIndex.current);
    flaggedIndex.current = null;
  }
}, [actualIndex, onRenderedFlaggedIndex, virtualizerLength]);
```

**The Problem**: The callback fires when the item is **rendered** (in DOM), not when:

1. The scroll animation completes
2. The item is actually **visible** in the viewport
3. The item is **stable** (no more size changes happening above it)

---

### Problem 4: Smooth Scrolling + Dynamic Content Conflict

When using `behavior: 'smooth'`:

1. Browser animates scroll over ~300-500ms
2. Content continues loading and sizes changing
3. Scroll anchor calls `scrollBy` to compensate
4. These operations conflict, causing erratic "jumping" behavior

**Note**: The story `ComplexDynamicList.stories.tsx` uses `'instant'` behavior as a workaround, with the comment:

> "Instant is safer in a dynamic environment (might move while scrolling there)"

---

## Proposed Solutions

### Solution A: Iterative Scroll with Position Correction (Recommended)

**Concept**: Instead of a single scroll, use an iterative approach that:

1. Scrolls to estimated position
2. Waits for items to render and measure
3. Recalculates and corrects position
4. Repeats until target is stable in viewport

```typescript
interface ScrollToOptions {
  index: number;
  behavior?: ScrollBehavior;
  callback?: (index: number) => void;
  // New options
  maxIterations?: number; // Default: 5, prevent infinite loops
  stabilityTimeout?: number; // Wait time for size stability, default: 100ms
  alignTo?: 'start' | 'center' | 'end'; // Where to position target in viewport
}

async function scrollToWithCorrection(options: ScrollToOptions): Promise<void> {
  const { index, maxIterations = 5, stabilityTimeout = 100 } = options;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    // 1. Calculate current estimated position
    const estimatedPosition = calculatePosition(index);

    // 2. Scroll to position (instant for correction phase)
    scrollViewRef.current?.scrollTo({
      top: estimatedPosition,
      behavior: iteration === 0 ? options.behavior : 'instant',
    });

    // 3. Wait for render and measurements
    await waitForRender();

    // 4. Wait for size stability (no ResizeObserver callbacks)
    await waitForSizeStability(stabilityTimeout);

    // 5. Check if target is correctly positioned
    const targetElement = getElementByIndex(index);
    if (isElementInDesiredPosition(targetElement, options.alignTo)) {
      // Success!
      options.callback?.(index);
      return;
    }

    // 6. Recalculate using now-measured sizes and continue
  }

  // Max iterations reached - call callback anyway with warning
  console.warn('ScrollTo: Max iterations reached, position may be approximate');
  options.callback?.(index);
}
```

**Pros**:

- Works with any content type
- Self-correcting
- Maintains accuracy even with highly dynamic content

**Cons**:

- More complex implementation
- Multiple scroll operations (though mostly instant)
- Slightly longer time to final position

---

### Solution B: Enhanced Scroll Anchoring for Target Element

**Concept**: After scrolling to target, actively monitor and maintain target position using a dedicated `ResizeObserver` that tracks all items above the target.

```typescript
function scrollToWithAnchor(index: number, callback?: (index: number) => void) {
  // 1. Initial scroll
  scrollToItemDynamic({ index, ... });

  // 2. Set up target anchoring
  const targetAnchor = new TargetElementAnchor({
    targetIndex: index,
    scrollContainer: scrollViewRef.current,
    sizeTrackingArray,
    onStabilized: () => {
      callback?.(index);
      targetAnchor.disconnect();
    },
    onSizeChangeAbove: (delta: number) => {
      // Compensate for size changes in items before target
      scrollViewRef.current?.scrollBy({
        top: delta,
        behavior: 'instant'
      });
    }
  });

  // 3. Auto-disconnect after timeout (fallback)
  setTimeout(() => targetAnchor.disconnect(), 10000);
}
```

**Pros**:

- Single scroll operation
- Maintains position during dynamic changes
- Can work with smooth scrolling

**Cons**:

- More complex observer management
- Resource overhead for tracking

---

### Solution C: Progressive Size Discovery Before Scroll

**Concept**: Before scrolling, progressively load and measure items to get accurate sizes.

```typescript
async function scrollToWithDiscovery(index: number) {
  const BATCH_SIZE = 20;

  // Progressively render and measure items in batches
  for (let start = 0; start < index; start += BATCH_SIZE) {
    const end = Math.min(start + BATCH_SIZE, index);

    // Temporarily expand virtualizer to include this batch
    await renderAndMeasureBatch(start, end);
  }

  // Now we have accurate sizes for all items 0 to index
  scrollToItemDynamic({ index, getItemSize: getAccurateSizeFromTracking });
}
```

**Pros**:

- Accurate first scroll
- Works with current architecture

**Cons**:

- High initial cost for distant targets
- May cause visible flickering as items briefly render
- Memory overhead

---

### Solution D: Hybrid Approach (Recommended for Implementation)

Combine the best aspects of A and B:

1. **Phase 1: Initial Scroll**

   - Use current position calculation
   - Scroll with specified behavior

2. **Phase 2: Active Monitoring**

   - Set up observer on items above target
   - Track cumulative size changes
   - Apply instant corrections

3. **Phase 3: Stability Check**

   - Wait for no size changes for N ms
   - Verify target is in correct viewport position
   - Fire callback

4. **Phase 4: Cleanup**
   - Disconnect observers
   - Clear internal state

---

### Critical Edge Case: Post-Scroll Content Growth

#### The Problem

Consider scrolling to the last item (index 999):

```
Timeline:
─────────────────────────────────────────────────────────────────────────────────
T=0s      T=2s           T=5s              T=8s              T=15s
│         │              │                 │                 │
▼         ▼              ▼                 ▼                 ▼
ScrollTo  Item 999       Callback fires    Items 0-998       Item 999
(999)     in viewport    "Reached 999"     start loading     pushed out
          via iteration  ✅                images            ❌
─────────────────────────────────────────────────────────────────────────────────
```

Even after successful iterative correction, items 0-998 may continue loading content for 10+ seconds, gradually pushing item 999 out of the viewport.

#### Solution: "Pin to Target" Mode

Instead of just reaching the target and stopping, we introduce a **target pinning** mechanism:

```typescript
interface TargetPinConfig {
  /** Target element index to pin */
  targetIndex: number;

  /** How long to maintain the pin (default: 10000ms) */
  pinDuration: number;

  /** Where to keep the target in viewport */
  alignment: 'start' | 'center' | 'end';

  /** Callback when content above grows */
  onContentShift?: (delta: number) => void;

  /** Events that should release the pin */
  releaseOn: ('userScroll' | 'timeout' | 'allContentLoaded')[];
}
```

#### How Target Pinning Works

```typescript
class TargetPinController {
  private targetIndex: number;
  private scrollContainer: HTMLElement;
  private resizeObserver: ResizeObserver;
  private sizeSnapshot: Map<number, number> = new Map();
  private isActive: boolean = true;

  constructor(config: TargetPinConfig) {
    // 1. Take initial snapshot of all item sizes
    this.snapshotCurrentSizes();

    // 2. Observe size changes on ALL items above target
    this.observeItemsAboveTarget();

    // 3. Set up user interaction detection
    this.detectUserScroll();

    // 4. Set up auto-release timeout
    setTimeout(() => this.release(), config.pinDuration);
  }

  private onItemResize(index: number, newSize: number) {
    if (!this.isActive || index >= this.targetIndex) return;

    const previousSize = this.sizeSnapshot.get(index) || 0;
    const delta = newSize - previousSize;

    if (delta !== 0) {
      // Compensate immediately to keep target in position
      this.scrollContainer.scrollBy({
        top: delta,
        behavior: 'instant',
      });

      // Update snapshot
      this.sizeSnapshot.set(index, newSize);
    }
  }

  private detectUserScroll() {
    let lastScrollTop = this.scrollContainer.scrollTop;
    let programmaticScrollPending = false;

    this.scrollContainer.addEventListener('scroll', () => {
      if (programmaticScrollPending) {
        programmaticScrollPending = false;
        return; // Ignore our own scrollBy calls
      }

      // User initiated scroll - release the pin
      this.release();
    });
  }

  release() {
    this.isActive = false;
    this.resizeObserver.disconnect();
    // Clean up other listeners
  }
}
```

#### Visual Representation

```
WITHOUT Target Pinning:                  WITH Target Pinning:
─────────────────────                    ─────────────────────
│ Item 0 (loading)  │                    │ Item 0 (loading)  │
│ Item 1 (loading)  │                    │ Item 1 (loading)  │
│      ...          │                    │      ...          │
│                   │                    │                   │
│ ┌───────────────┐ │                    │ ┌───────────────┐ │
│ │ VIEWPORT      │ │                    │ │ VIEWPORT      │ │
│ │               │ │                    │ │               │ │
│ │ Item 999  ────┼─┼── Target           │ │ Item 999  ────┼─┼── Target PINNED
│ │               │ │                    │ │               │ │
│ └───────────────┘ │                    │ └───────────────┘ │
─────────────────────                    ─────────────────────

After items 0-50 load images:            After items 0-50 load images:
─────────────────────                    ─────────────────────
│ Item 0 ██████████ │ +200px             │ Item 0 ██████████ │ +200px
│ Item 1 ██████████ │ +200px             │ Item 1 ██████████ │ +200px
│      ...          │                    │      ...          │
│                   │                    │ ┌───────────────┐ │
│ ┌───────────────┐ │                    │ │ VIEWPORT      │ │
│ │ VIEWPORT      │ │                    │ │               │ │ scrollTop += delta
│ │               │ │                    │ │ Item 999  ────┼─┼── Still pinned!
│ │ Item 990      │ │ ← Wrong item!      │ │               │ │
│ │               │ │                    │ └───────────────┘ │
│ └───────────────┘ │                    │                   │
│ Item 999          │ ← Pushed out       ─────────────────────
─────────────────────
```

#### Pin Release Conditions

The target pin should be released when:

1. **User scrolls manually** - User takes control, pin should not fight them
2. **Timeout expires** - Default 10 seconds, prevents indefinite resource usage
3. **All content loaded** - If we can detect no pending loads, release early
4. **Component unmounts** - Cleanup on navigation

```typescript
// Detecting user scroll vs programmatic scroll
let isProgrammaticScroll = false;

function compensateScroll(delta: number) {
  isProgrammaticScroll = true;
  scrollContainer.scrollBy({ top: delta, behavior: 'instant' });
  // Reset flag after scroll event fires
  requestAnimationFrame(() => {
    isProgrammaticScroll = false;
  });
}

scrollContainer.addEventListener('scroll', () => {
  if (!isProgrammaticScroll) {
    // This is user-initiated scroll
    releasePin();
  }
});
```

#### Integration with Solution D

The enhanced flow becomes:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              scrollTo(999)                                   │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ PHASE 1: Initial Scroll                                                      │
│ • Calculate position using available size data                               │
│ • Scroll to estimated position                                               │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ PHASE 2: Iterative Correction (max 5 iterations)                            │
│ • Wait for items to render                                                   │
│ • Check if target is in viewport                                            │
│ • If not, recalculate with measured sizes and scroll again                  │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ PHASE 3: Stability Wait                                                      │
│ • Wait for size changes to settle (no changes for 150ms)                    │
│ • Verify target is correctly positioned                                      │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ PHASE 4: Activate Target Pin (if maintainPosition: true)                    │
│ • Start observing all items above target                                    │
│ • Compensate for any size changes instantly                                 │
│ • Fire onComplete callback                                                  │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ PHASE 5: Pin Active (ongoing until release)                                 │
│ • Monitor size changes above target                                         │
│ • Apply instant scroll corrections                                          │
│ • Release on: user scroll | timeout (10s) | all content loaded              │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ PHASE 6: Cleanup                                                            │
│ • Disconnect observers                                                       │
│ • Clear internal state                                                       │
│ • Fire onPinReleased callback (optional)                                    │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### API Update for Target Pinning

```typescript
export interface EnhancedScrollToOptions {
  index: number;
  behavior?: ScrollBehavior;

  // Existing options...
  onComplete?: (index: number) => void;
  align?: 'start' | 'center' | 'end' | 'nearest';
  maxCorrections?: number;
  stabilityTimeout?: number;
  timeout?: number;

  // NEW: Target pinning options
  /**
   * Keep target pinned in viewport even as content above loads.
   * Default: false (for backwards compatibility)
   * Recommended: true for dynamic content
   */
  maintainPosition?: boolean;

  /**
   * How long to maintain the pin in ms.
   * Default: 10000 (10 seconds)
   * Set to Infinity for permanent pin (until user scroll)
   */
  pinDuration?: number;

  /**
   * Called when pin is released.
   * Useful for UI feedback (e.g., showing "position may have changed" toast)
   */
  onPinReleased?: (reason: 'userScroll' | 'timeout' | 'contentStable') => void;
}
```

#### Performance Considerations

Observing all items above the target could be expensive for large lists. Optimizations:

1. **Only observe mounted items** - Items not in DOM don't change size
2. **Batch corrections** - Use `requestAnimationFrame` to batch multiple size changes
3. **Debounce stability detection** - Don't check too frequently

```typescript
// Efficient observation: only observe items currently in virtualizer
const observeRange = {
  start: virtualizerStartIndex,
  end: Math.min(targetIndex, virtualizerStartIndex + virtualizerLength),
};

// As virtualizer scrolls, update observed range
onVirtualizerIndexChange((newStartIndex) => {
  updateObservedRange(newStartIndex, targetIndex);
});
```

---

## Implementation Plan

### Phase 1: Create Core Infrastructure (Priority: High)

1. **Create `useScrollToTarget` hook**

   - Manages scroll-to-index state
   - Handles iterative correction
   - Provides stability detection

2. **Create `TargetAnchorObserver` class**

   - Tracks size changes in items above target
   - Calculates cumulative deltas
   - Triggers scroll corrections

3. **Enhance `ScrollToInterface`**
   ```typescript
   export type ScrollToInterface = {
     scrollTo: (index: number, behavior?: ScrollBehavior, callback?: (index: number) => void) => void;
     // New method with enhanced options
     scrollToEnhanced: (options: EnhancedScrollToOptions) => Promise<void>;
     // ... existing methods
   };
   ```

### Phase 2: Update Scroll Anchoring (Priority: High)

1. **Fix `useMeasureList` scroll anchor logic**

   - Correct the `itemPosition <= sizeDifference` condition
   - Add proper above/below target detection
   - Make anchor aware of active scroll-to operations

2. **Add target-specific anchoring mode**
   - When scrollTo is active, anchor specifically to target element
   - Track only items above target for compensation

### Phase 3: Improve Callback Timing (Priority: Medium)

1. **Add stability detection to callback**

   - Don't fire callback immediately on render
   - Wait for size stability
   - Verify element position in viewport

2. **Add visibility verification**
   - Use `IntersectionObserver` to verify target is visible
   - Consider viewport position (start/center/end)

### Phase 4: Documentation & Testing (Priority: Medium)

1. **Update stories**

   - Add comprehensive test cases
   - Document behavior differences
   - Provide migration guidance

2. **Add unit/integration tests**
   - Test with various dynamic content scenarios
   - Test edge cases (first item, last item, rapid scrolling)

---

## API Changes

### New `EnhancedScrollToOptions` Interface

```typescript
export interface EnhancedScrollToOptions {
  /** Target index to scroll to */
  index: number;

  /** Scroll behavior - 'instant' recommended for dynamic content */
  behavior?: ScrollBehavior;

  /** Called when target is stable in viewport */
  onComplete?: (index: number) => void;

  /** Called if scroll fails or times out */
  onError?: (error: ScrollToError) => void;

  /** Where to position target in viewport */
  align?: 'start' | 'center' | 'end' | 'nearest';

  /** Maximum correction iterations (default: 5) */
  maxCorrections?: number;

  /** Time to wait for size stability in ms (default: 150) */
  stabilityTimeout?: number;

  /** Maximum total time for scroll operation in ms (default: 5000) */
  timeout?: number;

  /** Whether to maintain position during subsequent size changes (default: false) */
  maintainPosition?: boolean;
}

export interface ScrollToError {
  code: 'TIMEOUT' | 'MAX_ITERATIONS' | 'ELEMENT_NOT_FOUND';
  message: string;
  lastKnownPosition?: number;
}
```

### Backward Compatibility

The existing `scrollTo(index, behavior, callback)` API will remain unchanged but will internally use the enhanced logic with sensible defaults.

---

## Files to Modify

1. `packages/react-virtualizer/src/utilities/ImperativeScrolling/imperativeScrollingDynamic.ts`

   - Add iterative correction logic
   - Add stability detection

2. `packages/react-virtualizer/src/hooks/useMeasureList.ts`

   - Fix scroll anchor condition
   - Add target-aware anchoring

3. `packages/react-virtualizer/src/components/VirtualizerScrollViewDynamic/useVirtualizerScrollViewDynamic.tsx`

   - Integrate enhanced scroll-to logic
   - Update callback timing

4. `packages/react-virtualizer/src/utilities/ImperativeScrolling/imperativeScrolling.types.ts`

   - Add new type definitions (`EnhancedScrollToOptions`, `TargetPinConfig`, etc.)

5. **New files**:
   - `packages/react-virtualizer/src/hooks/useScrollToTarget.ts` - Main hook for enhanced scrollTo
   - `packages/react-virtualizer/src/utilities/TargetPinController.ts` - Manages target pinning after scroll
   - `packages/react-virtualizer/src/utilities/ScrollStabilityDetector.ts` - Detects when sizes stop changing

---

## Testing Strategy

### Unit Tests

1. Position calculation accuracy with mixed measured/estimated sizes
2. Stability detection timing
3. Correction iteration limits
4. Callback timing verification

### Integration Tests

1. Scroll to item with lazy-loading images
2. Scroll to item during active content loading
3. Rapid successive scroll-to operations
4. Scroll during window resize

### Manual Testing Scenarios (Stories)

1. Scroll to distant item (index 500+) with variable heights
2. Scroll while content is actively loading
3. Scroll with `behavior: 'smooth'` vs `'instant'`
4. Scroll and verify target stays visible for 10+ seconds during loading

---

## Risks & Mitigations

| Risk                        | Impact | Mitigation                                                    |
| --------------------------- | ------ | ------------------------------------------------------------- |
| Performance regression      | Medium | Use requestAnimationFrame for corrections, debounce observers |
| Breaking existing behavior  | High   | Keep existing API, add new enhanced method                    |
| Infinite correction loops   | Medium | Hard limit on iterations, timeout fallback                    |
| Memory leaks from observers | Medium | Automatic cleanup, timeout-based disconnection                |

---

## Timeline Estimate

| Phase                            | Duration      | Dependencies |
| -------------------------------- | ------------- | ------------ |
| Phase 1: Core Infrastructure     | 3-4 days      | None         |
| Phase 2: Scroll Anchoring        | 2-3 days      | Phase 1      |
| Phase 3: Callback Timing         | 1-2 days      | Phase 1-2    |
| Phase 4: Documentation & Testing | 2-3 days      | Phase 1-3    |
| **Total**                        | **8-12 days** |              |

---

## Open Questions for Discussion

1. **Should we deprecate the old `scrollTo` signature?**

   - Proposal: Keep it as-is, but have it use enhanced logic internally

2. **Default behavior for `maintainPosition`?**

   - Keeping it on by default could have performance implications
   - Keeping it off means existing problem persists for some use cases

3. **How to handle scroll-to during another scroll-to?**

   - Cancel previous operation?
   - Queue operations?
   - Throw error?

4. **Should stability timeout be adaptive?**
   - Could analyze size change velocity to determine when "stable"
   - More complex but potentially faster resolution

---

## Next Steps

1. [ ] Review and discuss this plan
2. [ ] Decide on Solution D implementation details
3. [ ] Create technical design for new hooks/utilities
4. [ ] Begin Phase 1 implementation
5. [ ] Iterative testing with complex story scenarios

---

## Deep Investigation: Why Problem 2 Persists After Implementation

### Investigation Date: December 2024

After implementing `useScrollToDynamicController` with iterative corrections and anchor adjustments, the target element still gets pushed out of the viewport when items above it grow. This investigation documents the root causes.

---

### Current Implementation Overview

The `useScrollToDynamicController` hook was created to handle:

1. Iterative scroll corrections until target is aligned
2. Anchor adjustments when items above the target resize
3. Stability detection before finalizing the operation

The flow is:

1. `start()` → initial scroll via `performScroll()`
2. `handleItemMeasured()` receives callbacks from `useMeasureList` when items resize
3. Anchor adjustments are batched via `scheduleAnchorAdjustment()`
4. Operation finalizes when target is stable for N iterations

---

### Root Cause Analysis

#### Issue 1: Dual Scroll Compensation Systems Conflict

There are **two independent scroll compensation systems** operating simultaneously:

**System A: `useMeasureList` built-in scroll anchor (lines 74-88)**

```typescript
// useMeasureList.ts
const isAboveViewport = scrollContainerRect
  ? isVertical
    ? boundClientRect.bottom <= scrollContainerRect.top + VIEWPORT_TOLERANCE
    : boundClientRect.right <= scrollContainerRect.left + VIEWPORT_TOLERANCE
  : ...;

if (sizeDifference !== 0 && isAboveViewport) {
  requestScrollBy?.(sizeDifference);  // <-- Direct scrollBy call
}
```

**System B: `useScrollToDynamicController` anchor adjustments**

```typescript
// useScrollToDynamicController.ts - handleItemMeasured
if (active.status === 'stable') {
  if (active.maintainPosition && index < active.targetIndex && delta !== 0) {
    applyScrollByDelta(active, delta); // <-- Another scrollBy call
  }
  return;
}
```

**The Problem**: When an item above the target resizes:

1. `useMeasureList.handleIndexUpdate()` fires
2. It calls `onItemMeasured()` → goes to controller's `handleItemMeasured()`
3. It ALSO calls `requestScrollBy()` if `isAboveViewport` is true
4. The controller's `handleItemMeasured()` may ALSO call `applyScrollByDelta()`
5. Result: **Double compensation** or **conflicting compensation**

#### Issue 2: `isAboveViewport` Check is Incorrect for ScrollTo Operations

The `useMeasureList` check for `isAboveViewport`:

```typescript
const isAboveViewport = scrollContainerRect
  ? boundClientRect.bottom <= scrollContainerRect.top + VIEWPORT_TOLERANCE
  : ...;
```

This checks if the **resizing element** is above the viewport top. But during a scrollTo operation:

- The **target element** might be at viewport top
- Items between viewport top and target are NOT "above viewport" by this definition
- But they ARE "above target" and should trigger compensation

**Example Scenario**:

```
Viewport:
┌─────────────────────┐ ← scrollContainerRect.top
│ Item 95 (resizing)  │ ← NOT above viewport, so no requestScrollBy!
│ Item 96             │
│ Item 97             │
│ Item 98             │
│ Item 99 (TARGET)    │ ← Target gets pushed down
└─────────────────────┘
```

When Item 95 grows, it's NOT above the viewport (it's visible), so `useMeasureList` doesn't call `requestScrollBy()`. But the controller's `handleItemMeasured()` should compensate because Item 95 is above the target (99).

**However**, the controller only receives the callback AFTER `useMeasureList` has already updated `sizeTrackingArray`. The timing creates race conditions.

#### Issue 3: Timing Race Between Measurement and Scroll

The measurement flow has a critical timing issue:

```
Timeline:
─────────────────────────────────────────────────────────────────
T0: ResizeObserver fires for Item 95
T1: useMeasureList.handleIndexUpdate() runs
    - Calculates sizeDifference
    - Calls onItemMeasured(95, newSize, delta)  ← Controller receives this
    - Updates sizeTrackingArray[95] = newSize   ← Array updated!
    - Calls requestScrollBy() if isAboveViewport
T2: Controller's handleItemMeasured() runs
    - Checks active.status
    - Calls scheduleAnchorAdjustment(delta)
T3: requestAnimationFrame fires for anchor adjustment
    - Reads current scroll position
    - Applies scrollBy(delta)
─────────────────────────────────────────────────────────────────
```

**The Problem**: Between T1 and T3, the browser may have already reflowed the layout based on the new size. The scroll position may have already shifted, and our delayed `scrollBy()` may over-correct or under-correct.

#### Issue 4: `scheduleAnchorAdjustment` Batching Loses Deltas

The anchor adjustment batching:

```typescript
const scheduleAnchorAdjustment = React.useCallback(
  (operation: ScrollOperation, delta: number) => {
    operation.pendingAnchorDelta += delta;

    if (operation.anchorFrameId !== null) {
      return;  // Already scheduled, just accumulate
    }

    // Schedule new frame...
    operation.anchorFrameId = requestAnchorFrame(() => {
      commitAnchor();
    });
  },
  [...]
);
```

**The Problem**: If multiple items resize in quick succession:

1. Item 95 resizes: `pendingAnchorDelta = 50`, frame scheduled
2. Item 96 resizes: `pendingAnchorDelta = 100`, frame already scheduled (returns early)
3. Item 97 resizes: `pendingAnchorDelta = 150`, frame already scheduled (returns early)
4. Frame fires: applies 150px adjustment
5. **But** by now, browser may have reflowed multiple times, and 150px may not be accurate

The batching assumes deltas are additive and stable, but browser reflow timing makes this unreliable.

#### Issue 5: Controller Doesn't Know About `requestScrollBy` Calls

The `useVirtualizerScrollViewDynamic` passes `requestScrollBy` to `useMeasureList`:

```typescript
const requestScrollBy = React.useCallback(
  (sizeChange: number) => {
    if (enableScrollAnchor) {
      localScrollRef.current?.scrollBy({
        top: axis === 'vertical' ? sizeChange : 0,
        left: axis === 'vertical' ? 0 : sizeChange,
        behavior: 'instant',
      });
    }
  },
  [enableScrollAnchor, axis, localScrollRef]
);
```

This `scrollBy` call happens OUTSIDE the controller's knowledge. The controller:

- Doesn't know a scroll happened
- May interpret the scroll position change as misalignment
- May try to "correct" what was actually a valid compensation

#### Issue 6: `enableScrollAnchor` Creates Ambiguity

The `enableScrollAnchor` prop controls TWO things:

1. Whether `useMeasureList` calls `requestScrollBy()` for items above viewport
2. Whether `useScrollToDynamicController` uses `maintainPosition`

```typescript
// useVirtualizerScrollViewDynamic.tsx
const maintainPosition = enableScrollAnchor !== false;
```

When `enableScrollAnchor` is true:

- `useMeasureList` compensates for items above viewport
- Controller ALSO compensates for items above target
- Result: potential double compensation

When `enableScrollAnchor` is false:

- `useMeasureList` doesn't compensate
- Controller doesn't compensate (`maintainPosition = false`)
- Result: target drifts with no compensation

**There's no mode where ONLY the controller compensates.**

---

### Specific Failure Scenarios

#### Scenario A: Item Visible in Viewport Grows

```
State: Target #99 is at viewport top, items #95-#98 visible below
Action: Item #97 grows by 100px
Expected: Viewport stays at same position (target stays at top)
Actual:
  1. useMeasureList sees #97 is NOT above viewport
  2. requestScrollBy() is NOT called
  3. Controller receives delta=100 for index=97
  4. Controller sees 97 < 99 (target), calls scheduleAnchorAdjustment(100)
  5. But browser already reflowed, target may have shifted
  6. Anchor adjustment may over/under-correct
```

#### Scenario B: Multiple Items Resize Simultaneously

```
State: Scrolling to #99, items #90-#95 are loading images
Action: Items #90, #91, #92 all resize within 16ms
Expected: Single combined adjustment
Actual:
  1. #90 resize → handleItemMeasured(90, _, 50) → pendingDelta=50, frame scheduled
  2. #91 resize → handleItemMeasured(91, _, 60) → pendingDelta=110, frame pending
  3. #92 resize → handleItemMeasured(92, _, 40) → pendingDelta=150, frame pending
  4. Frame fires → scrollBy(150)
  5. But useMeasureList may have ALSO called requestScrollBy for some items
  6. Result: over-correction, target pushed past viewport top
```

#### Scenario C: Rapid Resize During Stability Check

```
State: Controller thinks target is stable, about to finalize
Action: Item #80 suddenly grows (lazy image loads)
Expected: Compensation keeps target in place
Actual:
  1. stabilityCheck runs, sees target aligned
  2. Item #80 resize fires
  3. Controller already called finalizeOperation()
  4. handleItemMeasured sees status='stable', calls applyScrollByDelta()
  5. But operation is being torn down
  6. Race condition between finalization and compensation
```

---

### Proposed Fixes

#### Fix 1: Disable `useMeasureList` Scroll Compensation During Active ScrollTo

When a scrollTo operation is active, `useMeasureList` should NOT call `requestScrollBy()`. The controller should be the sole source of scroll compensation.

```typescript
// Option A: Add flag to useMeasureList
useMeasureList({
  ...
  disableScrollCompensation: isScrollToActive,
});

// Option B: Make requestScrollBy a no-op during scrollTo
const requestScrollBy = React.useCallback(
  (sizeChange: number) => {
    if (isScrollToOperationActive.current) {
      return; // Controller handles this
    }
    if (enableScrollAnchor) {
      localScrollRef.current?.scrollBy(...);
    }
  },
  [...]
);
```

#### Fix 2: Synchronous Scroll Compensation Instead of Batched

Instead of batching deltas across frames, apply compensation immediately:

```typescript
const handleItemMeasured = React.useCallback(
  (index: number, _size: number, delta: number) => {
    if (active.status === 'stable' && active.maintainPosition && index < active.targetIndex && delta !== 0) {
      // Apply IMMEDIATELY, not batched
      applyScrollByDelta(active, delta);
    }
    // ...
  },
  [...]
);
```

This ensures compensation happens in the same frame as the resize, before browser reflow.

#### Fix 3: Use `scrollTop` Adjustment Instead of `scrollBy`

Instead of calling `scrollBy()` which may conflict with ongoing operations:

```typescript
const applyScrollByDelta = (operation, delta) => {
  const scrollView = scrollViewRef.current;
  if (!scrollView) return;

  // Direct property manipulation is synchronous
  scrollView.scrollTop += reversed ? -delta : delta;

  // Mark as programmatic to prevent user-scroll detection
  operation.isProgrammaticScroll = true;
  requestAnimationFrame(() => {
    operation.isProgrammaticScroll = false;
  });
};
```

#### Fix 4: Coordinate Both Systems Through Single Source of Truth

Create a shared state that both `useMeasureList` and `useScrollToDynamicController` can read:

```typescript
type ScrollCompensationState = {
  isScrollToActive: boolean;
  targetIndex: number | null;
  compensationMode: 'useMeasureList' | 'controller' | 'none';
};

// useMeasureList checks:
if (compensationState.compensationMode === 'useMeasureList') {
  requestScrollBy(sizeDifference);
}

// Controller checks:
if (compensationState.compensationMode === 'controller') {
  applyScrollByDelta(delta);
}
```

#### Fix 5: Use MutationObserver for More Reliable Size Tracking

ResizeObserver callbacks may be batched by the browser. Consider using MutationObserver on the scroll container's `scrollHeight` for more immediate detection:

```typescript
const mutationObserver = new MutationObserver(() => {
  const newHeight = scrollContainer.scrollHeight;
  const delta = newHeight - lastKnownHeight;
  if (delta !== 0 && isScrollToActive) {
    // Compensate immediately
    scrollContainer.scrollTop += delta;
    lastKnownHeight = newHeight;
  }
});

mutationObserver.observe(scrollContainer, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['style', 'class'],
});
```

---

### Recommended Implementation Order

1. **Immediate**: Disable `useMeasureList` scroll compensation during active scrollTo operations (Fix 1)
2. **Short-term**: Switch to synchronous compensation (Fix 2 + Fix 3)
3. **Medium-term**: Implement shared compensation state (Fix 4)
4. **Long-term**: Evaluate MutationObserver approach for edge cases (Fix 5)

---

### Test Cases to Verify Fix

1. **Single item growth**: Scroll to #99, item #50 grows by 200px → target stays at viewport top
2. **Multiple simultaneous growth**: Scroll to #99, items #80-#90 all grow within 100ms → target stays stable
3. **Visible item growth**: Scroll to #99 (at viewport top), item #97 (visible) grows → no viewport jump
4. **Growth during stability check**: Scroll to #99, wait for "stable", item #30 grows → target compensated
5. **Rapid growth cascade**: Scroll to #99, items #0-#50 grow in sequence over 5 seconds → target stays pinned
