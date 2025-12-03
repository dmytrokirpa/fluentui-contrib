import * as React from 'react';
import { useTimeout, useAnimationFrame } from '@fluentui/react-utilities';

import { scrollToItemDynamic } from '../Utilities';
import type { ScrollToItemDynamicParams } from '../Utilities';

/**
 * Reference object for measured elements, keyed by index string.
 */
type MeasureRefObject = React.MutableRefObject<{
  [key: string]: (HTMLElement & { handleResize?: () => void }) | null;
}>;

/**
 * Parameters for configuring the scroll-to-dynamic controller.
 */
type ScrollToDynamicControllerParams = {
  /** Scroll axis direction */
  axis: 'horizontal' | 'vertical';
  /** Whether the scroll direction is reversed */
  reversed?: boolean;
  /** Gap between items in pixels */
  gap: number;
  /** Reference to the scrollable container element */
  scrollViewRef: React.RefObject<HTMLDivElement | null>;
  /** Function to get the size of an item at a given index */
  getItemSize: (index: number) => number;
  /** Function to get the total size of all items */
  getTotalSize: () => number;
  /** Optional function to get the offset for a specific index */
  getOffsetForIndex?: (index: number) => number | null | undefined;
  /** Reference object containing measured elements */
  measureRefObject: MeasureRefObject;
  /** Whether to maintain scroll position when items above the target resize */
  maintainPosition?: boolean;
  /** Maximum number of correction attempts */
  maxCorrections?: number;
  /** Timeout in milliseconds between stability checks */
  stabilityTimeout?: number;
  /** Duration in milliseconds to keep the target pinned after alignment */
  pinDuration?: number;
  /** Callback to set a flagged index for rendering */
  setFlaggedIndex?: (index: number | null) => void;
  /** Callback invoked when the scroll operation completes successfully */
  onOperationComplete?: (index: number) => void;
  /** Callback invoked when the scroll operation is cancelled */
  onOperationCancel?: (index: number, reason: 'user' | 'cancelled') => void;
  /** Callback invoked when the target pin is released (operation fully complete) */
  onPinReleased?: (index: number) => void;
};

/**
 * Controller interface for managing dynamic scroll-to operations.
 */
type ScrollToDynamicController = {
  /** Initiates a scroll operation to the specified index */
  start: (
    index: number,
    behavior: ScrollBehavior,
    callback?: (index: number) => void
  ) => void;
  /** Handles when an item's size is measured or changes */
  handleItemMeasured: (index: number, size: number, delta: number) => void;
  /** Handles when the target item is rendered in the DOM */
  handleRendered: (index: number) => boolean;
  /** Cancels the current scroll operation */
  cancel: () => void;
  /** Returns true if a scroll operation is currently active */
  isActive: () => boolean;
};

/** Handle for timeout operations */
type TimeoutHandle = number;

/**
 * Internal state for an active scroll-to operation.
 */
type ScrollOperation = {
  /** Unique identifier for this operation */
  id: number;
  /** Target item index to scroll to */
  targetIndex: number;
  /** Scroll behavior (smooth, instant, etc.) */
  behavior: ScrollBehavior;
  /** Optional callback to invoke when operation completes */
  callback?: (index: number) => void;
  /** Number of correction attempts remaining */
  correctionsRemaining: number;
  /** Whether a correction is currently pending */
  pendingCorrection: boolean;
  /** Timeout ID for stability checks */
  stabilityTimeoutId: TimeoutHandle | null;
  /** Timeout ID for pin duration */
  pinTimeoutId: TimeoutHandle | null;
  /** Animation frame ID for scheduled corrections */
  scheduleFrameId: number | null;
  /** Current status of the operation */
  status: 'initial' | 'correcting' | 'stable';
  /** Whether to maintain position when items resize */
  maintainPosition: boolean;
  /** Whether the target is currently pinned */
  isPinned: boolean;
  /** Whether the current scroll is programmatic (not user-initiated) */
  isProgrammaticScroll: boolean;
  /** Timestamp of the last measurement */
  lastMeasurementTimestamp: number;
  /** Whether the target item has been measured */
  hasMeasuredTarget: boolean;
  /** Number of stable iterations remaining before finalization */
  stableIterations: number;
  /** Accumulated delta for anchor adjustments */
  pendingAnchorDelta: number;
  /** Animation frame ID for anchor adjustments */
  anchorFrameId: number | null;
  /** Whether initial alignment has been performed */
  initialAlignmentPerformed: boolean;
};

