/**
 * One rule for "does the content scroll, or does the sheet move?" on the touch
 * path.
 *
 * The rule is stated in FINGER space, which is what makes it
 * position-independent. A finger moving in some direction drags the content the
 * opposite way, so the content consumes the gesture while it can still scroll
 * opposite-of-finger on the sheet's dismiss axis; the sheet claims the moment
 * that room runs out:
 *
 *   fingerDelta < 0 (up, or left)  → the scroll position must be able to GROW
 *   fingerDelta > 0 (down, or right) → the scroll position must be able to SHRINK
 *
 * Nothing here knows which edge the sheet sits on. Touch deltas are already
 * finger motion. Writing the rule per profile instead is how the left and right
 * branches ended up mirrored into each other and stayed that way.
 *
 * Metrics are plain snapshots rather than live elements so the policy stays
 * DOM-free and node-testable.
 */

// A box with nothing to scroll rarely measures exactly flush — a fractional
// device pixel ratio alone puts scrollHeight a hair above clientHeight — so the
// far edge needs a pixel of slack or the sheet never claims there. The near
// edge is a hard zero and needs none.
const SCROLL_EDGE_TOLERANCE = 1;

/**
 * Recovers finger motion from an away-signed drag direction.
 *
 * The inverse of sheet-engine's awayOffset on the dismiss axis, and the only
 * place the two spaces meet on the touch path. A left sheet is the one profile
 * dismissed toward SMALLER coordinates, so its away sign is the finger's
 * inverted; bottom and right already agree with their axis. Getting exactly
 * this backwards for one profile is the bug the shared policy exists to end, so
 * it is a named, tested function rather than a ternary at the call site.
 * @param {'bottom'|'left'|'right'} position - Sheet edge.
 * @param {number} awayDirection - Signed motion toward dismissal.
 * @returns {number} The same motion in finger space on the dismiss axis.
 */
function fingerFromAway(position, awayDirection) {
	return position === 'left' ? -awayDirection : awayDirection;
}

/**
 * Normalizes a horizontal scroll offset into the monotonic 0..max range
 * canScrollFurther assumes. Modern RTL scrollers report 0 at their start
 * (right) edge and negative values leftward; shifting by the scrollable
 * extent restores [0, max] while preserving the physical relationship —
 * scrolling content left still grows the value.
 * @param {number} scrollLeft - Raw scrollLeft as the browser reported it.
 * @param {number} scrollWidth - Total scrollable width.
 * @param {number} clientWidth - Visible width.
 * @param {boolean} rtl - True when the scroller's computed direction is rtl.
 * @returns {number} Offset in [0, scrollWidth - clientWidth].
 */
function normalizeScrollLeft(scrollLeft, scrollWidth, clientWidth, rtl) {
	if (!rtl) return scrollLeft;
	return scrollLeft + Math.max(0, scrollWidth - clientWidth);
}

/**
 * Whether one scrollable still has somewhere to go in a scroll direction.
 * @param {Object} metrics - Snapshot of one element's scroll geometry.
 * @param {number} metrics.scrollTop - Current vertical scroll offset.
 * @param {number} metrics.scrollLeft - Current horizontal scroll offset.
 * @param {number} metrics.scrollHeight - Total scrollable height.
 * @param {number} metrics.scrollWidth - Total scrollable width.
 * @param {number} metrics.clientHeight - Visible height.
 * @param {number} metrics.clientWidth - Visible width.
 * @param {'x'|'y'} axis - Dismiss axis to test.
 * @param {number} scrollSign - Positive asks whether the scroll position can
 *   still increase, negative whether it can still decrease.
 * @returns {boolean} True while that direction has room left.
 */
function canScrollFurther(metrics, axis, scrollSign) {
	if (!metrics || !scrollSign) return false;
	const horizontal = axis === 'x';
	const position = (horizontal ? metrics.scrollLeft : metrics.scrollTop) || 0;
	if (scrollSign < 0) return position > 0;
	const visible = (horizontal ? metrics.clientWidth : metrics.clientHeight) || 0;
	const extent = (horizontal ? metrics.scrollWidth : metrics.scrollHeight) || 0;
	return position + visible < extent - SCROLL_EDGE_TOLERANCE;
}

/**
 * Whether the scrollable chain under the pointer should keep a gesture instead
 * of handing it to the sheet.
 *
 * Any single member with room left answers for the whole chain, so a nested
 * horizontal carousel inside the content scrolls on its own until it reaches
 * its edge.
 * @param {Object[]} chain - Scroll metrics, innermost first, ending with the
 *   sheet content itself.
 * @param {'x'|'y'} axis - Dismiss axis to test.
 * @param {number} fingerDelta - Finger motion on that axis; negative is up or
 *   left. Zero never consumes.
 * @returns {boolean} True while the content still has scroll to give.
 */
function scrollChainConsumes(chain, axis, fingerDelta) {
	if (!fingerDelta || !chain) return false;
	const scrollSign = fingerDelta < 0 ? 1 : -1;
	for (const metrics of chain) {
		if (canScrollFurther(metrics, axis, scrollSign)) return true;
	}
	return false;
}

// Movement, in pixels on the dismiss axis, below which an unclaimed content
// gesture stays unclaimed. Mirrors DragGesture's tap slop: the first pixel or
// two of finger settle is jitter, not intent, and claiming on it steals the
// scroll gesture that follows.
const CLAIM_SLOP = 5;

/**
 * Resolves whether an unclaimed content gesture may claim on this move.
 *
 * Stateless per move, so it is always the LIVE offset that answers — a gesture
 * that reverses while unclaimed asks the new direction's question, never a
 * latched first sample's.
 * @param {Object[]} chain - Scroll metrics, innermost first.
 * @param {'x'|'y'} axis - Dismiss axis.
 * @param {'bottom'|'left'|'right'|'center'} position - Sheet edge.
 * @param {number} awayOffset - Live away-signed offset on the dismiss axis.
 * @param {number} [slop=CLAIM_SLOP] - Minimum offset magnitude to claim.
 * @returns {number} Away-signed claim direction, or 0 to keep waiting.
 */
function contentClaimDirection(chain, axis, position, awayOffset, slop = CLAIM_SLOP) {
	if (Math.abs(awayOffset) <= slop) return 0;
	const direction = Math.sign(awayOffset);
	const fingerDelta = fingerFromAway(position, direction);
	return scrollChainConsumes(chain, axis, fingerDelta) ? 0 : direction;
}

export {
	canScrollFurther,
	contentClaimDirection,
	fingerFromAway,
	normalizeScrollLeft,
	scrollChainConsumes,
	CLAIM_SLOP,
	SCROLL_EDGE_TOLERANCE,
};
