class EventEmitter {
	#events;

	constructor() {
		this.#events = new Map();
	}

	/**
	 * Binds a listener to an event.
	 * @param {string} event - The event to bind the listener to.
	 * @param {Function} listener - The listener function to bind.
	 * @returns {EventEmitter} The current instance for chaining.
	 */
	on(event, listener) {
		if (typeof listener !== 'function') {
			throw new TypeError('Listener must be a function');
		}

		const listeners = this.#events.get(event) || [];
		if (!listeners.includes(listener)) listeners.push(listener);
		this.#events.set(event, listeners);
		return this;
	}

	/**
	 * Unbinds a listener from an event.
	 * @param {string} event - The event to unbind.
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
	 * Emits an event.
	 * @param {string} event - Event name.
	 * @param {...*} args - Listener arguments.
	 * @returns {boolean} Whether the event had listeners.
	 */
	emit(event, ...args) {
		const listeners = this.#events.get(event);
		if (!listeners || listeners.length === 0) return false;

		for (const listener of listeners.slice()) {
			try {
				listener.apply(this, args);
			} catch (error) {
				console.error(`Error in listener for event '${event}':`, error);
			}
		}
		return true;
	}

	/**
	 * Removes listeners for one event or all events.
	 * @param {string} [event] - Optional event name.
	 * @returns {EventEmitter} The current instance for chaining.
	 */
	removeAllListeners(event) {
		if (event) this.#events.delete(event);
		else this.#events.clear();
		return this;
	}
}

export default EventEmitter;
