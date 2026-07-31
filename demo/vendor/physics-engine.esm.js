class f {
  #t;
  constructor() {
    this.#t = /* @__PURE__ */ new Map();
  }
  /**
   * Binds a listener to an event.
   * @param {string} event - The event to bind the listener to.
   * @param {Function} listener - The listener function to bind.
   * @returns {EventEmitter} The current instance for chaining.
   * @throws {TypeError} If the listener is not a function.
   */
  on(t, i) {
    if (typeof i != "function")
      throw new TypeError("Listener must be a function");
    const s = this.#t.get(t) || [];
    return s.includes(i) || s.push(i), this.#t.set(t, s), this;
  }
  /**
   * Unbinds a listener from an event.
   * @param {string} event - The event to unbind the listener from.
   * @param {Function} listener - The listener function to unbind.
   * @returns {EventEmitter} The current instance for chaining.
   */
  off(t, i) {
    const s = this.#t.get(t);
    if (!s) return this;
    const e = s.indexOf(i);
    return e !== -1 && (s.splice(e, 1), s.length === 0 ? this.#t.delete(t) : this.#t.set(t, s)), this;
  }
  /**
   * Triggers an event and calls all bound listeners.
   * @param {string} event - The event to trigger.
   * @param {...*} args - Arguments to pass to the listener functions.
   * @returns {boolean} True if the event had listeners, false otherwise.
   */
  emit(t, ...i) {
    const s = this.#t.get(t);
    if (!s || s.length === 0) return !1;
    const e = s.slice();
    for (let n = 0, r = e.length; n < r; ++n)
      try {
        e[n].apply(this, i);
      } catch (h) {
        console.error(`Error in listener for event '${t}':`, h);
      }
    return !0;
  }
  /**
   * Removes all listeners for a specific event or all events.
   * @param {string} [event] - The event to remove listeners from. If not provided, removes all listeners.
   * @returns {EventEmitter} The current instance for chaining.
   */
  removeAllListeners(t) {
    return t ? this.#t.delete(t) : this.#t.clear(), this;
  }
}
class b extends f {
  #t;
  #m;
  #o;
  #n;
  #s;
  #e;
  #r;
  #h;
  #i;
  /**
   * Creates an instance of PhysicsEngine.
   * @param {number} [attraction=0.026] - The attraction value for physics-based animation (0 < attraction < 1).
   * @param {number} [friction=0.28] - The friction value for physics-based animation (0 < friction < 1).
   */
  constructor({ attraction: t = 0.026, friction: i = 0.28 } = {}) {
    if (super(), !Number.isFinite(t) || t <= 0 || t >= 1)
      throw new Error("Attraction must be a number between 0 and 1 (exclusive).");
    if (!Number.isFinite(i) || i <= 0 || i >= 1)
      throw new Error("Friction must be a number between 0 and 1 (exclusive).");
    this.#t = t, this.#m = i, this.#o = 1 - i, this.#n = 0, this.#s = 0, this.#e = 0, this.isAnimating = !1, this.#r = null, this.#h = 0, this.#i = null;
  }
  /**
   * Animates from a start value to an end value.
   * @param {number} startValue - The starting value.
   * @param {number} endValue - The target value.
   * @param {number} [velocity=0] - Initial velocity.
   * @returns {Promise} Resolves when animation completes or is stopped.
   */
  animateTo(t, i, s = 0) {
    if (!Number.isFinite(t))
      throw new Error("startValue must be a finite number.");
    if (!Number.isFinite(i))
      throw new Error("endValue must be a finite number.");
    if (!Number.isFinite(s))
      throw new Error("velocity must be a finite number.");
    if (this.isAnimating && this.#u(), t === i && s === 0)
      return this.emit("change", { position: i, progress: 1 }), this.emit("complete", { position: i, progress: 1 }), Promise.resolve();
    this.#s = t, this.#e = i, this.#n = s, this.isAnimating = !0, this.#r = null;
    const e = ++this.#h;
    return new Promise((n) => {
      this.#i = n;
      const r = (h) => {
        if (e !== this.#h || !this.isAnimating) return;
        if (this.#r === null) {
          this.#r = h, requestAnimationFrame(r);
          return;
        }
        const o = Math.min(h - this.#r, 64) / 16.66;
        this.#r = h;
        const l = (this.#e - this.#s) * this.#t;
        this.#n += l * o, this.#n *= Math.pow(this.#o, o), this.#s += this.#n * o;
        const m = this.#e - t;
        let u = 0;
        if (m !== 0 && (u = (this.#s - t) / m), this.emit("change", { position: this.#s, progress: u }), Math.abs(this.#s - this.#e) < 0.01 && Math.abs(this.#n) < 0.01) {
          this.isAnimating = !1;
          const c = this.#i;
          this.#i = null, this.emit("change", { position: this.#e, progress: 1 }), this.emit("complete", { position: this.#e, progress: 1 }), c();
          return;
        }
        requestAnimationFrame(r);
      };
      requestAnimationFrame(r);
    });
  }
  /**
   * Internal stop — resolves Promise without emitting 'stop'.
   * Used when a new animateTo supersedes the current one.
   */
  #u() {
    this.isAnimating = !1, this.#i && (this.#i(), this.#i = null);
  }
  /**
   * Stops the ongoing animation.
   * Emits 'stop' event and resolves the pending Promise.
   */
  stop() {
    if (!this.isAnimating) return;
    this.isAnimating = !1, this.#h++;
    const t = this.#i;
    this.#i = null, this.emit("stop", { position: this.#s }), t && t();
  }
  /**
   * Sets the attraction value
   * @param {number} attraction - The attraction value for physics-based animation (0 < attraction < 1).
   */
  setAttraction(t) {
    if (!Number.isFinite(t) || t <= 0 || t >= 1)
      throw new Error("Attraction must be a number between 0 and 1 (exclusive).");
    this.#t = t;
  }
  /**
   * Sets the friction value
   * @param {number} friction - The friction value for physics-based animation (0 < friction < 1).
   */
  setFriction(t) {
    if (!Number.isFinite(t) || t <= 0 || t >= 1)
      throw new Error("Friction must be a number between 0 and 1 (exclusive).");
    this.#m = t, this.#o = 1 - t;
  }
}
export {
  b as default
};
