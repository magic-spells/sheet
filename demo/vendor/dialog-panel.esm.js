/**
 * DialogPanel - A lightweight web component wrapper for native <dialog> elements
 * with state-driven animations.
 *
 * @extends HTMLElement
 *
 * @property {string} state - Current state: 'hidden' | 'showing' | 'shown' | 'hiding'
 * @property {HTMLDialogElement} dialog - Reference to inner <dialog> element
 * @property {boolean} isOpen - True if state is 'showing' or 'shown'
 * @property {HTMLElement|null} triggerElement - Element that triggered current action
 * @property {Object|null} morphEngine - Optional duck-typed morph transition engine
 *
 * @fires beforeShow - Fired before showing starts (cancelable)
 * @fires shown - Fired after show animation completes
 * @fires beforeHide - Fired before hiding starts (cancelable)
 * @fires hidden - Fired after hide animation completes
 */
class DialogPanel extends HTMLElement {
	// Private fields
	#state = 'hidden';
	#triggerElement = null;
	#dialog = null;
	#result = null;
	#hideTriggerElement = null;
	#morphEngine = null;
	#morphListenersAttached = false;

	// Event handler references for cleanup
	#handlers = {
		click: null,
		dialogClick: null,
		cancel: null,
		close: null,
		morphReveal: null,
		morphShown: null,
		morphHidden: null,
		morphStop: null,
	};

	// Animation cleanup references
	#pendingRAF = null;
	#pendingTimeout = null;

	// Fallback timeout for transitionend (in ms)
	static TRANSITION_FALLBACK_TIMEOUT = 700;

	connectedCallback() {
		const _ = this;

		// Find inner dialog element
		_.#dialog = _.querySelector('dialog');

		if (!_.#dialog) {
			console.warn(
				'DialogPanel: No <dialog> element found inside <dialog-panel>'
			);
			return;
		}

		// Auto-create dialog-backdrop if not present
		if (!_.querySelector('dialog-backdrop')) {
			const backdrop = document.createElement('dialog-backdrop');
			_.insertBefore(backdrop, _.firstChild);
		}

		// Set initial state attribute
		_.#setState('hidden');

		// Bind event handlers
		_.#bindEvents();
		_.#wireMorphEngine();
	}

	disconnectedCallback() {
		const _ = this;

		// Cancel pending animations
		if (_.#pendingRAF) {
			cancelAnimationFrame(_.#pendingRAF);
			_.#pendingRAF = null;
		}
		if (_.#pendingTimeout) {
			clearTimeout(_.#pendingTimeout);
			_.#pendingTimeout = null;
		}
		_.#unwireMorphEngine();

		// Clean up event listeners
		if (_.#handlers.click) {
			_.removeEventListener('click', _.#handlers.click);
		}
		if (_.#dialog) {
			if (_.#handlers.dialogClick) {
				_.#dialog.removeEventListener(
					'click',
					_.#handlers.dialogClick
				);
			}
			if (_.#handlers.cancel) {
				_.#dialog.removeEventListener('cancel', _.#handlers.cancel);
			}
			if (_.#handlers.close) {
				_.#dialog.removeEventListener('close', _.#handlers.close);
			}
		}
	}

	/**
	 * Bind event listeners for close buttons, backdrop, and escape key
	 * @private
	 */
	#bindEvents() {
		const _ = this;

		// Handle close buttons with data-action-hide-dialog
		_.#handlers.click = (e) => {
			const trigger = e.target.closest('[data-action-hide-dialog]');
			if (trigger) {
				e.stopPropagation();
				_.hide(trigger);
			}
		};
		_.addEventListener('click', _.#handlers.click);

		// Handle backdrop click - detect clicks outside dialog bounds
		// This works because clicks on ::backdrop still fire on the dialog element
		_.#handlers.dialogClick = (e) => {
			const rect = _.#dialog.getBoundingClientRect();
			const clickedOutside =
				e.clientX < rect.left ||
				e.clientX > rect.right ||
				e.clientY < rect.top ||
				e.clientY > rect.bottom;
			if (clickedOutside) {
				e.stopPropagation();
				_.hide();
			}
		};
		_.#dialog.addEventListener('click', _.#handlers.dialogClick);

		// Handle escape key - intercept native cancel and animate close
		_.#handlers.cancel = (e) => {
			e.preventDefault();
			e.stopPropagation();
			_.hide();
		};
		_.#dialog.addEventListener('cancel', _.#handlers.cancel);

		// Cover force-close paths that bypass the cancel event: a
		// <form method="dialog"> submit, or app code calling dialog.close().
		//
		// Invariant: the panel must never read state='shown' while the dialog
		// is closed. The overlay opacity, the page scroll lock, and show()'s
		// own early return all key on that state, so a panel left there after
		// a native close is invisible, keeps the page locked, and can never be
		// reopened.
		//
		// The `close` event is queued rather than dispatched synchronously, so
		// every close this component drives itself has already moved the state
		// past 'shown' by the time this runs. Reaching here means something
		// else closed the dialog.
		_.#handlers.close = () => {
			const forceClosedDirect =
				(_.#state === 'showing' || _.#state === 'shown') &&
				_.#morphEngine?.animatesDialog &&
				!_.#dialog.open;

			if (forceClosedDirect) {
				_.#result = _.#dialog.returnValue || _.#result;
				_.#morphEngine.stop();
				if (_.#state !== 'hidden') _.#finalizeHidden();
				return;
			}

			const forceClosedShown =
				_.#state === 'shown' && !_.#dialog.open;

			// The same break one state earlier: a force-close landing
			// between showModal() and the frame that promotes to 'shown'.
			// Left alone that pending frame writes state='shown' onto a
			// closed dialog and re-creates the exact stuck panel the
			// 'shown' repair exists to prevent.
			//
			// #pendingRAF is what identifies a CSS open: it is armed in the
			// same task as showModal() and nulled by the frame that
			// promotes, so it is non-null for exactly as long as the panel
			// sits in a CSS 'showing'. Engine paths never arm it and are
			// repaired by their own choreography. That also excludes a
			// proxy reversal, which can still be holding the queued close
			// event of the hide it reversed.
			const forceClosedShowing =
				_.#state === 'showing' &&
				_.#pendingRAF !== null &&
				!_.#dialog.open;

			if (!forceClosedShown && !forceClosedShowing) return;

			// Cancel the promotion before repairing, mirroring
			// disconnectedCallback — #finalizeHidden below sets 'hidden' and
			// a surviving frame would overwrite it with 'shown'. Inert in
			// 'shown', where the promoting frame already nulled the handle.
			// #pendingTimeout needs no matching clear: #waitForTransition
			// does not run until that same promotion frame.
			if (_.#pendingRAF) {
				cancelAnimationFrame(_.#pendingRAF);
				_.#pendingRAF = null;
			}

			// A morph engine owns its own exit, so it still routes through
			// hide() exactly as before. Only reachable from 'shown' — a
			// morph 'showing' never passes the guard above
			if (_.#morphEngine?.state === 'shown') {
				_.hide();
				return;
			}

			// Everything else repairs straight to 'hidden' instead of running
			// hide(). The dialog is already gone, so there is no exit
			// transition left to play: transitionend never fires on a
			// display:none dialog, and hide() would idle in 'hiding' —
			// refusing every show() — until its 700ms fallback. beforeHide is
			// not offered either. It is cancelable, and cancelling cannot
			// reopen a dialog the browser has already closed; it would only
			// strand the panel in the broken state again.
			_.#result = _.#dialog.returnValue || _.#result;
			_.#finalizeHidden();
		};
		_.#dialog.addEventListener('close', _.#handlers.close);
	}

	/**
	 * Wire morph engine lifecycle listeners
	 * @private
	 */
	#wireMorphEngine() {
		const _ = this;

		if (!_.#morphEngine || _.#morphListenersAttached) return;

		if (!_.#handlers.morphShown) {
			_.#handlers.morphReveal = _.#handleMorphReveal.bind(_);
			_.#handlers.morphShown = _.#handleMorphShown.bind(_);
			_.#handlers.morphHidden = _.#handleMorphHidden.bind(_);
			_.#handlers.morphStop = _.#handleMorphStop.bind(_);
		}

		_.#morphEngine.on('reveal', _.#handlers.morphReveal);
		_.#morphEngine.on('shown', _.#handlers.morphShown);
		_.#morphEngine.on('hidden', _.#handlers.morphHidden);
		_.#morphEngine.on('stop', _.#handlers.morphStop);
		_.#morphListenersAttached = true;
	}

	/**
	 * Promote a proxy engine's target at its reveal point — the target is
	 * still at opacity 0 and the scrim only partially faded, so the top-layer
	 * insertion (dialog + ::backdrop) lands over the least visible glass.
	 * Promoting at settle instead inserts above a fully visible
	 * backdrop-filter layer, which the compositor re-rasterizes — a visible
	 * shimmer on GPU-heavy pages.
	 * @param {Object} detail - Reveal event detail
	 * @private
	 */
	#handleMorphReveal(detail) {
		const _ = this;

		if (
			_.#state === 'showing' &&
			detail?.to === _.#dialog &&
			!_.#dialog.open
		) {
			_.#dialog.showModal();
		}
	}

	/**
	 * Unwire morph engine lifecycle listeners
	 * @private
	 */
	#unwireMorphEngine() {
		const _ = this;

		if (!_.#morphEngine || !_.#morphListenersAttached) return;

		_.#morphEngine.off('reveal', _.#handlers.morphReveal);
		_.#morphEngine.off('shown', _.#handlers.morphShown);
		_.#morphEngine.off('hidden', _.#handlers.morphHidden);
		_.#morphEngine.off('stop', _.#handlers.morphStop);
		_.#morphListenersAttached = false;
	}

	/**
	 * Promote the settled morph target into the dialog top layer
	 * @private
	 */
	#handleMorphShown() {
		const _ = this;

		if (!_.#dialog.open) _.#dialog.showModal();
		_.#setState('shown');
		_.#emit('shown');
	}

	/**
	 * Finalize a settled morph hide
	 * @private
	 */
	#handleMorphHidden() {
		this.#finalizeHidden();
	}

	/**
	 * Finalize an interrupted morph as hidden
	 * @private
	 */
	#handleMorphStop() {
		this.#finalizeHidden();
	}

	/**
	 * Close out to the hidden state without an exit animation — shared by a
	 * settled or interrupted morph and by the force-close repair, both of
	 * which arrive with nothing left to animate
	 * @private
	 */
	#finalizeHidden() {
		const _ = this;

		if (_.#dialog.open) _.#dialog.close();
		_.#setState('hidden');
		_.#emit('hidden', {
			result: _.#result,
			triggerElement: _.#hideTriggerElement,
		});

		// Return focus to trigger element
		if (_.#triggerElement) _.#triggerElement.focus();

		// Clean up
		_.#triggerElement = null;
		_.#hideTriggerElement = null;
		_.#result = null;
	}

	/**
	 * Show the dialog with animation
	 * @param {HTMLElement} [triggerEl=null] - The element that triggered the show
	 * @returns {boolean} False if show was prevented via beforeShow event
	 */
	show(triggerEl = null) {
		const _ = this;
		const engine = _.#morphEngine;
		const direct = !!engine?.animatesDialog;

		// Check if already showing/shown
		if (_.#state === 'showing' || _.#state === 'shown') return true;

		const reversingMorph =
			_.#state === 'hiding' && engine?.state === 'hiding';

		// CSS transitions cannot reverse while hiding
		if (_.#state === 'hiding' && !reversingMorph) return false;

		// Store trigger element for focus return later
		if (!reversingMorph) _.#triggerElement = triggerEl || null;

		// Fire beforeShow (cancelable)
		if (!_.#emit('beforeShow', { cancelable: true })) return false;

		if (reversingMorph) {
			_.#hideTriggerElement = null;
			_.#result = null;
		}

		// Set state to 'showing'
		_.#setState('showing');

		if (engine && (direct || triggerEl || reversingMorph)) {
			engine.show({
				from: _.#triggerElement,
				to: _.#dialog,
				display: _.getAttribute('morph-display') || 'block',
			});

			// Only a direct engine is promoted here — its hidden frame is already
			// painted, so the promotion repaint lands on nothing visible. A proxy
			// engine keeps the legacy choreography: promotion waits for its
			// settled 'shown'.
			if (direct && !_.#dialog.open) {
				_.#dialog.showModal();
			}

			if (
				direct &&
				engine.state === 'shown' &&
				_.#state === 'showing'
			) {
				_.#handleMorphShown();
			}
			return true;
		}

		// Open native dialog for the CSS transition path
		_.#dialog.showModal();

		// Double RAF ensures browser has painted the 'showing' state
		// before we transition to 'shown'
		_.#pendingRAF = requestAnimationFrame(() => {
			_.#pendingRAF = requestAnimationFrame(() => {
				_.#pendingRAF = null;
				_.#setState('shown');

				// Wait for transition to complete before firing 'shown' event
				_.#waitForTransition(() => {
					_.#emit('shown');
				});
			});
		});

		return true;
	}

	/**
	 * Hide the dialog with animation
	 * @param {HTMLElement} [triggerEl=null] - The element that triggered the hide
	 * @returns {boolean} False if hide was prevented via beforeHide event
	 */
	hide(triggerEl = null) {
		const _ = this;
		const engine = _.#morphEngine;
		const direct = !!engine?.animatesDialog;

		// Check if already hiding/hidden
		if (_.#state === 'hiding' || _.#state === 'hidden') return true;

		const reversingMorph =
			_.#state === 'showing' && engine?.state === 'showing';

		// CSS transitions cannot reverse while showing
		if (_.#state === 'showing' && !reversingMorph && !direct) {
			return false;
		}

		// Capture result from trigger element
		_.#result = triggerEl?.dataset?.result ?? null;

		// Fire beforeHide (cancelable)
		if (
			!_.#emit('beforeHide', {
				cancelable: true,
				result: _.#result,
				triggerElement: triggerEl,
			})
		) {
			return false;
		}

		if (direct) {
			_.#hideTriggerElement = triggerEl;

			if (engine.state !== 'showing' && engine.state !== 'shown') {
				_.#finalizeHidden();
				return true;
			}

			engine.hide();
			_.#setState('hiding');
			return true;
		}

		if (reversingMorph || engine?.state === 'shown') {
			_.#hideTriggerElement = triggerEl;
			if (_.#dialog.open) _.#dialog.close();
			engine.hide();
			_.#setState('hiding');
			return true;
		}

		// Set state to 'hiding' - this triggers CSS exit animation
		_.#setState('hiding');

		// Wait for transition to complete
		_.#waitForTransition(() => {
			_.#dialog.close();
			_.#setState('hidden');
			_.#emit('hidden', {
				result: _.#result,
				triggerElement: triggerEl,
			});

			// Return focus to trigger element
			if (_.#triggerElement) _.#triggerElement.focus();

			// Clean up
			_.#triggerElement = null;
			_.#result = null;
		});

		return true;
	}

	/**
	 * Wait for CSS transition to complete with fallback timeout
	 * @param {Function} callback - Called when transition completes
	 * @private
	 */
	#waitForTransition(callback) {
		const _ = this;
		let called = false;
		let timerId = null;

		const done = () => {
			if (called) return;
			called = true;
			_.#dialog.removeEventListener('transitionend', onTransitionEnd);
			// clear only our own timer — clearing the shared field would let an
			// earlier, still-pending wait cancel a later wait's fallback
			clearTimeout(timerId);
			if (_.#pendingTimeout === timerId) _.#pendingTimeout = null;
			callback();
		};

		const onTransitionEnd = (e) => {
			if (e.target === _.#dialog) done();
		};

		_.#dialog.addEventListener('transitionend', onTransitionEnd);

		timerId = setTimeout(done, DialogPanel.TRANSITION_FALLBACK_TIMEOUT);
		_.#pendingTimeout = timerId;
	}

	/**
	 * Set the component state
	 * @param {string} newState - The new state
	 * @private
	 */
	#setState(newState) {
		this.#state = newState;
		this.setAttribute('state', newState);
	}

	/**
	 * Emit a custom event
	 * @param {string} name - Event name
	 * @param {Object} options - Event options
	 * @returns {boolean} False if event was cancelled
	 * @private
	 */
	#emit(name, options = {}) {
		const _ = this;
		const { cancelable = false, ...detail } = options;

		const event = new CustomEvent(name, {
			bubbles: true,
			composed: true,
			cancelable,
			detail: {
				triggerElement: _.#triggerElement,
				result: _.#result,
				state: _.#state,
				...detail,
			},
		});

		return _.dispatchEvent(event);
	}

	/**
	 * Optional morph transition transport
	 * @returns {Object|null} The attached morph engine
	 */
	get morphEngine() {
		return this.#morphEngine;
	}

	/**
	 * Attach or remove a duck-typed morph transition engine
	 * @param {Object|null} engine - Engine with show, hide, state, on, and off
	 */
	set morphEngine(engine) {
		const _ = this;

		if (_.#morphEngine === engine) return;

		if (_.#morphEngine && _.#state !== 'hidden') {
			_.#morphEngine.stop();
			if (_.#state !== 'hidden') _.#finalizeHidden();
		}

		_.#unwireMorphEngine();
		_.#morphEngine = engine || null;

		if (_.#morphEngine) {
			_.setAttribute('morph', '');
			_.#wireMorphEngine();
		} else {
			_.removeAttribute('morph');
		}
	}

	// Read-only properties
	get state() {
		return this.#state;
	}
	get dialog() {
		return this.#dialog;
	}
	get isOpen() {
		return this.#state === 'showing' || this.#state === 'shown';
	}
	get triggerElement() {
		return this.#triggerElement;
	}
}

/**
 * DialogBackdrop - A custom backdrop element that animates with the dialog-panel state.
 * Use this instead of native ::backdrop for consistent cross-browser animations.
 *
 * @extends HTMLElement
 */
class DialogBackdrop extends HTMLElement {
	#panel = null;
	#handlers = {
		click: null,
	};

	connectedCallback() {
		const _ = this;

		// Find parent dialog-panel
		_.#panel = _.closest('dialog-panel');

		if (!_.#panel) {
			console.warn(
				'DialogBackdrop: Must be inside a <dialog-panel> element'
			);
			return;
		}

		// Handle click to close
		_.#handlers.click = () => {
			_.#panel.hide();
		};
		_.addEventListener('click', _.#handlers.click);
	}

	disconnectedCallback() {
		const _ = this;
		if (_.#handlers.click) {
			_.removeEventListener('click', _.#handlers.click);
		}
	}
}

// Register the custom elements
// Note: dialog-backdrop must be defined BEFORE dialog-panel,
// because dialog-panel's connectedCallback may create dialog-backdrop elements
if (!customElements.get('dialog-backdrop')) {
	customElements.define('dialog-backdrop', DialogBackdrop);
}
if (!customElements.get('dialog-panel')) {
	customElements.define('dialog-panel', DialogPanel);
}

export { DialogBackdrop, DialogPanel };
//# sourceMappingURL=dialog-panel.esm.js.map