/** Default maximum number of correction attempts */
const DEFAULT_MAX_CORRECTIONS = 10;
/** Default timeout in milliseconds between stability checks */
const DEFAULT_STABILITY_TIMEOUT = 150;
/** Default pin duration (infinite by default) */
const DEFAULT_PIN_DURATION = Number.POSITIVE_INFINITY;
/** Pixel tolerance for viewport alignment */
const VIEWPORT_TOLERANCE = 1;
/** Number of stable iterations required before finalization */
const DEFAULT_CORRECTION_SETTLE = 2;
/** Minimum delta threshold for anchor adjustments */
const ANCHOR_DELTA_EPSILON = 0.25;

/**
 * Hook for managing scroll-to operations in dynamic virtualized lists.
 * Handles iterative corrections, stability checks, and position anchoring
 * when items have dynamic heights that change after rendering.
 *
 * @returns Controller with methods to start, handle measurements, and cancel scroll operations
 */
export function useScrollToDynamicController({
  axis,
  reversed,
  gap,
  scrollViewRef,
  getItemSize,
  getTotalSize,
  getOffsetForIndex,
  measureRefObject,
  maintainPosition = true,
  maxCorrections = DEFAULT_MAX_CORRECTIONS,
  stabilityTimeout = DEFAULT_STABILITY_TIMEOUT,
  pinDuration = DEFAULT_PIN_DURATION,
  setFlaggedIndex,
  onOperationComplete,
  onOperationCancel,
  onPinReleased,
}: ScrollToDynamicControllerParams): ScrollToDynamicController {
  const operationRef = React.useRef<ScrollOperation | null>(null);
  const scrollListenerRef = React.useRef<((event: Event) => void) | null>(null);
  const operationIdRef = React.useRef(0);
  const scheduleCorrectionRef = React.useRef<
    ((operation: ScrollOperation) => void) | null
  >(null);
  const scheduleStabilityCheckRef = React.useRef<
    ((operation: ScrollOperation) => void) | null
  >(null);

  const scheduleCorrection = React.useCallback((operation: ScrollOperation) => {
    scheduleCorrectionRef.current?.(operation);
  }, []);

  const scheduleStabilityCheck = React.useCallback(
    (operation: ScrollOperation) => {
      scheduleStabilityCheckRef.current?.(operation);
    },
    []
  );

  const [setStabilityTimeoutFn, clearStabilityTimeoutFn] = useTimeout();
  const [setPinTimeoutFn, clearPinTimeoutFn] = useTimeout();
  const [setAnchorTimeoutFn, clearAnchorTimeoutFn] = useTimeout();

  const [requestProgrammaticFrame] = useAnimationFrame();
  const [requestCorrectionFrame, cancelCorrectionFrame] = useAnimationFrame();
  const [requestAnchorFrame, cancelAnchorFrameRequest] = useAnimationFrame();

  /**
   * Gets the default view (window) from the scroll view's document or globalThis.
   * Used for accessing browser APIs like requestAnimationFrame and setTimeout.
   */
  const getDefaultView = React.useCallback(() => {
    const doc = scrollViewRef.current?.ownerDocument;
    if (doc?.defaultView) {
      return doc.defaultView;
    }
    if (typeof globalThis !== 'undefined') {
      return globalThis as Window & typeof globalThis;
    }
    return undefined;
  }, [scrollViewRef]);

  const clearStabilityTimeout = React.useCallback(
    (operation: ScrollOperation) => {
      if (operation.stabilityTimeoutId === null) {
        return;
      }

      clearStabilityTimeoutFn();
      operation.stabilityTimeoutId = null;
    },
    [clearStabilityTimeoutFn]
  );

  const clearPinTimeout = React.useCallback(
    (operation: ScrollOperation) => {
      if (operation.pinTimeoutId === null) {
        return;
      }

      clearPinTimeoutFn();
      operation.pinTimeoutId = null;
    },
    [clearPinTimeoutFn]
  );

  const cancelScheduledFrame = React.useCallback(
    (operation: ScrollOperation) => {
      if (operation.scheduleFrameId === null) {
        return;
      }

      cancelCorrectionFrame();
      operation.scheduleFrameId = null;
    },
    [cancelCorrectionFrame]
  );

  const cancelAnchorFrame = React.useCallback(
    (operation: ScrollOperation) => {
      if (operation.anchorFrameId === null) {
        return;
      }

      cancelAnchorFrameRequest();
      clearAnchorTimeoutFn();

      operation.anchorFrameId = null;
      operation.pendingAnchorDelta = 0;
    },
    [cancelAnchorFrameRequest, clearAnchorTimeoutFn]
  );

  const detachScrollListener = React.useCallback(() => {
    const listener = scrollListenerRef.current;
    const scrollView = scrollViewRef.current;

    if (listener && scrollView) {
      scrollView.removeEventListener('scroll', listener);
    }
    scrollListenerRef.current = null;
  }, [scrollViewRef]);

  /**
   * Clears the current operation, cancelling all timers and cleaning up state.
   */
  const clearOperation = React.useCallback(
    (reason?: 'user' | 'cancelled') => {
      const active = operationRef.current;
      if (!active) {
        return;
      }

      clearStabilityTimeout(active);
      clearPinTimeout(active);
      cancelScheduledFrame(active);
      cancelAnchorFrame(active);

      if (active.isPinned) {
        active.isPinned = false;
      }

      detachScrollListener();
      operationRef.current = null;
      setFlaggedIndex?.(null);

      if (reason && onOperationCancel) {
        onOperationCancel(active.targetIndex, reason);
      }
    },
    [
      cancelScheduledFrame,
      cancelAnchorFrame,
      clearPinTimeout,
      clearStabilityTimeout,
      detachScrollListener,
      onOperationCancel,
      setFlaggedIndex,
    ]
  );

  /**
   * Gets the DOM element for a given index from the measure ref object.
   */
  const getTargetElement = React.useCallback(
    (index: number) => {
      const element = measureRefObject.current[index.toString()];
      return element ?? null;
    },
    [measureRefObject]
  );

  const ensureScrollListener = React.useCallback(() => {
    if (scrollListenerRef.current || !scrollViewRef.current) {
      return;
    }

    const listener = () => {
      const active = operationRef.current;
      if (!active) {
        return;
      }

      if (active.isProgrammaticScroll) {
        return;
      }

      // User-initiated scroll cancels the operation (including pinning)
      clearOperation('user');
    };

    scrollViewRef.current.addEventListener('scroll', listener, {
      passive: true,
    });
    scrollListenerRef.current = listener;
  }, [clearOperation, scrollViewRef]);

  /**
   * Evaluates whether the target element is properly aligned within the viewport.
   * Returns alignment status, deltas, and overflow information.
   */
  const evaluateTargetAlignment = React.useCallback(
    (index: number) => {
      const scrollView = scrollViewRef.current;
      const element = getTargetElement(index);

      if (!scrollView || !element) {
        return {
          elementExists: Boolean(element),
          aligned: false,
          startDelta: 0,
          endOverflow: 0,
        };
      }

      const elementRect = element.getBoundingClientRect();
      const containerRect = scrollView.getBoundingClientRect();

      const elementStart =
        axis === 'vertical' ? elementRect.top : elementRect.left;
      const containerStart =
        axis === 'vertical' ? containerRect.top : containerRect.left;
      const elementEnd =
        axis === 'vertical' ? elementRect.bottom : elementRect.right;
      const containerEnd =
        axis === 'vertical' ? containerRect.bottom : containerRect.right;

      const startDelta = elementStart - containerStart;
      const endOverflow = Math.max(0, elementEnd - containerEnd);

      const aligned =
        Math.abs(startDelta) <= VIEWPORT_TOLERANCE &&
        endOverflow <= VIEWPORT_TOLERANCE;

      return {
        elementExists: true,
        aligned,
        startDelta,
        endOverflow,
      };
    },
    [axis, getTargetElement, scrollViewRef]
  );

  const scheduleProgrammaticScrollReset = React.useCallback(
    (operation: ScrollOperation) => {
      requestProgrammaticFrame(() => {
        const active = operationRef.current;
        if (!active || active.id !== operation.id) {
          return;
        }

        active.isProgrammaticScroll = false;
      });
    },
    [operationRef, requestProgrammaticFrame]
  );

  /**
   * Applies an instant scroll adjustment by the specified delta.
   * Uses direct property manipulation for synchronous behavior to avoid
   * timing issues with browser reflow.
   */
  const applyScrollByDelta = React.useCallback(
    (operation: ScrollOperation, delta: number) => {
      const scrollView = scrollViewRef.current;
      if (!scrollView || delta === 0) {
        return;
      }

      const adjustedDelta = reversed ? -delta : delta;
      operation.isProgrammaticScroll = true;

      // Use direct property manipulation for synchronous scroll
      // This ensures the scroll happens immediately in the same frame
      if (axis === 'vertical') {
        scrollView.scrollTop += adjustedDelta;
      } else {
        scrollView.scrollLeft += adjustedDelta;
      }

      scheduleProgrammaticScrollReset(operation);
    },
    [axis, reversed, scheduleProgrammaticScrollReset, scrollViewRef]
  );

  /**
   * Schedules an anchor adjustment to maintain target position when items above resize.
   * Batches multiple deltas and applies them in a single frame to avoid jitter.
   */
  const scheduleAnchorAdjustment = React.useCallback(
    (operation: ScrollOperation, delta: number) => {
      operation.pendingAnchorDelta += delta;

      if (
        Math.abs(operation.pendingAnchorDelta) < ANCHOR_DELTA_EPSILON &&
        operation.anchorFrameId === null
      ) {
        return;
      }

      if (operation.anchorFrameId !== null) {
        return;
      }

      const commitAnchor = () => {
        const active = operationRef.current;
        if (!active || active.id !== operation.id) {
          return;
        }

        if (!active.hasMeasuredTarget) {
          active.anchorFrameId = null;
          scheduleAnchorAdjustment(active, 0);
          return;
        }

        const amount = active.pendingAnchorDelta;
        active.pendingAnchorDelta = 0;
        active.anchorFrameId = null;

        if (Math.abs(amount) >= ANCHOR_DELTA_EPSILON) {
          applyScrollByDelta(active, amount);
          active.stableIterations = DEFAULT_CORRECTION_SETTLE;
        }

        scheduleStabilityCheck(active);
      };

      const defaultView = getDefaultView();
      const canUseAnimationFrame =
        !!defaultView?.requestAnimationFrame &&
        !!defaultView?.cancelAnimationFrame;
      const canUseTimeout =
        !!defaultView?.setTimeout && !!defaultView?.clearTimeout;

      if (canUseAnimationFrame) {
        operation.anchorFrameId = requestAnchorFrame(() => {
          commitAnchor();
        });
        return;
      }

      if (canUseTimeout) {
        operation.anchorFrameId = setAnchorTimeoutFn(() => {
          commitAnchor();
        }, 0);
        return;
      }

      if (
        operation.hasMeasuredTarget &&
        Math.abs(operation.pendingAnchorDelta) >= ANCHOR_DELTA_EPSILON
      ) {
        const amount = operation.pendingAnchorDelta;
        operation.pendingAnchorDelta = 0;
        applyScrollByDelta(operation, amount);
        operation.stableIterations = DEFAULT_CORRECTION_SETTLE;
      }
      scheduleStabilityCheck(operation);
    },
    [
      applyScrollByDelta,
      getDefaultView,
      requestAnchorFrame,
      setAnchorTimeoutFn,
      scheduleStabilityCheck,
    ]
  );

  /**
   * Performs the actual scroll operation to the target index.
   * Uses optimized offset calculation when available, otherwise falls back to scrollToItemDynamic.
   */
  const performScroll = React.useCallback(
    (operation: ScrollOperation, behavior: ScrollBehavior) => {
      if (!reversed && axis === 'vertical' && getOffsetForIndex) {
        const offset = getOffsetForIndex(operation.targetIndex);
        if (offset !== undefined && offset !== null && isFinite(offset)) {
          const scrollView = scrollViewRef.current;
          if (scrollView) {
            operation.isProgrammaticScroll = true;
            scrollView.scrollTo({
              top: offset,
              behavior,
            });
            scheduleProgrammaticScrollReset(operation);
            return;
          }
        }
      }

      const params: ScrollToItemDynamicParams = {
        index: operation.targetIndex,
        getItemSize,
        totalSize: getTotalSize(),
        scrollViewRef,
        axis,
        reversed,
        behavior,
        gap,
      };

      scrollToItemDynamic(params);
    },
    [
      axis,
      gap,
      getItemSize,
      getTotalSize,
      reversed,
      scrollViewRef,
      getOffsetForIndex,
      scheduleProgrammaticScrollReset,
    ]
  );

  const releasePin = React.useCallback(
    (operation: ScrollOperation) => {
      if (!operation.isPinned) {
        return;
      }

      const targetIndex = operation.targetIndex;
      operation.isPinned = false;
      clearPinTimeout(operation);
      detachScrollListener();
      setFlaggedIndex?.(null);
      operationRef.current = null;
      onPinReleased?.(targetIndex);
    },
    [clearPinTimeout, detachScrollListener, setFlaggedIndex, onPinReleased]
  );

  const startPin = React.useCallback(
    (operation: ScrollOperation) => {
      if (!maintainPosition || operation.isPinned) {
        return;
      }

      operation.isPinned = true;
      ensureScrollListener();

      clearPinTimeout(operation);
      if (Number.isFinite(pinDuration)) {
        const timeoutId = setPinTimeoutFn(() => {
          const active = operationRef.current;
          if (!active || active.id !== operation.id) {
            return;
          }
          releasePin(active);
        }, pinDuration);
        if (timeoutId !== -1) {
          operation.pinTimeoutId = timeoutId;
        }
      }
    },
    [
      ensureScrollListener,
      maintainPosition,
      setPinTimeoutFn,
      pinDuration,
      releasePin,
    ]
  );

  /**
   * Finalizes a scroll operation, marking it as stable and optionally starting pinning.
   * Invokes completion callbacks and cleans up timers.
   */
  const finalizeOperation = React.useCallback(
    (operation: ScrollOperation) => {
      if (operation.status === 'stable') {
        return;
      }
      operation.status = 'stable';
      clearStabilityTimeout(operation);
      cancelScheduledFrame(operation);
      console.log('[VirtualizerScrollTo] finalize', operation.id, {
        target: operation.targetIndex,
        correctionsRemaining: operation.correctionsRemaining,
      });

      if (operation.callback) {
        operation.callback(operation.targetIndex);
      }

      onOperationComplete?.(operation.targetIndex);
      setFlaggedIndex?.(null);

      if (maintainPosition) {
        startPin(operation);
      } else {
        operationRef.current = null;
        detachScrollListener();
        onPinReleased?.(operation.targetIndex);
      }
    },
    [
      cancelScheduledFrame,
      clearStabilityTimeout,
      detachScrollListener,
      maintainPosition,
      onOperationComplete,
      onPinReleased,
      startPin,
      setFlaggedIndex,
    ]
  );

  scheduleStabilityCheckRef.current = (operation: ScrollOperation) => {
    if (!operation) {
      return;
    }

    clearStabilityTimeout(operation);
    const defaultView = getDefaultView();
    const canReschedule =
      !!defaultView?.setTimeout && !!defaultView?.clearTimeout;

    const runCheck = () => {
      const active = operationRef.current;
      if (!active || active.id !== operation.id) {
        return;
      }

      active.stabilityTimeoutId = null;

      const alignment = evaluateTargetAlignment(active.targetIndex);
      console.log('[VirtualizerScrollTo] stabilityCheck', active.id, {
        target: active.targetIndex,
        correctionsRemaining: active.correctionsRemaining,
        stableIterations: active.stableIterations,
        pendingCorrection: active.pendingCorrection,
        alignment,
      });

      if (!alignment.elementExists || !active.hasMeasuredTarget) {
        if (active.correctionsRemaining > 0) {
          scheduleCorrection(active);
        }
        if (canReschedule) {
          scheduleStabilityCheck(active);
        }
        return;
      }

      if (!alignment.aligned) {
        let correctionApplied = false;

        if (Math.abs(alignment.startDelta) > VIEWPORT_TOLERANCE) {
          applyScrollByDelta(active, alignment.startDelta);
          correctionApplied = true;
        } else if (alignment.endOverflow > VIEWPORT_TOLERANCE) {
          applyScrollByDelta(active, alignment.endOverflow);
          correctionApplied = true;
        }

        if (!correctionApplied && active.correctionsRemaining > 0) {
          performScroll(active, 'instant');
          correctionApplied = true;
          active.correctionsRemaining -= 1;
        } else if (correctionApplied && active.correctionsRemaining > 0) {
          active.correctionsRemaining -= 1;
        }

        if (correctionApplied) {
          active.stableIterations = DEFAULT_CORRECTION_SETTLE;
          if (canReschedule) {
            scheduleStabilityCheck(active);
          }
          return;
        }

        if (active.correctionsRemaining <= 0) {
          console.warn(
            '[VirtualizerScrollTo] unable to align target',
            active.id,
            alignment
          );
          finalizeOperation(active);
          return;
        }

        if (canReschedule) {
          scheduleStabilityCheck(active);
        }
        return;
      }

      if (active.pendingCorrection) {
        if (canReschedule) {
          scheduleStabilityCheck(active);
        }
        return;
      }

      if (active.stableIterations > 0) {
        active.stableIterations -= 1;
        if (canReschedule) {
          scheduleStabilityCheck(active);
        }
        return;
      }

      console.log('[VirtualizerScrollTo] stabilitySatisfied', active.id, {
        target: active.targetIndex,
      });

      finalizeOperation(active);
    };

    if (canReschedule) {
      const timeoutId = setStabilityTimeoutFn(runCheck, stabilityTimeout);
      if (timeoutId === -1) {
        runCheck();
      } else {
        operation.stabilityTimeoutId = timeoutId;
      }
    } else {
      operation.stabilityTimeoutId = null;
      runCheck();
    }
  };

  scheduleCorrectionRef.current = (operation: ScrollOperation) => {
    if (!operation) {
      return;
    }

    if (operation.correctionsRemaining <= 0 || operation.pendingCorrection) {
      return;
    }

    operation.pendingCorrection = true;

    const executeCorrection = () => {
      const active = operationRef.current;
      if (!active || active.id !== operation.id) {
        return;
      }

      let correctionApplied = false;
      const alignment = evaluateTargetAlignment(active.targetIndex);
      console.log('[VirtualizerScrollTo] correctionRun', active.id, {
        target: active.targetIndex,
        correctionsRemaining: active.correctionsRemaining,
        alignment,
      });

      if (alignment.elementExists) {
        if (Math.abs(alignment.startDelta) > VIEWPORT_TOLERANCE) {
          applyScrollByDelta(active, alignment.startDelta);
          correctionApplied = true;
        } else if (alignment.endOverflow > VIEWPORT_TOLERANCE) {
          applyScrollByDelta(active, alignment.endOverflow);
          correctionApplied = true;
        }
      }

      if (!correctionApplied) {
        performScroll(active, 'instant');
        correctionApplied = true;
      }

      if (correctionApplied) {
        active.correctionsRemaining -= 1;
      }
      active.pendingCorrection = false;
      active.scheduleFrameId = null;
      console.log('[VirtualizerScrollTo] correctionResult', active.id, {
        target: active.targetIndex,
        correctionApplied,
        correctionsRemaining: active.correctionsRemaining,
        alignment,
      });

      if (alignment.elementExists && alignment.aligned) {
        finalizeOperation(active);
        return;
      }

      if (active.correctionsRemaining > 0) {
        scheduleCorrection(active);
        return;
      }

      scheduleStabilityCheck(active);
    };

    const defaultView = getDefaultView();
    const hasAnimationFrame =
      !!defaultView?.requestAnimationFrame &&
      !!defaultView?.cancelAnimationFrame;

    if (hasAnimationFrame) {
      operation.scheduleFrameId = requestCorrectionFrame(() => {
        executeCorrection();
      });
      return;
    }

    operation.scheduleFrameId = null;
    executeCorrection();
  };

  /**
   * Handles when an item's size is measured or changes.
   * Triggers corrections, anchor adjustments, and stability checks as needed.
   */
  const handleItemMeasured = React.useCallback(
    (index: number, _size: number, delta: number) => {
      const active = operationRef.current;
      if (!active) {
        return;
      }

      if (active.status === 'stable') {
        if (
          active.maintainPosition &&
          index < active.targetIndex &&
          delta !== 0
        ) {
          applyScrollByDelta(active, delta);
        }
        return;
      }

      if (index > active.targetIndex) {
        return;
      }

      active.lastMeasurementTimestamp = Date.now();
      console.log('[VirtualizerScrollTo] measurement', active.id, {
        target: active.targetIndex,
        measuredIndex: index,
        delta,
        maintainPosition: active.maintainPosition,
        status: active.status,
      });

      if (index < active.targetIndex && delta !== 0) {
        if (active.maintainPosition) {
          scheduleAnchorAdjustment(active, delta);
          if (!active.hasMeasuredTarget && active.correctionsRemaining > 0) {
            scheduleCorrection(active);
          }
          active.stableIterations = DEFAULT_CORRECTION_SETTLE;
          scheduleStabilityCheck(active);
          return;
        }

        if (active.correctionsRemaining > 0) {
          scheduleCorrection(active);
        }
        active.stableIterations = DEFAULT_CORRECTION_SETTLE;
        scheduleStabilityCheck(active);
        return;
      }

      if (index === active.targetIndex) {
        active.hasMeasuredTarget = true;
        if (!active.initialAlignmentPerformed) {
          performScroll(active, 'instant');
          active.initialAlignmentPerformed = true;
        }
        if (active.maintainPosition) {
          scheduleAnchorAdjustment(active, 0);
        }
        if (
          Math.abs(delta) >= VIEWPORT_TOLERANCE &&
          active.correctionsRemaining > 0
        ) {
          scheduleCorrection(active);
          active.stableIterations = DEFAULT_CORRECTION_SETTLE;
        }
        scheduleStabilityCheck(active);
        return;
      }

      scheduleStabilityCheck(active);
    },
    [
      applyScrollByDelta,
      scheduleAnchorAdjustment,
      scheduleCorrection,
      evaluateTargetAlignment,
      scheduleStabilityCheck,
      performScroll,
    ]
  );

  /**
   * Handles when the target item is rendered in the DOM.
   * Schedules corrections and stability checks to ensure proper alignment.
   */
  const handleRendered = React.useCallback(
    (index: number) => {
      const active = operationRef.current;
      if (!active || index !== active.targetIndex) {
        return false;
      }

      if (active.status === 'stable') {
        return true;
      }

      scheduleCorrection(active);
      scheduleStabilityCheck(active);
      return true;
    },
    [scheduleCorrection, scheduleStabilityCheck]
  );

  /**
   * Initiates a scroll operation to the specified index.
   * Cancels any existing operation and starts a new one with corrections and stability checks.
   */
  const start = React.useCallback(
    (
      index: number,
      behavior: ScrollBehavior,
      callback?: (index: number) => void
    ) => {
      cancelScheduledFrame(
        operationRef.current ??
          ({
            scheduleFrameId: null,
          } as ScrollOperation)
      );
      clearOperation();

      const operationId = ++operationIdRef.current;
      const operation: ScrollOperation = {
        id: operationId,
        targetIndex: index,
        behavior,
        callback,
        correctionsRemaining: maxCorrections,
        pendingCorrection: false,
        stabilityTimeoutId: null,
        pinTimeoutId: null,
        scheduleFrameId: null,
        status: 'initial',
        maintainPosition,
        isPinned: false,
        isProgrammaticScroll: false,
        stableIterations: DEFAULT_CORRECTION_SETTLE,
        lastMeasurementTimestamp: Date.now(),
        hasMeasuredTarget: false,
        pendingAnchorDelta: 0,
        anchorFrameId: null,
        initialAlignmentPerformed: false,
      };

      operationRef.current = operation;
      setFlaggedIndex?.(index);
      ensureScrollListener();
      console.log('[VirtualizerScrollTo] start', operationId, {
        target: index,
        behavior,
        maxCorrections,
      });

      performScroll(operation, behavior);
      scheduleCorrection(operation);
      scheduleStabilityCheck(operation);
    },
    [
      cancelScheduledFrame,
      clearOperation,
      ensureScrollListener,
      maxCorrections,
      scheduleCorrection,
      performScroll,
      scheduleStabilityCheck,
      setFlaggedIndex,
      maintainPosition,
    ]
  );

  /**
   * Cancels the current scroll operation and cleans up all timers and listeners.
   */
  const cancel = React.useCallback(() => {
    clearOperation('cancelled');
  }, [clearOperation]);

  /**
   * Returns true if a scroll operation is currently active (not finalized).
   */
  const isActive = React.useCallback(() => {
    return operationRef.current !== null;
  }, []);

  React.useEffect(() => {
    return () => {
      clearOperation();
    };
  }, [clearOperation]);

  return {
    start,
    handleItemMeasured,
    handleRendered,
    cancel,
    isActive,
  };
}
