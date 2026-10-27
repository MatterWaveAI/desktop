import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { subscribeToViewport } from "../../shell/useVisualViewport";

/** How near the bottom still counts as "following the stream", in px. */
const NEAR_BOTTOM_PX = 120;

/** What the transcript's jump button reads. */
export interface StickToBottom {
  /** The reader is more than a viewport above the bottom. */
  readonly away: boolean;
  /** Content arrived below the fold while they were away. */
  readonly unseen: boolean;
  /** Scroll to the bottom and follow the stream again. */
  readonly jumpToLatest: () => void;
}

/**
 * Keep a scroll container pinned to its bottom while content streams, and
 * re-pin it when the on-screen keyboard opens or closes.
 *
 * Extracted from ChatPage's inline effect for two reasons. The ticket's
 * requirement is the second one:
 *
 * 1. The follow rule — "stay at the bottom unless the reader scrolled up to
 *    read something" — is logic, and it was previously an untested effect
 *    body inside a component that cannot be mounted in jsdom.
 *
 * 2. **The keyboard changes the container's height without changing its
 *    content.** Opening the keyboard shrinks the visual viewport by ~300px;
 *    the transcript box shrinks with it, and whatever was at the bottom is
 *    now 300px below the fold. The user typed into the composer and the
 *    answer they were reading scrolled away. Nothing in a content-keyed
 *    effect notices, because the content did not change — so this subscribes
 *    to the viewport itself.
 *
 * `wasNearBottom` is sampled BEFORE the viewport change rather than after:
 * once the box has shrunk, every position looks far from the bottom, so
 * asking the question after the resize would always answer "no, do not
 * re-pin" — exactly backwards.
 *
 * The reader who scrolled up gets the other half: once they are a whole
 * viewport above the bottom the page offers a way back, and anything that
 * streams in meanwhile is flagged as unseen until they arrive.
 */
export function useStickToBottom(
  ref: RefObject<HTMLElement | null>,
  /**
   * Changes whenever the transcript's content does. The caller keys it on
   * what it renders -- every transcript, and the stream's phase -- so an
   * edit, a regenerate or a continue, which stream through the stored
   * tree rather than the send's transcript, are followed like a send.
   */
  contentKey: unknown,
  /**
   * False while there is no transcript to follow: an empty chat's welcome
   * is read from the top, and pinning it to the bottom hid its heading on
   * a phone.
   */
  pin = true,
): StickToBottom {
  // Whether the reader was following along, sampled continuously from their
  // own scrolling so a viewport change can consult it from before the change.
  const following = useRef(true);
  const [away, setAway] = useState(false);
  const [unseen, setUnseen] = useState(false);
  // A scroll of this hook's own making is in flight: a smooth `scrollTo`
  // eases over several frames, and each frame fires `scroll` from a
  // position that is not yet the bottom. Those events are not the reader's,
  // and judging them as such is what used to lose the follow: a reply that
  // streamed faster than the easing read, mid-ease, as "more than 120px up,
  // so they scrolled", and the jump button appeared under a reader who had
  // not touched the page. The easing is told from the reader by direction:
  // it only ever moves down, so a position above the last one is theirs.
  const pinning = useRef(false);
  const lastTop = useRef(0);

  // More than a viewport above the bottom is "away", which is when the jump
  // button shows. Read from the geometry alone, so it can be refreshed when
  // content grows under a reader who did not scroll.
  const readAway = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setAway(el.scrollHeight - el.scrollTop - el.clientHeight > el.clientHeight);
  }, [ref]);

  const scrollToBottom = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    pinning.current = true;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
    // Read after the call: an instant scroll has already landed, a smooth
    // one has not moved yet. Either way this is where the easing starts.
    lastTop.current = el.scrollTop;
  }, [ref]);

  const jumpToLatest = useCallback(() => {
    following.current = true;
    setUnseen(false);
    scrollToBottom();
  }, [scrollToBottom]);

  // Track whether the reader is at the bottom, from their scrolling -- and
  // only from that. A freshly mounted transcript has not been scrolled by
  // anyone, so it is followed whatever its height says.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      const below = el.scrollHeight - el.scrollTop - el.clientHeight;
      const movedUp = el.scrollTop < lastTop.current;
      lastTop.current = el.scrollTop;
      if (pinning.current && !movedUp) {
        // Our own easing, still on its way down. The reader's position is
        // not re-judged until it lands; a wheel or a drag upwards cancels
        // the easing in every browser and arrives here as `movedUp`.
        if (below < NEAR_BOTTOM_PX) {
          pinning.current = false;
          setAway(false);
        }
        return;
      }
      pinning.current = false;
      following.current = below < NEAR_BOTTOM_PX;
      if (following.current) setUnseen(false);
      setAway(below > el.clientHeight);
    };
    lastTop.current = el.scrollTop;
    readAway();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [ref, readAway]);

  // Follow new content, judged by where the reader was BEFORE it arrived:
  // a large chunk landing under someone at the bottom puts the bottom far
  // below them for an instant, and re-measuring here would read that as
  // "they scrolled up" and strand them. A reader who was not following is
  // told about it instead, and their distance is refreshed for the button.
  const pinRef = useRef(pin);
  useEffect(() => {
    pinRef.current = pin;
    if (!pin) return;
    if (following.current) {
      scrollToBottom();
      return;
    }
    setUnseen(true);
    readAway();
  }, [contentKey, pin, readAway, scrollToBottom]);

  // Re-pin across a keyboard open/close. The jump this prevents is the one
  // that matters: opening the keyboard mid-stream must not move the
  // answer off screen.
  useEffect(() => {
    return subscribeToViewport(() => {
      if (!following.current || !pinRef.current) return;
      // After the browser has finished reflowing to the new viewport. A
      // synchronous scroll here lands on the pre-resize geometry and is
      // immediately undone.
      requestAnimationFrame(() => {
        const el = ref.current;
        if (!el) return;
        // Instant, never smooth: the keyboard is already animating, and a
        // second easing on top of it reads as lag.
        el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
      });
    });
  }, [ref]);

  return { away, unseen, jumpToLatest };
}
