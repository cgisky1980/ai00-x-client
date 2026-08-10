/**
 * Follow-output controller for the modern virtualized FlowChat list.
 *
 * Keeps follow state local to the viewport layer while separating the
 * "when should we follow" policy from the low-level list scroll mechanics.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

const PROGRAMMATIC_SCROLL_GUARD_MS = 160;
const AUTO_FOLLOW_BOTTOM_THRESHOLD_PX = 24;
const USER_SCROLL_DIRECTION_EPSILON_PX = 0.5;
const USER_SCROLL_INTENT_WINDOW_MS = 450;

export type FollowOutputEnterReason = 'jump-to-latest' | 'auto-follow';
export type FollowOutputExitReason =
  | 'session-changed'
  | 'user-scroll-up'
  | 'scroll-to-turn'
  | 'scroll-to-index'
  | 'pin-turn-to-top';

interface UseFlowChatFollowOutputOptions {
  activeSessionId?: string;
  latestTurnId: string | null;
  virtualItemCount: number;
  isStreaming: boolean;
  scrollerRef: RefObject<HTMLElement | null>;
  performUserFollowScroll: () => void;
  performAutoFollowScroll: () => void;
  performLatestTurnStickyPin: () => void;
  shouldSuspendAutoFollow?: () => boolean;
  getAutoFollowDistanceFromBottom?: (scroller: HTMLElement) => number;
}

interface UseFlowChatFollowOutputResult {
  isFollowingOutput: boolean;
  enterFollowOutput: (reason: FollowOutputEnterReason) => void;
  exitFollowOutput: (reason: FollowOutputExitReason) => void;
  armFollowOutputForNewTurn: () => void;
  activateArmedFollowOutput: () => boolean;
  cancelPendingAutoFollowArm: () => void;
  scheduleFollowToLatest: (reason: string) => void;
  handleUserScrollIntent: () => void;
  handleScroll: () => void;
}

function getDistanceFromBottom(scroller: HTMLElement): number {
  return Math.max(0, scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop);
}

export function useFlowChatFollowOutput({
  activeSessionId,
  latestTurnId,
  virtualItemCount,
  isStreaming,
  scrollerRef,
  performUserFollowScroll,
  performAutoFollowScroll,
  performLatestTurnStickyPin,
  shouldSuspendAutoFollow,
  getAutoFollowDistanceFromBottom,
}: UseFlowChatFollowOutputOptions): UseFlowChatFollowOutputResult {
  const [isFollowingOutput, setIsFollowingOutput] = useState(false);

  const isFollowingOutputRef = useRef(isFollowingOutput);
  const followFrameRef = useRef<number | null>(null);
  const programmaticScrollUntilMsRef = useRef(0);
  const explicitUserScrollIntentUntilMsRef = useRef(0);
  const lastObservedScrollTopRef = useRef(0);
  const previousSessionIdRef = useRef<string | undefined>(activeSessionId);
  const armedAutoFollowTurnIdRef = useRef<string | null>(null);

  const setFollowingOutput = useCallback((nextValue: boolean) => {
    isFollowingOutputRef.current = nextValue;
    setIsFollowingOutput(prev => (prev === nextValue ? prev : nextValue));
  }, []);

  const cancelScheduledFollow = useCallback(() => {
    if (followFrameRef.current !== null) {
      cancelAnimationFrame(followFrameRef.current);
      followFrameRef.current = null;
    }
  }, []);

  const cancelPendingAutoFollowArm = useCallback(() => {
    armedAutoFollowTurnIdRef.current = null;
  }, []);

  const runProgrammaticScroll = useCallback((scrollAction: () => void) => {
    programmaticScrollUntilMsRef.current = performance.now() + PROGRAMMATIC_SCROLL_GUARD_MS;
    explicitUserScrollIntentUntilMsRef.current = 0;
    scrollAction();
    const scroller = scrollerRef.current;
    if (scroller) {
      lastObservedScrollTopRef.current = scroller.scrollTop;
    }
  }, [scrollerRef]);

  const enterFollowOutput = useCallback((reason: FollowOutputEnterReason) => {
    cancelPendingAutoFollowArm();
    cancelScheduledFollow();
    explicitUserScrollIntentUntilMsRef.current = 0;
    setFollowingOutput(true);
    const followAction = reason === 'jump-to-latest'
      ? performUserFollowScroll
      : performAutoFollowScroll;
    runProgrammaticScroll(followAction);
  }, [
    cancelPendingAutoFollowArm,
    cancelScheduledFollow,
    performAutoFollowScroll,
    performUserFollowScroll,
    runProgrammaticScroll,
    setFollowingOutput,
  ]);

  const exitFollowOutput = useCallback((_reason: FollowOutputExitReason) => {
    cancelPendingAutoFollowArm();
    cancelScheduledFollow();
    explicitUserScrollIntentUntilMsRef.current = 0;
    setFollowingOutput(false);
    const scroller = scrollerRef.current;
    if (scroller) {
      lastObservedScrollTopRef.current = scroller.scrollTop;
    }
  }, [cancelPendingAutoFollowArm, cancelScheduledFollow, scrollerRef, setFollowingOutput]);

  const armFollowOutputForNewTurn = useCallback(() => {
    if (!latestTurnId) {
      cancelPendingAutoFollowArm();
      return;
    }

    armedAutoFollowTurnIdRef.current = latestTurnId;
    cancelScheduledFollow();
    setFollowingOutput(false);
    runProgrammaticScroll(performLatestTurnStickyPin);
  }, [
    cancelPendingAutoFollowArm,
    cancelScheduledFollow,
    latestTurnId,
    performLatestTurnStickyPin,
    runProgrammaticScroll,
    setFollowingOutput,
  ]);

  const activateArmedFollowOutput = useCallback(() => {
    const armedTurnId = armedAutoFollowTurnIdRef.current;
    const isAlreadyFollowing = isFollowingOutputRef.current;
    const isArmedForLatestTurn = Boolean(latestTurnId && armedTurnId === latestTurnId);
    const isAutoFollowSuspended = shouldSuspendAutoFollow?.() === true;

    if (!latestTurnId || !isArmedForLatestTurn || isAlreadyFollowing) {
      return false;
    }

    if (isAutoFollowSuspended) {
      return false;
    }

    cancelPendingAutoFollowArm();
    cancelScheduledFollow();
    setFollowingOutput(true);
    runProgrammaticScroll(performAutoFollowScroll);
    return true;
  }, [
    cancelPendingAutoFollowArm,
    cancelScheduledFollow,
    latestTurnId,
    performAutoFollowScroll,
    runProgrammaticScroll,
    setFollowingOutput,
    shouldSuspendAutoFollow,
  ]);

  const handleUserScrollIntent = useCallback(() => {
    if (!isFollowingOutputRef.current && armedAutoFollowTurnIdRef.current === null) {
      return;
    }

    const now = performance.now();
    if (now <= programmaticScrollUntilMsRef.current) {
      return;
    }
    explicitUserScrollIntentUntilMsRef.current = now + USER_SCROLL_INTENT_WINDOW_MS;
  }, []);

  const scheduleFollowToLatest = useCallback((_reason: string) => {
    if (
      !isFollowingOutputRef.current ||
      !isStreaming ||
      virtualItemCount === 0 ||
      shouldSuspendAutoFollow?.() === true
    ) {
      return;
    }

    if (followFrameRef.current !== null) {
      return;
    }

    followFrameRef.current = requestAnimationFrame(() => {
      followFrameRef.current = null;

      if (!isFollowingOutputRef.current || !isStreaming || virtualItemCount === 0) {
        return;
      }

      if (shouldSuspendAutoFollow?.() === true) {
        return;
      }

      const scroller = scrollerRef.current;
      if (!scroller) {
        return;
      }

      const rawDistanceFromBottom = getDistanceFromBottom(scroller);
      const distanceFromBottom = getAutoFollowDistanceFromBottom?.(scroller) ?? rawDistanceFromBottom;
      if (distanceFromBottom <= AUTO_FOLLOW_BOTTOM_THRESHOLD_PX) {
        return;
      }

      runProgrammaticScroll(performAutoFollowScroll);
    });
  }, [getAutoFollowDistanceFromBottom, isStreaming, performAutoFollowScroll, runProgrammaticScroll, scrollerRef, shouldSuspendAutoFollow, virtualItemCount]);

  const handleScroll = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) {
      return;
    }

    const currentScrollTop = scroller.scrollTop;
    const previousScrollTop = lastObservedScrollTopRef.current;
    lastObservedScrollTopRef.current = currentScrollTop;

    if (!isFollowingOutputRef.current && armedAutoFollowTurnIdRef.current === null) {
      return;
    }

    if (performance.now() <= programmaticScrollUntilMsRef.current) {
      return;
    }

    if (shouldSuspendAutoFollow?.() === true) {
      return;
    }

    const upwardDelta = previousScrollTop - currentScrollTop;
    if (upwardDelta > USER_SCROLL_DIRECTION_EPSILON_PX) {
      const now = performance.now();
      const hasRecentExplicitUserIntent = now <= explicitUserScrollIntentUntilMsRef.current;
      const distanceFromBottom = getDistanceFromBottom(scroller);
      if (!hasRecentExplicitUserIntent) {
        if (
          isFollowingOutputRef.current &&
          distanceFromBottom <= AUTO_FOLLOW_BOTTOM_THRESHOLD_PX
        ) {
          return;
        }
        return;
      }

      explicitUserScrollIntentUntilMsRef.current = 0;

      if (!isFollowingOutputRef.current) {
        cancelPendingAutoFollowArm();
        return;
      }

      exitFollowOutput('user-scroll-up');
    }
  }, [cancelPendingAutoFollowArm, exitFollowOutput, scrollerRef, shouldSuspendAutoFollow]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller) {
      lastObservedScrollTopRef.current = scroller.scrollTop;
    }
  }, [scrollerRef]);

  useEffect(() => {
    const previousSessionId = previousSessionIdRef.current;
    if (previousSessionId === activeSessionId) {
      return;
    }

    previousSessionIdRef.current = activeSessionId;
    cancelPendingAutoFollowArm();
    cancelScheduledFollow();
    explicitUserScrollIntentUntilMsRef.current = 0;
    const nextFollowState = Boolean(activeSessionId && virtualItemCount === 0);

    if (nextFollowState) {
      setFollowingOutput(true);
      return;
    }

    setFollowingOutput(false);
  }, [
    activeSessionId,
    cancelPendingAutoFollowArm,
    cancelScheduledFollow,
    latestTurnId,
    setFollowingOutput,
    virtualItemCount,
  ]);

  useEffect(() => {
    if (!isFollowingOutput || !isStreaming) {
      return;
    }

    scheduleFollowToLatest('streaming-started');
  }, [isFollowingOutput, isStreaming, scheduleFollowToLatest]);

  useEffect(() => {
    return () => {
      cancelScheduledFollow();
    };
  }, [cancelScheduledFollow]);

  return {
    isFollowingOutput,
    enterFollowOutput,
    exitFollowOutput,
    armFollowOutputForNewTurn,
    activateArmedFollowOutput,
    cancelPendingAutoFollowArm,
    scheduleFollowToLatest,
    handleUserScrollIntent,
    handleScroll,
  };
}
