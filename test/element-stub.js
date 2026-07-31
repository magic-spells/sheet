class StubStyle {
	setProperty(name, value) {
		this[name] = String(value);
	}

	removeProperty(name) {
		delete this[name];
	}

	getPropertyValue(name) {
		return this[name] || '';
	}
}

class StubElement {
	constructor(tagName = '') {
		this.tagName = tagName.toUpperCase();
		this.attributes = new Map();
		this.capturedPointerIds = [];
		this.closestResults = new Map();
		this.dataset = {};
		this.dispatchedEvents = [];
		this.listeners = new Map();
		this.queryResults = new Map();
		this.rect = null;
		this.style = new StubStyle();
	}

	addEventListener(type, listener) {
		const listeners = this.listeners.get(type) || [];
		listeners.push(listener);
		this.listeners.set(type, listeners);
	}

	removeEventListener(type, listener) {
		const listeners = (this.listeners.get(type) || []).filter((entry) => entry !== listener);
		if (listeners.length) this.listeners.set(type, listeners);
		else this.listeners.delete(type);
	}

	fire(type, init = {}) {
		const event = {
			isPrimary: true,
			pointerId: 1,
			clientX: 0,
			clientY: 0,
			timeStamp: 0,
			cancelable: true,
			target: this,
			defaultPrevented: false,
			propagationStopped: false,
			preventDefault() {
				this.defaultPrevented = true;
			},
			stopPropagation() {
				this.propagationStopped = true;
			},
			...init,
		};
		for (const listener of this.listeners.get(type) || []) listener(event);
		return event;
	}

	setPointerCapture(pointerId) {
		this.capturedPointerIds.push(pointerId);
	}

	setAttribute(name, value) {
		this.attributes.set(name, String(value));
	}

	getAttribute(name) {
		return this.attributes.get(name) ?? null;
	}

	hasAttribute(name) {
		return this.attributes.has(name);
	}

	removeAttribute(name) {
		this.attributes.delete(name);
	}

	closest(selector) {
		return this.closestResults.get(selector) || null;
	}

	querySelector(selector) {
		return this.queryResults.get(selector) || null;
	}

	contains(target) {
		return target === this;
	}

	dispatchEvent(event) {
		this.dispatchedEvents.push(event);
		return true;
	}

	getBoundingClientRect() {
		if (this.rect) return { ...this.rect };
		return {
			top: 0,
			left: 0,
			right: resolveLength(this.style.width, 'width'),
			bottom: resolveLength(this.style.height, 'height'),
			width: resolveLength(this.style.width, 'width'),
			height: resolveLength(this.style.height, 'height'),
		};
	}

	remove() {}
}

let installedDomStubs;

function resolveLength(value, axis) {
	const text = String(value || '').trim();
	const number = Number.parseFloat(text);
	if (!Number.isFinite(number)) return 0;
	if (text.endsWith('vh')) return (number / 100) * globalThis.window.innerHeight;
	if (text.endsWith('vw')) return (number / 100) * globalThis.window.innerWidth;
	if (text.endsWith('rem')) return number * 16;
	if (text.endsWith('%')) {
		const base = axis === 'height' ? globalThis.window.innerHeight : globalThis.window.innerWidth;
		return (number / 100) * base;
	}
	return number;
}

function installDomStubs() {
	if (installedDomStubs) return installedDomStubs;

	const registry = new Map();
	const window = new StubElement('window');
	window.innerWidth = 400;
	window.innerHeight = 800;

	const document = new StubElement('document');
	document.body = new StubElement('body');
	document.body.append = () => {};
	document.documentElement = new StubElement('html');
	document.createElement = (tagName) => new StubElement(tagName);

	globalThis.Element = StubElement;
	globalThis.HTMLElement = StubElement;
	globalThis.window = window;
	globalThis.document = document;
	globalThis.customElements = {
		get: (name) => registry.get(name),
		define: (name, constructor) => registry.set(name, constructor),
	};
	globalThis.CustomEvent = class CustomEvent {
		constructor(type, options = {}) {
			this.type = type;
			Object.assign(this, options);
		}
	};
	globalThis.getComputedStyle = (element) => ({
		borderRadius: '0px',
		direction: 'ltr',
		fontSize: '16px',
		overflowX: 'visible',
		overflowY: 'visible',
		getPropertyValue: (name) => element.style.getPropertyValue(name),
	});

	installedDomStubs = { document, registry, window };
	return installedDomStubs;
}

export { installDomStubs, StubElement };
