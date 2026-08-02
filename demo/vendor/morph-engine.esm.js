import PhysicsEngine from "@magic-spells/physics-engine";
import FrameEngine from "@magic-spells/frame-engine";
//#region src/event-emitter.js
var EventEmitter = class {
	#events;
	constructor() {
		this.#events = /* @__PURE__ */ new Map();
	}
	/**
	* Binds a listener to an event.
	* @param {string} event - The event to bind the listener to.
	* @param {Function} listener - The listener function to bind.
	* @returns {EventEmitter} The current instance for chaining.
	* @throws {TypeError} If the listener is not a function.
	*/
	on(event, listener) {
		if (typeof listener !== "function") throw new TypeError("Listener must be a function");
		const listeners = this.#events.get(event) || [];
		if (!listeners.includes(listener)) listeners.push(listener);
		this.#events.set(event, listeners);
		return this;
	}
	/**
	* Unbinds a listener from an event.
	* @param {string} event - The event to unbind the listener from.
	* @param {Function} listener - The listener function to unbind.
	* @returns {EventEmitter} The current instance for chaining.
	*/
	off(event, listener) {
		const listeners = this.#events.get(event);
		if (!listeners) return this;
		const index = listeners.indexOf(listener);
		if (index !== -1) {
			listeners.splice(index, 1);
			if (listeners.length === 0) this.#events.delete(event);
			else this.#events.set(event, listeners);
		}
		return this;
	}
	/**
	* Triggers an event and calls all bound listeners.
	* @param {string} event - The event to trigger.
	* @param {...*} args - Arguments to pass to the listener functions.
	* @returns {boolean} True if the event had listeners, false otherwise.
	*/
	emit(event, ...args) {
		const listeners = this.#events.get(event);
		if (!listeners || listeners.length === 0) return false;
		const snapshot = listeners.slice();
		for (let i = 0, n = snapshot.length; i < n; ++i) try {
			snapshot[i].apply(this, args);
		} catch (error) {
			console.error(`Error in listener for event '${event}':`, error);
		}
		return true;
	}
	/**
	* Removes all listeners for a specific event or all events.
	* @param {string} [event] - The event to remove listeners from. If not provided, removes all listeners.
	* @returns {EventEmitter} The current instance for chaining.
	*/
	removeAllListeners(event) {
		if (event) this.#events.delete(event);
		else this.#events.clear();
		return this;
	}
};
//#endregion
//#region src/morph-engine.js
var TRAVEL = 1e3;
var SETTLE_POSITION_EPSILON = 1;
var SETTLE_DELTA_EPSILON = .5;
var DEFAULT_STYLE_PROPERTIES = [
	"backgroundColor",
	"borderTopLeftRadius",
	"borderTopRightRadius",
	"borderBottomRightRadius",
	"borderBottomLeftRadius",
	"borderTopWidth",
	"borderRightWidth",
	"borderBottomWidth",
	"borderLeftWidth",
	"borderTopColor",
	"borderRightColor",
	"borderBottomColor",
	"borderLeftColor"
];
var BORDER_SIDES = [
	"Top",
	"Right",
	"Bottom",
	"Left"
];
var CLAMP_POSITIVE = [
	"width",
	"height",
	"borderTopLeftRadius",
	"borderTopRightRadius",
	"borderBottomRightRadius",
	"borderBottomLeftRadius",
	"borderTopWidth",
	"borderRightWidth",
	"borderBottomWidth",
	"borderLeftWidth"
];
var MANAGED_PROPERTIES = [
	"visibility",
	"display",
	"opacity",
	"transform",
	"transformOrigin",
	"willChange",
	"transition"
];
function clamp(value, min, max) {
	return Math.min(max, Math.max(min, value));
}
function round(value) {
	return Math.round(value * 100) / 100;
}
var COLOR_PATTERN = /rgba?\([^)]*\)/;
/**
* Parses a computed rgb()/rgba() color string into channels.
* Computed styles always serialize sRGB colors this way.
* @param {string} colorString
* @returns {{red: number, green: number, blue: number, alpha: number}}
*/
function parseColor(colorString) {
	const match = colorString.match(/rgba?\(([^)]*)\)/);
	if (!match) return {
		red: 0,
		green: 0,
		blue: 0,
		alpha: 1
	};
	const parts = match[1].split(",").map((part) => parseFloat(part));
	return {
		red: parts[0] || 0,
		green: parts[1] || 0,
		blue: parts[2] || 0,
		alpha: parts.length > 3 ? parts[3] : 1
	};
}
/**
* Parses a computed box-shadow into its first shadow's parts.
* Handles both serialization orders (color-first and color-last).
* @param {string} computedShadow - Value from getComputedStyle().boxShadow
* @returns {{x: number, y: number, blur: number, spread: number, color: Object}|null}
*/
function parseShadow(computedShadow) {
	if (!computedShadow || computedShadow === "none") return null;
	let first = computedShadow;
	let depth = 0;
	for (let i = 0; i < computedShadow.length; i++) {
		const character = computedShadow[i];
		if (character === "(") depth++;
		else if (character === ")") depth--;
		else if (character === "," && depth === 0) {
			first = computedShadow.slice(0, i);
			break;
		}
	}
	const colorMatch = first.match(COLOR_PATTERN);
	const color = parseColor(colorMatch ? colorMatch[0] : "rgba(0, 0, 0, 1)");
	const [x = 0, y = 0, blur = 0, spread = 0] = first.replace(COLOR_PATTERN, "").trim().split(/\s+/).filter((token) => token !== "inset" && token !== "").map(parseFloat);
	return {
		x,
		y,
		blur,
		spread,
		color
	};
}
/**
* Interpolates two parsed shadows at raw p (extrapolates during overshoot,
* so the shadow bounces with the geometry). A missing end fades through the
* other end's color at alpha 0 to avoid a hue lurch through transparent black.
* @param {Object|null} fromShadow
* @param {Object|null} toShadow
* @param {number} p
* @returns {string} A CSS box-shadow value
*/
function lerpShadow(fromShadow, toShadow, p) {
	if (!fromShadow && !toShadow) return "none";
	const zeroed = (other) => ({
		x: 0,
		y: 0,
		blur: 0,
		spread: 0,
		color: {
			...other.color,
			alpha: 0
		}
	});
	const start = fromShadow || zeroed(toShadow);
	const end = toShadow || zeroed(fromShadow);
	const lerp = (a, b) => a + (b - a) * p;
	return `${round(lerp(start.x, end.x))}px ${round(lerp(start.y, end.y))}px ${round(Math.max(0, lerp(start.blur, end.blur)))}px ${round(lerp(start.spread, end.spread))}px rgba(${Math.round(clamp(lerp(start.color.red, end.color.red), 0, 255))}, ${Math.round(clamp(lerp(start.color.green, end.color.green), 0, 255))}, ${Math.round(clamp(lerp(start.color.blue, end.color.blue), 0, 255))}, ${round(clamp(lerp(start.color.alpha, end.color.alpha), 0, 1))})`;
}
/**
* Shared-element morph engine. A fixed-position blob springs from a source
* element's rect and styles to a target element's, dissolving the source's
* content on the way out and revealing the target — mirrored to the blob's
* geometry so it inherits the spring's settle bounce — on the way in.
*
* show() morphs source → target; hide() morphs back. Calling either mid-flight
* reverses the spring in place. Emits: show, hide, change, shown, hidden, stop.
*/
var MorphEngine = class extends EventEmitter {
	#spring;
	#frames = null;
	#blob = null;
	#cloneWrapper = null;
	#styleProperties;
	#state = "idle";
	#p = 0;
	#resolveRun = null;
	#sourceElement = null;
	#targetElement = null;
	#displayOverride = null;
	#savedInline = /* @__PURE__ */ new Map();
	#savedBodyOverflow = null;
	#fromMeasure = null;
	#toMeasure = null;
	#toElement = null;
	#shownPosition = TRAVEL;
	#revealed = false;
	#revealStart = .75;
	#revealFull = .875;
	#sourceRevealed = false;
	#sourceRevealUntil = .25;
	#springTarget = TRAVEL;
	#lastPosition = 0;
	#settleCount = 0;
	/**
	* @param {Object} [options]
	* @param {number} [options.attraction=0.1] - Spring attraction (0, 1) exclusive
	* @param {number} [options.friction=0.32] - Spring friction (0, 1) exclusive
	* @param {string[]} [options.styleProperties] - Computed styles captured and morphed
	*   (camelCase longhands — shorthands snap instead of interpolating)
	* @param {number} [options.revealAt=0.75] - Progress where the target reveal window begins
	* @param {number} [options.sourceRevealUntil=0.25] - Progress where the source reveal window
	*   ends (mirrors revealAt at the p→0 end so reversals crossfade instead of hard-swapping)
	* @param {number} [options.cloneFadeUntil=0.25] - Progress where the source-content clone
	*   finishes dissolving
	* @param {boolean} [options.cloneContents=true] - Clone the source's content into the blob
	* @param {boolean} [options.lockScroll=true] - Lock body scroll from show until fully
	*   hidden — a scroll mid-morph would strand the fixed-position blob
	* @param {number} [options.zIndex=9999] - Blob z-index
	*/
	constructor({ attraction = .1, friction = .32, styleProperties = DEFAULT_STYLE_PROPERTIES, revealAt = .75, sourceRevealUntil = .25, cloneFadeUntil = .25, cloneContents = true, lockScroll = true, zIndex = 9999 } = {}) {
		super();
		this.#spring = new PhysicsEngine({
			attraction,
			friction
		});
		this.#styleProperties = styleProperties;
		this.revealAt = revealAt;
		this.sourceRevealUntil = sourceRevealUntil;
		this.cloneFadeUntil = cloneFadeUntil;
		this.cloneContents = cloneContents;
		this.lockScroll = lockScroll;
		this.zIndex = zIndex;
		this.#spring.on("change", ({ position }) => {
			if (this.#state !== "showing" && this.#state !== "hiding") return;
			const p = position / TRAVEL;
			this.#p = p;
			this.#applyFrame(p);
			this.emit("change", {
				progress: p,
				phase: this.#state
			});
			if (Math.abs(position - this.#springTarget) < SETTLE_POSITION_EPSILON && Math.abs(position - this.#lastPosition) < SETTLE_DELTA_EPSILON) {
				if (++this.#settleCount >= 2) {
					this.#applyFrame(this.#springTarget / TRAVEL);
					this.#spring.stop();
					this.#settle();
					return;
				}
			} else this.#settleCount = 0;
			this.#lastPosition = position;
		});
		this.#spring.on("complete", () => this.#settle());
	}
	/** @returns {string} 'idle' | 'showing' | 'shown' | 'hiding' */
	get state() {
		return this.#state;
	}
	/** @returns {number} Last-known morph progress (overshoots past 1 while settling) */
	get progress() {
		return this.#p;
	}
	/**
	* Morphs from the source element to the target element. Called while hiding,
	* it reverses the in-flight morph instead (arguments are ignored).
	* @param {Object} options
	* @param {HTMLElement} options.from - Source element (stays hidden while shown)
	* @param {HTMLElement} options.to - Target element (revealed as the blob arrives)
	* @param {string} [options.display] - display value applied to a display:none target
	* @returns {Promise<boolean>} true when settled, false if superseded or rejected
	*/
	show({ from, to, display = null } = {}) {
		if (this.#state === "showing" || this.#state === "shown") {
			console.warn(`MorphEngine: show() ignored — already ${this.#state}`);
			return Promise.resolve(false);
		}
		if (this.#state === "hiding") return this.#reverse("showing");
		if (!from || !to) throw new Error("MorphEngine: show() requires { from, to } elements.");
		this.#sourceElement = from;
		this.#targetElement = to;
		this.#displayOverride = display;
		this.#saveInline(from);
		this.#saveInline(to);
		if (this.lockScroll) {
			this.#savedBodyOverflow = document.body.style.overflow;
			document.body.style.overflow = "hidden";
		}
		return this.#morph(from, to, "showing");
	}
	/**
	* Morphs back from the target to the source. Called while showing, it
	* reverses the in-flight morph.
	* @returns {Promise<boolean>} true when settled, false if superseded or rejected
	*/
	hide() {
		if (this.#state === "idle" || this.#state === "hiding") {
			console.warn(`MorphEngine: hide() ignored — ${this.#state}`);
			return Promise.resolve(false);
		}
		if (this.#state === "showing") return this.#reverse("hiding");
		return this.#morph(this.#targetElement, this.#sourceElement, "hiding");
	}
	/**
	* Aborts any morph and restores both elements to their pre-show resting state.
	*/
	stop() {
		if (this.#state === "idle") return;
		this.#supersede();
		this.#spring.stop();
		this.#removeBlob();
		const source = this.#sourceElement;
		const target = this.#targetElement;
		if (source) {
			this.#restoreInline(source);
			source.removeAttribute("morphing");
		}
		if (target) {
			this.#restoreInline(target);
			target.removeAttribute("morphing");
			target.removeAttribute("morph-shown");
		}
		this.#unlockScroll();
		const progress = this.#p;
		this.#state = "idle";
		this.#p = 0;
		this.emit("stop", { progress });
	}
	/**
	* Stops and removes all listeners. The engine is unusable afterwards.
	*/
	destroy() {
		this.stop();
		this.#spring.removeAllListeners();
		this.removeAllListeners();
	}
	/** @param {number} attraction - Spring attraction (0, 1) exclusive, live-tunable */
	setAttraction(attraction) {
		this.#spring.setAttraction(attraction);
	}
	/** @param {number} friction - Spring friction (0, 1) exclusive, live-tunable */
	setFriction(friction) {
		this.#spring.setFriction(friction);
	}
	/**
	* The single morph routine — show and hide are the same mechanics with the
	* roles swapped. The blob starts pixel-identical to fromElement (its content
	* cloned and frozen on top), springs to toElement's rect and styles, and
	* reveals toElement across the final stretch.
	*/
	#morph(fromElement, toElement, phase) {
		this.#supersede();
		const fromMeasure = this.#measure(fromElement);
		const toMeasure = this.#measure(toElement);
		this.#fromMeasure = fromMeasure;
		this.#toMeasure = toMeasure;
		this.#toElement = toElement;
		this.#shownPosition = phase === "showing" ? TRAVEL : 0;
		this.#state = phase;
		this.#revealed = false;
		this.#sourceRevealed = false;
		this.#revealStart = this.revealAt;
		this.#revealFull = this.revealAt + (1 - this.revealAt) / 2;
		this.#sourceRevealUntil = this.sourceRevealUntil;
		this.#reconcileBorderColors(fromMeasure, toMeasure);
		this.#frames = new FrameEngine(this.#buildKeyframes(fromMeasure, toMeasure));
		this.#removeBlob();
		this.#createBlob(fromMeasure, toMeasure);
		this.#markElements(phase);
		fromElement.style.transition = "none";
		toElement.style.transition = "none";
		fromElement.style.visibility = "hidden";
		toElement.style.visibility = "hidden";
		toElement.style.opacity = "0";
		this.#applyFrame(0);
		this.emit(phase === "showing" ? "show" : "hide", {
			from: this.#sourceElement,
			to: this.#targetElement
		});
		const promise = new Promise((resolve) => {
			this.#resolveRun = resolve;
		});
		this.#armSettle(0, TRAVEL);
		this.#spring.animateTo(0, TRAVEL);
		return promise;
	}
	/**
	* Reverses the in-flight morph. The keyframe mapping, blob, and clone are all
	* pure functions of p, so travelling back unwinds everything automatically —
	* the reveal window un-reveals, the clone fades back in, and the blob lands
	* exactly where it started.
	*/
	#reverse(newPhase) {
		this.#supersede();
		this.#state = newPhase;
		this.#markElements(newPhase);
		const targetPosition = newPhase === "showing" ? this.#shownPosition : TRAVEL - this.#shownPosition;
		this.emit(newPhase === "showing" ? "show" : "hide", {
			from: this.#sourceElement,
			to: this.#targetElement
		});
		const promise = new Promise((resolve) => {
			this.#resolveRun = resolve;
		});
		this.#armSettle(this.#p * TRAVEL, targetPosition);
		this.#spring.animateTo(this.#p * TRAVEL, targetPosition);
		return promise;
	}
	/**
	* Arms the early-settle detector for a fresh run. Called at every animateTo so
	* a reversal never inherits stale proximity state from the run it interrupts.
	* @param {number} startPosition - Spring position the run begins from
	* @param {number} target - Spring position the run is heading toward
	*/
	#armSettle(startPosition, target) {
		this.#springTarget = target;
		this.#lastPosition = startPosition;
		this.#settleCount = 0;
	}
	/**
	* Spring settled — finalize whichever logical state we were heading toward.
	* The spring's final change event already applied the exact end frame.
	*/
	#settle() {
		if (this.#state !== "showing" && this.#state !== "hiding") return;
		const resolve = this.#resolveRun;
		this.#resolveRun = null;
		if (this.#state === "showing") this.#finalizeShown();
		else this.#finalizeHidden();
		if (resolve) resolve(true);
	}
	#finalizeShown() {
		this.#removeBlob();
		const source = this.#sourceElement;
		const target = this.#targetElement;
		this.#restoreProperties(target, [
			"opacity",
			"transform",
			"transformOrigin",
			"willChange",
			"transition"
		]);
		target.style.visibility = "visible";
		this.#restoreProperties(source, [
			"opacity",
			"transform",
			"transformOrigin",
			"willChange"
		]);
		source.style.visibility = "hidden";
		source.removeAttribute("morphing");
		target.removeAttribute("morphing");
		target.setAttribute("morph-shown", "");
		this.#state = "shown";
		this.emit("shown", {
			from: source,
			to: target
		});
	}
	#finalizeHidden() {
		this.#removeBlob();
		const source = this.#sourceElement;
		const target = this.#targetElement;
		this.#restoreInline(source);
		this.#restoreInline(target);
		source.removeAttribute("morphing");
		target.removeAttribute("morphing");
		target.removeAttribute("morph-shown");
		this.#unlockScroll();
		this.#state = "idle";
		this.#p = 0;
		this.emit("hidden", {
			from: source,
			to: target
		});
	}
	#unlockScroll() {
		if (this.#savedBodyOverflow === null) return;
		document.body.style.overflow = this.#savedBodyOverflow;
		this.#savedBodyOverflow = null;
	}
	/** Resolves a superseded run's promise with false. */
	#supersede() {
		if (this.#resolveRun) {
			this.#resolveRun(false);
			this.#resolveRun = null;
		}
	}
	/**
	* The whole visual state as a pure function of p. Reveal handling is an
	* idempotent check rather than a one-shot flag so a reversed spring that
	* swings p back down automatically un-reveals the target.
	*/
	#applyFrame(p) {
		const styles = this.#frames.getFrame(p);
		for (const property of CLAMP_POSITIVE) if (property in styles && parseFloat(styles[property]) < 0) styles[property] = "0px";
		Object.assign(this.#blob.style, styles);
		this.#blob.style.boxShadow = lerpShadow(this.#fromMeasure.shadow, this.#toMeasure.shadow, p);
		if (this.#cloneWrapper) {
			const fade = this.cloneFadeUntil > 0 ? clamp(1 - p / this.cloneFadeUntil, 0, 1) : p <= 0 ? 1 : 0;
			this.#cloneWrapper.style.opacity = String(fade);
		}
		if (p >= this.#revealStart) {
			this.#ensureRevealed();
			const target = this.#toElement;
			const naturalRect = this.#toMeasure.rect;
			const blobRect = {
				top: parseFloat(styles.top),
				left: parseFloat(styles.left),
				width: parseFloat(styles.width),
				height: parseFloat(styles.height)
			};
			const fadeProgress = clamp((p - this.#revealStart) / (this.#revealFull - this.#revealStart), 0, 1);
			target.style.opacity = String(fadeProgress);
			target.style.transformOrigin = "0 0";
			target.style.transform = `translate(${round(blobRect.left - naturalRect.left)}px, ${round(blobRect.top - naturalRect.top)}px) scale(${blobRect.width / naturalRect.width}, ${blobRect.height / naturalRect.height})`;
		} else this.#ensureUnrevealed();
		if (p <= this.#sourceRevealUntil) {
			this.#ensureSourceRevealed();
			const source = this.#fromMeasure.element;
			const naturalRect = this.#fromMeasure.rect;
			const blobRect = {
				top: parseFloat(styles.top),
				left: parseFloat(styles.left),
				width: parseFloat(styles.width),
				height: parseFloat(styles.height)
			};
			const half = this.#sourceRevealUntil / 2;
			const sourceOpacity = clamp((this.#sourceRevealUntil - p) / half, 0, 1);
			source.style.opacity = String(sourceOpacity);
			source.style.transformOrigin = "0 0";
			source.style.transform = `translate(${round(blobRect.left - naturalRect.left)}px, ${round(blobRect.top - naturalRect.top)}px) scale(${blobRect.width / naturalRect.width}, ${blobRect.height / naturalRect.height})`;
			const quarter = half / 2;
			const blobFactor = clamp((p - quarter) / quarter, 0, 1);
			this.#blob.style.opacity = String(parseFloat(styles.opacity ?? "1") * blobFactor);
		} else this.#ensureSourceUnrevealed();
	}
	#ensureRevealed() {
		if (this.#revealed) return;
		this.#revealed = true;
		const target = this.#toElement;
		if (this.#toMeasure.wasDisplayNone) target.style.display = this.#displayOverride || "block";
		target.style.visibility = "visible";
		target.style.willChange = "transform, opacity";
		this.emit("reveal", {
			from: this.#fromMeasure.element,
			to: target
		});
	}
	#ensureUnrevealed() {
		if (!this.#revealed) return;
		this.#revealed = false;
		const target = this.#toElement;
		target.style.visibility = "hidden";
		target.style.opacity = "0";
		this.emit("unreveal", {
			from: this.#fromMeasure.element,
			to: target
		});
	}
	/**
	* Source mirror of #ensureRevealed — makes the real from-element paintable so it
	* can crossfade in under the blob at the p→0 end. Idempotent.
	*/
	#ensureSourceRevealed() {
		if (this.#sourceRevealed) return;
		this.#sourceRevealed = true;
		const source = this.#fromMeasure.element;
		if (this.#fromMeasure.wasDisplayNone) source.style.display = this.#displayOverride || "block";
		source.style.visibility = "visible";
		source.style.willChange = "transform, opacity";
	}
	/**
	* Source mirror of #ensureUnrevealed — re-hides the from-element once p leaves the
	* source window. Transform/willChange residue is cleared at finalize. Idempotent.
	*/
	#ensureSourceUnrevealed() {
		if (!this.#sourceRevealed) return;
		this.#sourceRevealed = false;
		const source = this.#fromMeasure.element;
		source.style.visibility = "hidden";
		source.style.opacity = "0";
	}
	/**
	* Measures an element's viewport rect and captured computed styles. A
	* display:none element is flipped on invisibly for one synchronous read.
	* (visibility:hidden elements keep their layout and measure normally.)
	*/
	#measure(element) {
		let restore = null;
		if (element.getClientRects().length === 0) {
			const style = element.style;
			restore = {
				display: style.display,
				visibility: style.visibility,
				transition: style.transition
			};
			style.transition = "none";
			style.visibility = "hidden";
			style.display = this.#displayOverride || "block";
		}
		const rect = element.getBoundingClientRect();
		const computed = getComputedStyle(element);
		const styles = {};
		for (const property of this.#styleProperties) styles[property] = computed[property];
		const measure = {
			element,
			rect,
			styles,
			shadow: parseShadow(computed.boxShadow),
			borderStyle: computed.borderTopStyle,
			backdropFilter: computed.backdropFilter || computed.webkitBackdropFilter,
			backgroundImage: computed.backgroundImage,
			backgroundSize: computed.backgroundSize,
			backgroundRepeat: computed.backgroundRepeat,
			backgroundPosition: computed.backgroundPosition,
			wasDisplayNone: restore !== null
		};
		if (restore) Object.assign(element.style, restore);
		return measure;
	}
	/**
	* A borderless element's computed border-color falls back to currentColor (its
	* text color), and `transparent` computes to rgba(0,0,0,0) — lerping toward
	* either drags the visible end's border through an unrelated hue while the
	* width or alpha collapses. Rewrite the degenerate end's color so only
	* width/alpha animate: an absent border holds the visible end's color
	* verbatim, a fully transparent one holds its hue at alpha 0.
	*/
	#reconcileBorderColors(fromMeasure, toMeasure) {
		const absent = (measure) => measure.borderStyle === "none" || BORDER_SIDES.every((side) => parseFloat(measure.styles[`border${side}Width`]) === 0);
		const fromAbsent = absent(fromMeasure);
		const toAbsent = absent(toMeasure);
		if (fromAbsent && toAbsent) return;
		for (const side of BORDER_SIDES) {
			const key = `border${side}Color`;
			const fromColor = fromMeasure.styles[key];
			const toColor = toMeasure.styles[key];
			if (!fromColor || !toColor) continue;
			const fromDegenerate = fromAbsent || parseColor(fromColor).alpha === 0;
			if (fromDegenerate === (toAbsent || parseColor(toColor).alpha === 0)) continue;
			const visibleColor = fromDegenerate ? toColor : fromColor;
			const { red, green, blue } = parseColor(visibleColor);
			const replacement = (fromDegenerate ? fromAbsent : toAbsent) ? visibleColor : `rgba(${red}, ${green}, ${blue}, 0)`;
			(fromDegenerate ? fromMeasure : toMeasure).styles[key] = replacement;
		}
	}
	#buildKeyframes(fromMeasure, toMeasure) {
		const rectStyles = (rect) => ({
			top: `${rect.top}px`,
			left: `${rect.left}px`,
			width: `${rect.width}px`,
			height: `${rect.height}px`
		});
		const blobClear = this.#revealFull + (1 - this.#revealFull) / 2;
		return {
			0: {
				...rectStyles(fromMeasure.rect),
				...fromMeasure.styles
			},
			[this.#revealFull * 100]: { opacity: "1" },
			[blobClear * 100]: { opacity: "0" },
			100: {
				...rectStyles(toMeasure.rect),
				...toMeasure.styles
			}
		};
	}
	#createBlob(fromMeasure, toMeasure) {
		const blob = document.createElement("morph-blob");
		const borderStyle = toMeasure.borderStyle !== "none" ? toMeasure.borderStyle : fromMeasure.borderStyle !== "none" ? fromMeasure.borderStyle : "solid";
		Object.assign(blob.style, {
			position: "fixed",
			top: "0",
			left: "0",
			margin: "0",
			boxSizing: "border-box",
			pointerEvents: "none",
			overflow: "hidden",
			display: "block",
			zIndex: String(this.zIndex),
			borderStyle,
			willChange: "top, left, width, height, opacity"
		});
		const backdropFilter = toMeasure.backdropFilter !== "none" ? toMeasure.backdropFilter : fromMeasure.backdropFilter !== "none" ? fromMeasure.backdropFilter : null;
		if (backdropFilter) {
			blob.style.backdropFilter = backdropFilter;
			blob.style.webkitBackdropFilter = backdropFilter;
		}
		const backgroundMeasure = toMeasure.backgroundImage !== "none" ? toMeasure : fromMeasure.backgroundImage !== "none" ? fromMeasure : null;
		if (backgroundMeasure) {
			blob.style.backgroundImage = backgroundMeasure.backgroundImage;
			blob.style.backgroundSize = backgroundMeasure.backgroundSize;
			blob.style.backgroundRepeat = backgroundMeasure.backgroundRepeat;
			blob.style.backgroundPosition = backgroundMeasure.backgroundPosition;
		}
		if (this.cloneContents) this.#createClone(blob, fromMeasure);
		document.body.appendChild(blob);
		this.#blob = blob;
	}
	/**
	* Freezes a visual copy of the source's content inside the blob. The wrapper
	* keeps the source's original dimensions so text never rewraps as the blob
	* resizes; the blob's overflow:hidden clips it. The clone's own surface
	* (background, border, shadow) is stripped — the blob renders the surface.
	*/
	#createClone(blob, fromMeasure) {
		const clone = fromMeasure.element.cloneNode(true);
		clone.removeAttribute("id");
		clone.removeAttribute("morphing");
		Object.assign(clone.style, {
			position: "static",
			margin: "0",
			width: "100%",
			height: "100%",
			transform: "none",
			transition: "none",
			visibility: "visible",
			opacity: "1",
			boxShadow: "none",
			background: "transparent",
			borderColor: "transparent"
		});
		const wrapper = document.createElement("div");
		Object.assign(wrapper.style, {
			position: "absolute",
			top: "0",
			left: "0",
			width: `${fromMeasure.rect.width}px`,
			height: `${fromMeasure.rect.height}px`,
			pointerEvents: "none"
		});
		wrapper.appendChild(clone);
		blob.appendChild(wrapper);
		this.#cloneWrapper = wrapper;
	}
	#removeBlob() {
		if (!this.#blob) return;
		this.#blob.remove();
		this.#blob = null;
		this.#cloneWrapper = null;
	}
	/** Marks both elements for CSS hooks — which one the blob is flying away from. */
	#markElements(phase) {
		const showing = phase === "showing";
		this.#sourceElement.setAttribute("morphing", showing ? "source" : "target");
		this.#targetElement.setAttribute("morphing", showing ? "target" : "source");
	}
	#saveInline(element) {
		const saved = {};
		for (const property of MANAGED_PROPERTIES) saved[property] = element.style[property];
		this.#savedInline.set(element, saved);
	}
	#restoreProperties(element, properties) {
		const saved = this.#savedInline.get(element) || {};
		const hasTransition = properties.includes("transition");
		for (const property of properties) {
			if (property === "transition") continue;
			element.style[property] = saved[property] ?? "";
		}
		if (hasTransition) {
			element.offsetWidth;
			element.style.transition = saved.transition ?? "";
		}
	}
	#restoreInline(element) {
		this.#restoreProperties(element, MANAGED_PROPERTIES);
		this.#savedInline.delete(element);
	}
};
//#endregion
export { MorphEngine };

//# sourceMappingURL=morph-engine.esm.js.map