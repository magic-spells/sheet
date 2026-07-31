//#region src/frame-engine.js
var e = /* @__PURE__ */ new Set(/* @__PURE__ */ "display.position.float.clear.visibility.overflow.overflow-x.overflow-y.flex-direction.flex-wrap.justify-content.align-items.align-content.order.grid-template-columns.grid-template-rows.grid-template-areas.grid-auto-flow.z-index.table-layout.empty-cells.caption-side.list-style-type.list-style-position.pointer-events.user-select.box-sizing.resize.text-align.text-transform.white-space.word-break.word-wrap.font-style.font-variant.background-repeat.background-attachment.border-style.border-collapse.content.page-break-before.page-break-after.page-break-inside".split(".")), t = /* @__PURE__ */ new Set([
	"transform",
	"filter",
	"backdrop-filter"
]), n = {
	translateX: [{
		value: 0,
		unit: "px"
	}],
	translateY: [{
		value: 0,
		unit: "px"
	}],
	translateZ: [{
		value: 0,
		unit: "px"
	}],
	translate: [{
		value: 0,
		unit: "px"
	}, {
		value: 0,
		unit: "px"
	}],
	translate3d: [
		{
			value: 0,
			unit: "px"
		},
		{
			value: 0,
			unit: "px"
		},
		{
			value: 0,
			unit: "px"
		}
	],
	scale: [{
		value: 1,
		unit: ""
	}],
	scaleX: [{
		value: 1,
		unit: ""
	}],
	scaleY: [{
		value: 1,
		unit: ""
	}],
	scaleZ: [{
		value: 1,
		unit: ""
	}],
	scale3d: [
		{
			value: 1,
			unit: ""
		},
		{
			value: 1,
			unit: ""
		},
		{
			value: 1,
			unit: ""
		}
	],
	rotate: [{
		value: 0,
		unit: "deg"
	}],
	rotateX: [{
		value: 0,
		unit: "deg"
	}],
	rotateY: [{
		value: 0,
		unit: "deg"
	}],
	rotateZ: [{
		value: 0,
		unit: "deg"
	}],
	rotate3d: [
		{
			value: 0,
			unit: ""
		},
		{
			value: 0,
			unit: ""
		},
		{
			value: 1,
			unit: ""
		},
		{
			value: 0,
			unit: "deg"
		}
	],
	skew: [{
		value: 0,
		unit: "deg"
	}, {
		value: 0,
		unit: "deg"
	}],
	skewX: [{
		value: 0,
		unit: "deg"
	}],
	skewY: [{
		value: 0,
		unit: "deg"
	}],
	perspective: [{
		value: 0,
		unit: "px"
	}],
	blur: [{
		value: 0,
		unit: "px"
	}],
	brightness: [{
		value: 1,
		unit: ""
	}],
	contrast: [{
		value: 1,
		unit: ""
	}],
	grayscale: [{
		value: 0,
		unit: ""
	}],
	"hue-rotate": [{
		value: 0,
		unit: "deg"
	}],
	invert: [{
		value: 0,
		unit: ""
	}],
	opacity: [{
		value: 1,
		unit: ""
	}],
	saturate: [{
		value: 1,
		unit: ""
	}],
	sepia: [{
		value: 0,
		unit: ""
	}],
	"drop-shadow-1": [
		{
			value: 0,
			unit: "px"
		},
		{
			value: 0,
			unit: "px"
		},
		{
			value: 0,
			unit: "px"
		}
	],
	"drop-shadow-2": [
		{
			value: 0,
			unit: "px"
		},
		{
			value: 0,
			unit: "px"
		},
		{
			value: 0,
			unit: "px"
		}
	]
}, r = {
	opacity: [0, 1],
	blur: [0, Infinity],
	brightness: [0, Infinity],
	contrast: [0, Infinity],
	grayscale: [0, 1],
	invert: [0, 1],
	sepia: [0, 1],
	saturate: [0, Infinity]
}, i = {
	red: 0,
	green: 0,
	blue: 0,
	alpha: 0
}, a = !1;
function o(e, t, n) {
	return n < 0 && (n += 1), n > 1 && --n, n < 1 / 6 ? e + (t - e) * 6 * n : n < 1 / 2 ? t : n < 2 / 3 ? e + (t - e) * (2 / 3 - n) * 6 : e;
}
var s = {
	aliceblue: [
		240,
		248,
		255,
		1
	],
	antiquewhite: [
		250,
		235,
		215,
		1
	],
	aqua: [
		0,
		255,
		255,
		1
	],
	aquamarine: [
		127,
		255,
		212,
		1
	],
	azure: [
		240,
		255,
		255,
		1
	],
	beige: [
		245,
		245,
		220,
		1
	],
	bisque: [
		255,
		228,
		196,
		1
	],
	black: [
		0,
		0,
		0,
		1
	],
	blanchedalmond: [
		255,
		235,
		205,
		1
	],
	blue: [
		0,
		0,
		255,
		1
	],
	blueviolet: [
		138,
		43,
		226,
		1
	],
	brown: [
		165,
		42,
		42,
		1
	],
	burlywood: [
		222,
		184,
		135,
		1
	],
	cadetblue: [
		95,
		158,
		160,
		1
	],
	chartreuse: [
		127,
		255,
		0,
		1
	],
	chocolate: [
		210,
		105,
		30,
		1
	],
	coral: [
		255,
		127,
		80,
		1
	],
	cornflowerblue: [
		100,
		149,
		237,
		1
	],
	cornsilk: [
		255,
		248,
		220,
		1
	],
	crimson: [
		220,
		20,
		60,
		1
	],
	cyan: [
		0,
		255,
		255,
		1
	],
	darkblue: [
		0,
		0,
		139,
		1
	],
	darkcyan: [
		0,
		139,
		139,
		1
	],
	darkgoldenrod: [
		184,
		134,
		11,
		1
	],
	darkgray: [
		169,
		169,
		169,
		1
	],
	darkgreen: [
		0,
		100,
		0,
		1
	],
	darkgrey: [
		169,
		169,
		169,
		1
	],
	darkkhaki: [
		189,
		183,
		107,
		1
	],
	darkmagenta: [
		139,
		0,
		139,
		1
	],
	darkolivegreen: [
		85,
		107,
		47,
		1
	],
	darkorange: [
		255,
		140,
		0,
		1
	],
	darkorchid: [
		153,
		50,
		204,
		1
	],
	darkred: [
		139,
		0,
		0,
		1
	],
	darksalmon: [
		233,
		150,
		122,
		1
	],
	darkseagreen: [
		143,
		188,
		143,
		1
	],
	darkslateblue: [
		72,
		61,
		139,
		1
	],
	darkslategray: [
		47,
		79,
		79,
		1
	],
	darkslategrey: [
		47,
		79,
		79,
		1
	],
	darkturquoise: [
		0,
		206,
		209,
		1
	],
	darkviolet: [
		148,
		0,
		211,
		1
	],
	deeppink: [
		255,
		20,
		147,
		1
	],
	deepskyblue: [
		0,
		191,
		255,
		1
	],
	dimgray: [
		105,
		105,
		105,
		1
	],
	dimgrey: [
		105,
		105,
		105,
		1
	],
	dodgerblue: [
		30,
		144,
		255,
		1
	],
	firebrick: [
		178,
		34,
		34,
		1
	],
	floralwhite: [
		255,
		250,
		240,
		1
	],
	forestgreen: [
		34,
		139,
		34,
		1
	],
	fuchsia: [
		255,
		0,
		255,
		1
	],
	gainsboro: [
		220,
		220,
		220,
		1
	],
	ghostwhite: [
		248,
		248,
		255,
		1
	],
	gold: [
		255,
		215,
		0,
		1
	],
	goldenrod: [
		218,
		165,
		32,
		1
	],
	gray: [
		128,
		128,
		128,
		1
	],
	green: [
		0,
		128,
		0,
		1
	],
	greenyellow: [
		173,
		255,
		47,
		1
	],
	grey: [
		128,
		128,
		128,
		1
	],
	honeydew: [
		240,
		255,
		240,
		1
	],
	hotpink: [
		255,
		105,
		180,
		1
	],
	indianred: [
		205,
		92,
		92,
		1
	],
	indigo: [
		75,
		0,
		130,
		1
	],
	ivory: [
		255,
		255,
		240,
		1
	],
	khaki: [
		240,
		230,
		140,
		1
	],
	lavender: [
		230,
		230,
		250,
		1
	],
	lavenderblush: [
		255,
		240,
		245,
		1
	],
	lawngreen: [
		124,
		252,
		0,
		1
	],
	lemonchiffon: [
		255,
		250,
		205,
		1
	],
	lightblue: [
		173,
		216,
		230,
		1
	],
	lightcoral: [
		240,
		128,
		128,
		1
	],
	lightcyan: [
		224,
		255,
		255,
		1
	],
	lightgoldenrodyellow: [
		250,
		250,
		210,
		1
	],
	lightgray: [
		211,
		211,
		211,
		1
	],
	lightgreen: [
		144,
		238,
		144,
		1
	],
	lightgrey: [
		211,
		211,
		211,
		1
	],
	lightpink: [
		255,
		182,
		193,
		1
	],
	lightsalmon: [
		255,
		160,
		122,
		1
	],
	lightseagreen: [
		32,
		178,
		170,
		1
	],
	lightskyblue: [
		135,
		206,
		250,
		1
	],
	lightslategray: [
		119,
		136,
		153,
		1
	],
	lightslategrey: [
		119,
		136,
		153,
		1
	],
	lightsteelblue: [
		176,
		196,
		222,
		1
	],
	lightyellow: [
		255,
		255,
		224,
		1
	],
	lime: [
		0,
		255,
		0,
		1
	],
	limegreen: [
		50,
		205,
		50,
		1
	],
	linen: [
		250,
		240,
		230,
		1
	],
	magenta: [
		255,
		0,
		255,
		1
	],
	maroon: [
		128,
		0,
		0,
		1
	],
	mediumaquamarine: [
		102,
		205,
		170,
		1
	],
	mediumblue: [
		0,
		0,
		205,
		1
	],
	mediumorchid: [
		186,
		85,
		211,
		1
	],
	mediumpurple: [
		147,
		112,
		219,
		1
	],
	mediumseagreen: [
		60,
		179,
		113,
		1
	],
	mediumslateblue: [
		123,
		104,
		238,
		1
	],
	mediumspringgreen: [
		0,
		250,
		154,
		1
	],
	mediumturquoise: [
		72,
		209,
		204,
		1
	],
	mediumvioletred: [
		199,
		21,
		133,
		1
	],
	midnightblue: [
		25,
		25,
		112,
		1
	],
	mintcream: [
		245,
		255,
		250,
		1
	],
	mistyrose: [
		255,
		228,
		225,
		1
	],
	moccasin: [
		255,
		228,
		181,
		1
	],
	navajowhite: [
		255,
		222,
		173,
		1
	],
	navy: [
		0,
		0,
		128,
		1
	],
	oldlace: [
		253,
		245,
		230,
		1
	],
	olive: [
		128,
		128,
		0,
		1
	],
	olivedrab: [
		107,
		142,
		35,
		1
	],
	orange: [
		255,
		165,
		0,
		1
	],
	orangered: [
		255,
		69,
		0,
		1
	],
	orchid: [
		218,
		112,
		214,
		1
	],
	palegoldenrod: [
		238,
		232,
		170,
		1
	],
	palegreen: [
		152,
		251,
		152,
		1
	],
	paleturquoise: [
		175,
		238,
		238,
		1
	],
	palevioletred: [
		219,
		112,
		147,
		1
	],
	papayawhip: [
		255,
		239,
		213,
		1
	],
	peachpuff: [
		255,
		218,
		185,
		1
	],
	peru: [
		205,
		133,
		63,
		1
	],
	pink: [
		255,
		192,
		203,
		1
	],
	plum: [
		221,
		160,
		221,
		1
	],
	powderblue: [
		176,
		224,
		230,
		1
	],
	purple: [
		128,
		0,
		128,
		1
	],
	rebeccapurple: [
		102,
		51,
		153,
		1
	],
	red: [
		255,
		0,
		0,
		1
	],
	rosybrown: [
		188,
		143,
		143,
		1
	],
	royalblue: [
		65,
		105,
		225,
		1
	],
	saddlebrown: [
		139,
		69,
		19,
		1
	],
	salmon: [
		250,
		128,
		114,
		1
	],
	sandybrown: [
		244,
		164,
		96,
		1
	],
	seagreen: [
		46,
		139,
		87,
		1
	],
	seashell: [
		255,
		245,
		238,
		1
	],
	sienna: [
		160,
		82,
		45,
		1
	],
	silver: [
		192,
		192,
		192,
		1
	],
	skyblue: [
		135,
		206,
		235,
		1
	],
	slateblue: [
		106,
		90,
		205,
		1
	],
	slategray: [
		112,
		128,
		144,
		1
	],
	slategrey: [
		112,
		128,
		144,
		1
	],
	snow: [
		255,
		250,
		250,
		1
	],
	springgreen: [
		0,
		255,
		127,
		1
	],
	steelblue: [
		70,
		130,
		180,
		1
	],
	tan: [
		210,
		180,
		140,
		1
	],
	teal: [
		0,
		128,
		128,
		1
	],
	thistle: [
		216,
		191,
		216,
		1
	],
	tomato: [
		255,
		99,
		71,
		1
	],
	turquoise: [
		64,
		224,
		208,
		1
	],
	violet: [
		238,
		130,
		238,
		1
	],
	wheat: [
		245,
		222,
		179,
		1
	],
	white: [
		255,
		255,
		255,
		1
	],
	whitesmoke: [
		245,
		245,
		245,
		1
	],
	yellow: [
		255,
		255,
		0,
		1
	],
	yellowgreen: [
		154,
		205,
		50,
		1
	],
	transparent: [
		0,
		0,
		0,
		0
	]
}, c = class {
	constructor(e) {
		this.setKeyframes(e);
	}
	setKeyframes(e) {
		this.keyframes = Object.keys(e).map(Number).sort((e, t) => e - t).map((t) => ({
			percent: t,
			values: this.flatten(e[t])
		}));
		let r = {};
		for (let e of t) r[e] = /* @__PURE__ */ new Set();
		for (let e of this.keyframes) for (let n in e.values) {
			let e = n.indexOf(":");
			if (e === -1) continue;
			let i = n.substring(0, e), a = n.substring(e + 1);
			a !== "__order" && t.has(i) && r[i].add(a);
		}
		for (let e of t) {
			if (r[e].size === 0) continue;
			let t = `${e}:__order`;
			for (let a of this.keyframes) {
				if (!(t in a.values)) {
					a.values[t] = {
						discrete: !0,
						value: [...r[e]]
					};
					for (let t of r[e]) {
						let r = `${e}:${t}`, o = n[t] || [{
							value: 0,
							unit: ""
						}];
						a.values[r] = { args: o.map((e) => ({ ...e })) }, t.startsWith("drop-shadow-") && (a.values[r].color = { ...i });
					}
					continue;
				}
				for (let o of r[e]) {
					let r = `${e}:${o}`;
					if (!(r in a.values)) {
						let e = n[o] || [{
							value: 0,
							unit: ""
						}];
						a.values[r] = { args: e.map((e) => ({ ...e })) }, o.startsWith("drop-shadow-") && (a.values[r].color = { ...i }), a.values[t].value.includes(o) || a.values[t].value.push(o);
					}
				}
			}
		}
		this._allKeys = /* @__PURE__ */ new Set();
		for (let e of this.keyframes) for (let t in e.values) t.endsWith(":__order") || this._allKeys.add(t);
		this._keyFrames = {};
		for (let e of this._allKeys) this._keyFrames[e] = this.keyframes.filter((t) => e in t.values);
		this._orders = {};
		for (let e of t) {
			let t = `${e}:__order`, n = this.keyframes.filter((e) => t in e.values);
			if (n.length === 0) continue;
			let r = /* @__PURE__ */ new Set(), i = [];
			for (let e of n) for (let n of e.values[t].value) r.has(n) || (r.add(n), i.push(n));
			this._orders[e] = i;
		}
	}
	flatten(n) {
		let r = {};
		for (let i in n) t.has(i) ? Object.assign(r, this.flattenFunctions(i, n[i])) : this.isColor(n[i]) ? r[i] = this.parseColor(n[i]) || {
			discrete: !0,
			value: n[i]
		} : e.has(i) ? r[i] = {
			discrete: !0,
			value: n[i]
		} : r[i] = this.parseValue(n[i]) || {
			discrete: !0,
			value: n[i]
		};
		return r;
	}
	flattenFunctions(e, t) {
		let n = {}, r = [], i = {};
		for (let { name: o, args: s, color: c } of this.parseFunctions(t)) {
			let t = o;
			if (o === "drop-shadow") {
				if (i[o] = (i[o] || 0) + 1, i[o] > 2) {
					a || (a = !0, console.warn("FrameEngine: Only the first 2 drop-shadow functions per keyframe are interpolated. Additional drop-shadows are ignored."));
					continue;
				}
				t = `${o}-${i[o]}`;
			}
			let l = { args: s };
			c && (l.color = c), n[`${e}:${t}`] = l, r.push(t);
		}
		return n[`${e}:__order`] = {
			discrete: !0,
			value: r
		}, n;
	}
	parseFunctions(e) {
		let t = [], n = 0, r = e.length;
		for (; n < r;) {
			for (; n < r && /\s/.test(e[n]);) n++;
			if (n >= r) break;
			let i = "";
			for (; n < r && /[\w-]/.test(e[n]);) i += e[n], n++;
			if (!i || n >= r || e[n] !== "(") continue;
			n++;
			let a = 1, o = "";
			for (; n < r && a > 0;) {
				if (e[n] === "(") a++;
				else if (e[n] === ")" && (a--, a === 0)) {
					n++;
					break;
				}
				o += e[n], n++;
			}
			if (i === "drop-shadow") {
				let e = this.splitArgs(o), n = [], r = null;
				for (let t of e) if (this.isColor(t)) {
					let e = this.parseColor(t);
					e && (r = e);
				} else {
					let e = t.match(/^(-?\d*\.?\d+)(\D*)$/);
					n.push(e ? {
						value: parseFloat(e[1]),
						unit: e[2]
					} : {
						value: 0,
						unit: ""
					});
				}
				t.push({
					name: i,
					args: n,
					color: r
				});
			} else {
				let e = o.split(/\s*,\s*|\s+/).map((e) => {
					let t = e.match(/^(-?\d*\.?\d+)(\D*)$/);
					return t ? {
						value: parseFloat(t[1]),
						unit: t[2]
					} : {
						value: 0,
						unit: ""
					};
				});
				t.push({
					name: i,
					args: e
				});
			}
		}
		return t;
	}
	splitArgs(e) {
		let t = [], n = "", r = 0;
		for (let i = 0; i < e.length; i++) {
			let a = e[i];
			a === "(" ? r++ : a === ")" && r--, r === 0 && (a === " " || a === ",") ? (n.trim() && t.push(n.trim()), n = "") : n += a;
		}
		return n.trim() && t.push(n.trim()), t;
	}
	parseValue(e) {
		if (typeof e == "number") return {
			value: e,
			unit: ""
		};
		let t = String(e).match(/^(-?\d*\.?\d+)(\D*)$/);
		return t ? {
			value: parseFloat(t[1]),
			unit: t[2]
		} : null;
	}
	parseColor(e) {
		let t = this.colorToRGBA(e);
		if (!t) return null;
		let [n, r, i, a] = t;
		return {
			red: n,
			green: r,
			blue: i,
			alpha: a
		};
	}
	colorToRGBA(e) {
		if (typeof e != "string") return null;
		let t = s[e.toLowerCase()];
		if (t) return t;
		let n = e.match(/^color\(\s*srgb\s+([+-]?(?:\d*\.?\d+)(?:e[+-]?\d+)?)\s+([+-]?(?:\d*\.?\d+)(?:e[+-]?\d+)?)\s+([+-]?(?:\d*\.?\d+)(?:e[+-]?\d+)?)(?:\s*\/\s*([+-]?(?:\d*\.?\d+)(?:e[+-]?\d+)?)(%)?)?\s*\)$/i);
		if (n) {
			let e = n[4] === void 0 ? 1 : parseFloat(n[4]) / (n[5] ? 100 : 1);
			return [
				parseFloat(n[1]) * 255,
				parseFloat(n[2]) * 255,
				parseFloat(n[3]) * 255,
				e
			];
		}
		if (/^#[0-9A-Fa-f]{3}$/.test(e)) return [
			parseInt(e[1] + e[1], 16),
			parseInt(e[2] + e[2], 16),
			parseInt(e[3] + e[3], 16),
			1
		];
		if (/^#[0-9A-Fa-f]{4}$/.test(e)) return [
			parseInt(e[1] + e[1], 16),
			parseInt(e[2] + e[2], 16),
			parseInt(e[3] + e[3], 16),
			parseInt(e[4] + e[4], 16) / 255
		];
		if (/^#[0-9A-Fa-f]{6}$/.test(e)) return [
			parseInt(e.slice(1, 3), 16),
			parseInt(e.slice(3, 5), 16),
			parseInt(e.slice(5, 7), 16),
			1
		];
		if (/^#[0-9A-Fa-f]{8}$/.test(e)) return [
			parseInt(e.slice(1, 3), 16),
			parseInt(e.slice(3, 5), 16),
			parseInt(e.slice(5, 7), 16),
			parseInt(e.slice(7, 9), 16) / 255
		];
		let r = e.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
		if (r) return [
			parseInt(r[1], 10),
			parseInt(r[2], 10),
			parseInt(r[3], 10),
			r[4] === void 0 ? 1 : parseFloat(r[4])
		];
		let i = e.match(/^rgba?\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:\/\s*([\d.]+)\s*)?\)$/);
		if (i) return [
			parseInt(i[1], 10),
			parseInt(i[2], 10),
			parseInt(i[3], 10),
			i[4] === void 0 ? 1 : parseFloat(i[4])
		];
		let a = e.match(/^hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*(?:,\s*([\d.]+)\s*)?\)$/);
		if (a) return this._hslToRgba(parseFloat(a[1]), parseFloat(a[2]), parseFloat(a[3]), a[4] === void 0 ? 1 : parseFloat(a[4]));
		let o = e.match(/^hsla?\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*(?:\/\s*([\d.]+)\s*)?\)$/);
		return o ? this._hslToRgba(parseFloat(o[1]), parseFloat(o[2]), parseFloat(o[3]), o[4] === void 0 ? 1 : parseFloat(o[4])) : null;
	}
	_hslToRgba(e, t, n, r) {
		let i = e / 360, a = t / 100, s = n / 100;
		if (a === 0) {
			let e = Math.round(s * 255);
			return [
				e,
				e,
				e,
				r
			];
		}
		let c = s < .5 ? s * (1 + a) : s + a - s * a, l = 2 * s - c;
		return [
			Math.round(o(l, c, i + 1 / 3) * 255),
			Math.round(o(l, c, i) * 255),
			Math.round(o(l, c, i - 1 / 3) * 255),
			r
		];
	}
	isColor(e) {
		return typeof e == "string" ? /^(#[0-9A-Fa-f]{3}$|#[0-9A-Fa-f]{4}$|#[0-9A-Fa-f]{6}$|#[0-9A-Fa-f]{8}$|rgba?\s*\(|hsla?\s*\()/.test(e) || /^color\(\s*srgb\s/i.test(e) ? !0 : e.toLowerCase() in s : !1;
	}
	lerp(e, t, n) {
		return e + (t - e) * n;
	}
	lerpColor(e, t, n) {
		let r = (e, t, n) => Math.min(n, Math.max(t, e));
		return {
			red: Math.round(r(this.lerp(e.red, t.red, n), 0, 255)),
			green: Math.round(r(this.lerp(e.green, t.green, n), 0, 255)),
			blue: Math.round(r(this.lerp(e.blue, t.blue, n), 0, 255)),
			alpha: parseFloat(r(this.lerp(e.alpha, t.alpha, n), 0, 1).toFixed(4))
		};
	}
	format(e) {
		return parseFloat(e.toFixed(4)).toString();
	}
	findFramesAndFactor(e, t) {
		if (e.length === 0) return null;
		if (e.length === 1) return {
			from: e[0],
			to: e[0],
			factor: 0
		};
		let n = e[0], r = e[e.length - 1];
		if (t <= n.percent) {
			let r = e[1].percent - n.percent;
			return {
				from: n,
				to: e[1],
				factor: r === 0 ? 1 : (t - n.percent) / r
			};
		}
		if (t >= r.percent) {
			let n = e[e.length - 2], i = r.percent - n.percent;
			return {
				from: n,
				to: r,
				factor: i === 0 ? 1 : (t - n.percent) / i
			};
		}
		for (let n = 0; n < e.length - 1; n++) if (t >= e[n].percent && t <= e[n + 1].percent) {
			let r = e[n + 1].percent - e[n].percent;
			return {
				from: e[n],
				to: e[n + 1],
				factor: r === 0 ? 1 : (t - e[n].percent) / r
			};
		}
		return {
			from: r,
			to: r,
			factor: 0
		};
	}
	getDiscrete(e, t) {
		let n = this._keyFrames[e] || this.keyframes.filter((t) => e in t.values);
		if (n.length === 0) return null;
		let r = n[0];
		for (let e of n) if (e.percent <= t) r = e;
		else break;
		return r.values[e].value;
	}
	getDefault(e) {
		let t = e.split(":")[1];
		return t && n[t] ? n[t] : [{
			value: 0,
			unit: ""
		}];
	}
	getFrame(e) {
		let t = e * 100, n = this._allKeys, a = {};
		for (let e of n) {
			let n = this._keyFrames[e];
			if (!n || n.length === 0) continue;
			let o = n[0].values[e];
			if (o && o.discrete) {
				a[e] = this.getDiscrete(e, t);
				continue;
			}
			let { from: s, to: c, factor: l } = this.findFramesAndFactor(n, t), u = s.values[e], d = c.values[e];
			if (u && "red" in u) {
				a[e] = this.lerpColor(u, d, l);
				continue;
			}
			if (u && u.args) {
				let t = d.args || this.getDefault(e), n = this.getDefault(e), o = Math.max(u.args.length, t.length), s = [];
				for (let e = 0; e < o; e++) {
					let r = u.args[e] || n[e] || {
						value: 0,
						unit: ""
					}, i = t[e] || n[e] || {
						value: 0,
						unit: ""
					};
					s.push({
						value: this.lerp(r.value, i.value, l),
						unit: r.unit || i.unit
					});
				}
				let c = r[e.includes(":") ? e.substring(e.indexOf(":") + 1) : e];
				if (c) for (let e of s) e.value = Math.min(c[1], Math.max(c[0], e.value));
				let f = { args: s };
				(u.color || d.color) && (f.color = this.lerpColor(u.color || i, d.color || i, l)), a[e] = f;
				continue;
			}
			if (u && "value" in u) {
				let t = d || this.getDefault(e)[0], n = this.lerp(u.value, t.value, l), i = r[e];
				i && (n = Math.min(i[1], Math.max(i[0], n))), a[e] = {
					value: n,
					unit: u.unit
				};
			}
		}
		return this.toStyles(a);
	}
	toStyles(e) {
		let n = {}, r = {};
		for (let i in e) {
			let a = e[i], o = i.indexOf(":");
			if (o !== -1) {
				let e = i.substring(0, o), n = i.substring(o + 1);
				if (t.has(e)) {
					if (r[e] || (r[e] = {}), a.args) if (n.startsWith("drop-shadow-")) {
						let t = n.replace(/-\d+$/, ""), i = a.args.map((e) => `${this.format(e.value)}${e.unit}`).join(" ");
						if (a.color) {
							let o = a.color, s = o.alpha < 1 ? `rgba(${o.red},${o.green},${o.blue},${o.alpha})` : `rgb(${o.red},${o.green},${o.blue})`;
							r[e][n] = `${t}(${i} ${s})`;
						} else r[e][n] = `${t}(${i})`;
					} else r[e][n] = `${n}(${a.args.map((e) => `${this.format(e.value)}${e.unit}`).join(", ")})`;
					else r[e][n] = `${n}(${this.format(a.value)}${a.unit})`;
					continue;
				}
			}
			if (typeof a == "string" || typeof a == "number") {
				n[i] = a;
				continue;
			}
			if (a && "red" in a) {
				n[i] = a.alpha < 1 ? `rgba(${a.red},${a.green},${a.blue},${a.alpha})` : `rgb(${a.red},${a.green},${a.blue})`;
				continue;
			}
			if (a && "value" in a) {
				n[i] = `${this.format(a.value)}${a.unit}`;
				continue;
			}
			n[i] = a;
		}
		for (let e in r) {
			let t = r[e], i = (this._orders[e] || Object.keys(t)).filter((e) => t[e]).map((e) => t[e]);
			i.length > 0 && (n[e] = i.join(" "));
		}
		return n;
	}
};
//#endregion
export { c as default };
