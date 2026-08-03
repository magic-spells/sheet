import * as module from 'node:module';

const hasRegisterHooks = typeof module.registerHooks === 'function';

if (hasRegisterHooks) {
	const morphStubUrl = new URL('./morph-engine-stub.js', import.meta.url).href;
	module.registerHooks({
		resolve(specifier, context, nextResolve) {
			if (specifier.includes('@magic-spells/morph-engine')) {
				return { url: morphStubUrl, shortCircuit: true };
			}
			return nextResolve(specifier, context);
		},
		load(url, context, nextLoad) {
			if (url.endsWith('.css')) {
				return { format: 'module', source: '', shortCircuit: true };
			}
			return nextLoad(url, context);
		},
	});
}

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
		this.children = [];
		this.closestResults = new Map();
		this.dataset = {};
		this.dispatchedEvents = [];
		this.isConnected = true;
		this.listeners = new Map();
		this.parentElement = null;
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
			// A real event always carries its own type, and a handler that switches on
			// it silently took the wrong branch while this was missing.
			type,
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

	append(child) {
		child.parentElement = this;
		this.children.push(child);
	}

	prepend(child) {
		child.parentElement = this;
		this.children.unshift(child);
	}

	cloneNode() {
		const clone = new StubElement(this.tagName);
		clone.dataset = { ...this.dataset };
		clone.rect = this.rect ? { ...this.rect } : null;
		for (const [name, value] of this.attributes) clone.setAttribute(name, value);
		Object.assign(clone.style, this.style);
		return clone;
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

	remove() {
		if (!this.parentElement) return;
		this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
		this.parentElement = null;
		this.isConnected = false;
	}
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
		// The trigger usability probe reads these three. A DOM-free stub has no
		// cascade, so the inline value is the only style there is — which is also
		// what MorphEngine writes when it takes ownership of a trigger, so the
		// probe's blob-ownership gate is genuinely exercised here.
		display: element.style.display || 'block',
		fontSize: '16px',
		opacity: element.style.opacity || '1',
		overflowX: 'visible',
		overflowY: 'visible',
		visibility: element.style.visibility || 'visible',
		getPropertyValue: (name) => element.style.getPropertyValue(name),
	});

	installedDomStubs = { document, registry, window };
	return installedDomStubs;
}

export { hasRegisterHooks, installDomStubs, StubElement };
