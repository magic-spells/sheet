class MorphEngine {
	static instances = [];

	runs = [];
	reversals = [];
	stops = 0;

	#events = new Map();
	#state = 'idle';
	#source = null;
	#target = null;
	#from = null;
	#to = null;
	#blob = null;
	#saved = new Map();
	#p = 0;
	#revealed = false;
	#heldSource = null;

	constructor(options = {}) {
		this.zIndex = options.zIndex ?? 9999;
		this.lockScroll = options.lockScroll ?? true;
		this.cloneContents = options.cloneContents ?? true;
		this.attraction = options.attraction ?? 0.1;
		this.friction = options.friction ?? 0.32;
		MorphEngine.instances.push(this);
	}

	get state() {
		return this.#state;
	}

	get progress() {
		return this.#p;
	}

	on(name, listener) {
		const listeners = this.#events.get(name) || [];
		listeners.push(listener);
		this.#events.set(name, listeners);
		return this;
	}

	off(name, listener) {
		const listeners = (this.#events.get(name) || []).filter((entry) => entry !== listener);
		if (listeners.length) this.#events.set(name, listeners);
		else this.#events.delete(name);
		return this;
	}

	setAttraction(value) {
		this.attraction = value;
	}

	setFriction(value) {
		this.friction = value;
	}

	show({ from, to } = {}) {
		if (this.#state === 'showing' || this.#state === 'shown') return Promise.resolve(false);
		if (this.#state === 'hiding') {
			this.reversals.push({ from: 'hiding', to: 'showing', progress: this.#p });
			this.#state = 'showing';
			return Promise.resolve(true);
		}
		this.restoreSource();
		this.#source = from;
		this.#target = to;
		this.#save(from);
		this.#save(to);
		this.runs.push({ phase: 'showing', from, to, cloneContents: this.cloneContents });
		this.#start(from, to, 'showing');
		return Promise.resolve(true);
	}

	hide() {
		if (this.#state === 'idle' || this.#state === 'hiding') return Promise.resolve(false);
		if (this.#state === 'showing') {
			this.reversals.push({ from: 'showing', to: 'hiding', progress: this.#p });
			this.#state = 'hiding';
			return Promise.resolve(true);
		}
		this.runs.push({
			phase: 'hiding',
			from: this.#target,
			to: this.#source,
			cloneContents: this.cloneContents,
		});
		this.#start(this.#target, this.#source, 'hiding');
		return Promise.resolve(true);
	}

	step(p) {
		if (this.#state !== 'showing' && this.#state !== 'hiding') return;
		this.#p = p;
		this.emit('change', { progress: p, phase: this.#state });
		if (!this.#revealed && p >= 0.75) {
			this.#revealed = true;
			this.#to.style.visibility = 'visible';
			this.emit('reveal', { from: this.#from, to: this.#to });
		}

		const target =
			this.#state === 'showing'
				? this.#to === this.#target
					? 1
					: 0
				: this.#to === this.#source
					? 1
					: 0;
		if (p !== target) return;
		if (this.#state === 'showing') this.#finishShown();
		else this.#finishHidden();
	}

	stop({ restoreSource = true } = {}) {
		if (this.#state === 'idle') return;
		this.stops += 1;
		const progress = this.#p;
		this.#removeBlob();
		if (restoreSource) this.#restore(this.#source);
		else this.#heldSource = this.#source;
		this.#restore(this.#target);
		this.#state = 'idle';
		this.#p = 0;
		this.emit('stop', { progress });
	}

	restoreSource() {
		const source = this.#heldSource;
		if (!source) return false;
		this.#heldSource = null;
		this.#restore(source);
		return true;
	}

	destroy() {
		this.stop();
		this.restoreSource();
		this.#events.clear();
	}

	emit(name, detail) {
		for (const listener of (this.#events.get(name) || []).slice()) listener(detail);
	}

	#start(from, to, state) {
		this.#from = from;
		this.#to = to;
		this.#state = state;
		this.#p = 0;
		this.#revealed = false;
		this.#removeBlob();
		this.#blob = document.createElement('morph-blob');
		this.#blob.style.zIndex = String(this.zIndex);
		document.body.append(this.#blob);
		from.style.visibility = 'hidden';
		to.style.visibility = 'hidden';
	}

	#finishShown() {
		this.#removeBlob();
		this.#source.style.visibility = 'hidden';
		this.#target.style.visibility = 'visible';
		this.#state = 'shown';
		this.emit('shown', { from: this.#source, to: this.#target });
	}

	#finishHidden() {
		this.#removeBlob();
		this.#restore(this.#source);
		this.#restore(this.#target);
		this.#state = 'idle';
		this.#p = 0;
		this.emit('hidden', { from: this.#source, to: this.#target });
	}

	#save(element) {
		if (!element || this.#saved.has(element)) return;
		this.#saved.set(element, { visibility: element.style.visibility });
	}

	#restore(element) {
		if (!element) return;
		const saved = this.#saved.get(element);
		if (saved) element.style.visibility = saved.visibility;
		this.#saved.delete(element);
	}

	#removeBlob() {
		this.#blob?.remove();
		this.#blob = null;
	}
}

export { MorphEngine };
