'use strict';

const CSS = `
/* The host owns fixed positioning; this child fills the centered stage without intercepting input. */
[data-dsh-fairy-mascot-root="true"] {
	position: relative;
	width: min(76%, 36vh, 450px);
	height: min(76%, 36vh);
	aspect-ratio: 1;
	z-index: 99999;
	pointer-events: none;
	user-select: none;
	/* Keep the root as a non-composited overflow host. Safari clips transformed
	 * descendants to an ancestor's layout box when that ancestor owns opacity,
	 * isolation, or containment. Opacity is applied per visual SVG below. */
	overflow: visible;
}
[data-dsh-fairy-mascot-root="true"], [data-dsh-fairy-mascot-root="true"] * { box-sizing: border-box; }
html[data-dsh-fairy-visual][data-dsh-fairy-theme="light"] [data-dsh-fairy-mascot-root="true"] .dsh-fairy-halo path,
html[data-dsh-fairy-visual][data-dsh-fairy-theme="light"] [data-dsh-fairy-mascot-root="true"] .dsh-fairy-lash-pulse {
	stroke: #172531;
}
[data-dsh-fairy-mascot-root="true"] { --dsh-fairy-outer-halo-color: #c9f8ff; }
[data-dsh-fairy-mascot-root="true"] .dsh-fairy-halo { color: #c9efff; }
html[data-dsh-fairy-visual][data-dsh-fairy-theme="light"] [data-dsh-fairy-mascot-root="true"] { --dsh-fairy-outer-halo-color: #172531; }
html[data-dsh-fairy-visual][data-dsh-fairy-theme="light"] [data-dsh-fairy-mascot-root="true"] .dsh-fairy-halo { color: #172531; }
/* Low-power mode removes only the expensive decorative raster work. */
[data-dsh-fairy-mascot-root="true"][data-low-power] .dsh-fairy-outer-disc,
[data-dsh-fairy-mascot-root="true"][data-low-power] .dsh-fairy-sclera,
[data-dsh-fairy-mascot-root="true"][data-low-power] .dsh-fairy-highlight-glow {
	filter: none;
}
[data-dsh-fairy-mascot-root="true"][data-low-power] .dsh-fairy-outer-halo,
[data-dsh-fairy-mascot-root="true"][data-low-power] .dsh-fairy-sclera-halo,
[data-dsh-fairy-mascot-root="true"][data-low-power] .dsh-fairy-sclera-contact,
[data-dsh-fairy-mascot-root="true"][data-low-power] .dsh-fairy-highlight-halo {
	display: none;
}
[data-dsh-fairy-mascot-root="true"][data-low-power] .dsh-fairy-halo,
[data-dsh-fairy-mascot-root="true"][data-low-power] .dsh-fairy-lash-pulse {
	display: none;
}
[data-dsh-fairy-mascot-root="true"][data-low-power] .dsh-fairy-corners,
[data-dsh-fairy-mascot-root="true"][data-low-power] .dsh-fairy-lash-pulse-wave,
[data-dsh-fairy-mascot-root="true"][data-low-power] .dsh-fairy-sclera,
[data-dsh-fairy-mascot-root="true"][data-low-power] .dsh-fairy-layer-three,
[data-dsh-fairy-mascot-root="true"][data-low-power] .dsh-fairy-layer-two,
[data-dsh-fairy-mascot-root="true"][data-low-power] .dsh-fairy-layer-one,
[data-dsh-fairy-mascot-root="true"][data-low-power] .dsh-fairy-thinking-clip-shape,
[data-dsh-fairy-mascot-root="true"][data-low-power] .dsh-fairy-comforting-clip-shape {
	will-change: auto;
}
/* The source image remains legible while a regular glitch is active. */
[data-dsh-fairy-mascot-root="true"][data-transition-glitch] .dsh-fairy-outer-disc,
[data-dsh-fairy-mascot-root="true"][data-transition-glitch] .dsh-fairy-sclera,
[data-dsh-fairy-mascot-root="true"][data-transition-glitch] .dsh-fairy-highlight-glow,
[data-dsh-fairy-mascot-root="true"] .dsh-fairy-signal[data-glitch] .dsh-fairy-outer-disc,
[data-dsh-fairy-mascot-root="true"] .dsh-fairy-signal[data-glitch] .dsh-fairy-sclera,
[data-dsh-fairy-mascot-root="true"] .dsh-fairy-signal[data-glitch] .dsh-fairy-highlight-glow {
	filter: none;
}
[data-dsh-fairy-mascot-root="true"] .dsh-fairy-float {
	position: relative;
	width: 100%;
	height: 100%;
	overflow: visible;
}
[data-dsh-fairy-mascot-root="true"] svg {
	display: block;
	width: 100%;
	height: 100%;
	overflow: visible;
}
/* The expanding pulse has its own three-times viewport.  Its largest frame now
 * stays inside a real SVG viewport instead of relying on root-SVG overflow,
 * whose first-layout clipping differs across browser raster paths. */
[data-dsh-fairy-mascot-root="true"] .dsh-fairy-pulse-layer {
	position: absolute;
	left: -100%;
	top: -100%;
	width: 300%;
	height: 300%;
	z-index: 0;
	opacity: .92;
	display: block;
	visibility: visible;
	pointer-events: none;
}
[data-dsh-fairy-mascot-root="true"] .dsh-fairy-halo-layer {
	position: absolute;
	left: -112.5%;
	top: -43.75%;
	width: 325%;
	height: 200%;
	z-index: 0;
	pointer-events: none;
	opacity: .92;
}
[data-dsh-fairy-mascot-root="true"] .dsh-fairy-main {
	position: relative;
	z-index: 1;
	/* The main eye is the opaque boundary; halo/pulse layers stay behind it. */
	opacity: 1;
}
/* The two glitch modes are mutually exclusive and selected by data-glitch. */
[data-dsh-fairy-mascot-root="true"] .dsh-fairy-signal {
	transform-origin: 80px 80px;
}
[data-dsh-fairy-mascot-root="true"] .dsh-fairy-signal[data-glitch],
[data-dsh-fairy-mascot-root="true"][data-transition-glitch] .dsh-fairy-signal {
	/* Two full-surface chromatic drop shadows were the most expensive transient
	 * part of a fault. The retained level shift plus displacement preserves the
	 * glitch expression without rasterizing the eye two additional times. */
	will-change: transform, filter;
	filter:
		brightness(var(--dsh-g-bright, 1.12))
		contrast(var(--dsh-g-contrast, 1.18));
	transform: translateX(var(--dsh-g-x, 0)) skewX(var(--dsh-g-skew, 0deg));
}
[data-dsh-fairy-mascot-root="true"] .dsh-fairy-image {
	opacity: 1;
}
[data-dsh-fairy-mascot-root="true"] .dsh-fairy-glitch-blocks {
	opacity: 0;
	display: none;
}
[data-dsh-fairy-mascot-root="true"] .dsh-fairy-signal[data-glitch="threads"] > .dsh-fairy-image,
[data-dsh-fairy-mascot-root="true"][data-transition-glitch] .dsh-fairy-signal > .dsh-fairy-image {
	filter: url(#dsh-fairy-interference);
}
[data-dsh-fairy-mascot-root="true"] .dsh-fairy-signal[data-glitch="blocks"] .dsh-fairy-glitch-blocks {
	opacity: 1;
	display: block;
}
/* Block clones contain their own lash animation; freeze all copies on one frame. */
[data-dsh-fairy-mascot-root="true"] .dsh-fairy-signal[data-glitch="blocks"] .dsh-fairy-corners {
	animation: none !important;
	transform: rotate(var(--dsh-lash-angle, 0deg));
}
/* The five <use> slices inherit the eye's continuous animations. Pausing their
 * copies at the current frame keeps the same fractured image while avoiding five
 * extra pulse timelines and compositor layers for each short block fault. */
[data-dsh-fairy-mascot-root="true"] .dsh-fairy-signal[data-glitch="blocks"] .dsh-fairy-glitch-blocks .dsh-fairy-sclera,
[data-dsh-fairy-mascot-root="true"] .dsh-fairy-signal[data-glitch="blocks"] .dsh-fairy-glitch-blocks .dsh-fairy-layer-three,
[data-dsh-fairy-mascot-root="true"] .dsh-fairy-signal[data-glitch="blocks"] .dsh-fairy-glitch-blocks .dsh-fairy-layer-two,
[data-dsh-fairy-mascot-root="true"] .dsh-fairy-signal[data-glitch="blocks"] .dsh-fairy-glitch-blocks .dsh-fairy-layer-one {
	animation-play-state: paused !important;
	will-change: auto;
}
[data-dsh-fairy-mascot-root="true"] .dsh-fairy-glitch-1 { transform: translateX(var(--dsh-g-s1-x, 0)); }
[data-dsh-fairy-mascot-root="true"] .dsh-fairy-glitch-2 { transform: translateX(var(--dsh-g-s2-x, 0)); }
[data-dsh-fairy-mascot-root="true"] .dsh-fairy-glitch-3 { transform: translateX(var(--dsh-g-s3-x, 0)); }
[data-dsh-fairy-mascot-root="true"] .dsh-fairy-glitch-4 { transform: translateX(var(--dsh-g-s4-x, 0)); }
[data-dsh-fairy-mascot-root="true"] .dsh-fairy-glitch-5 { transform: translateX(var(--dsh-g-s5-x, 0)); }
/* Constant lash rotation plus staggered, continuous inside-to-outside eye breathing. */
[data-dsh-fairy-mascot-root="true"] .dsh-fairy-corners {
	animation: dsh-fairy-lashes calc(15s / var(--dsh-fairy-steady-rate, 1)) linear infinite;
	animation-delay: var(--dsh-lash-delay, 0s);
	transform-origin: 80px 80px;
	will-change: transform;
}
/* Five nested strokes share one transform/opacity timeline. Their individual
 * stroke widths and opacities still form the same soft pulse without keeping
 * five identical SVG animation timelines alive. */
[data-dsh-fairy-mascot-root="true"] .dsh-fairy-lash-pulse-wave {
	animation: dsh-fairy-lash-pulse var(--dsh-fairy-pulse-cycle, 4s) cubic-bezier(.42, 0, .22, 1) infinite;
	display: block;
	visibility: visible;
	opacity: 1;
	transform-box: view-box;
	transform-origin: 80px 80px;
	will-change: opacity, transform;
}
[data-dsh-fairy-mascot-root="true"][data-dsh-fairy-animation-rate=".7"] .dsh-fairy-lash-pulse-wave { animation-name: dsh-fairy-lash-pulse-slow; }
[data-dsh-fairy-mascot-root="true"][data-dsh-fairy-animation-rate="1.5"] .dsh-fairy-lash-pulse-wave { animation-name: dsh-fairy-lash-pulse-fast; }
[data-dsh-fairy-mascot-root="true"] .dsh-fairy-eye {
	transform: scale(.90);
	transform-origin: 80px 80px;
}
[data-dsh-fairy-mascot-root="true"] .dsh-fairy-eye-flicker {
	opacity: 0;
	animation: none;
}
[data-dsh-fairy-mascot-root="true"] .dsh-fairy-image[data-flicker="true"] ~ .dsh-fairy-eye-flicker,
[data-dsh-fairy-mascot-root="true"] .dsh-fairy-image[data-flicker="true"] .dsh-fairy-eye-flicker {
	animation: dsh-fairy-eye-flicker-overlay var(--dsh-fairy-flicker-duration, 210ms) cubic-bezier(.32, 0, .68, 1) both;
	will-change: opacity;
}
[data-dsh-fairy-mascot-root="true"][data-low-power] .dsh-fairy-eye {
	animation: none !important;
	filter: none !important;
}
[data-dsh-fairy-mascot-root="true"][data-low-power] .dsh-fairy-eye-flicker {
	display: none !important;
}
[data-dsh-fairy-mascot-root="true"][data-state="thinking"] .dsh-fairy-eye {
	clip-path: url(#dsh-fairy-thinking-eye-clip);
}
[data-dsh-fairy-mascot-root="true"][data-state="comforting"] .dsh-fairy-eye {
	clip-path: url(#dsh-fairy-comforting-eye-clip);
}
[data-dsh-fairy-mascot-root="true"] .dsh-fairy-thinking-clip-shape {
	animation: dsh-fairy-thinking-clip calc(.72s / var(--dsh-fairy-steady-rate, 1)) cubic-bezier(.72, 0, .28, 1) 0s infinite alternate;
	animation-play-state: paused;
	transform-box: view-box;
	transform-origin: 80px 60px;
	will-change: auto;
}
[data-dsh-fairy-mascot-root="true"] .dsh-fairy-comforting-clip-shape {
	animation: dsh-fairy-comforting-clip calc(.72s / var(--dsh-fairy-steady-rate, 1)) cubic-bezier(.72, 0, .28, 1) 0s infinite alternate;
	animation-play-state: paused;
	transform-box: view-box;
	transform-origin: 80px 60px;
	will-change: auto;
}
/* The runtime disables these fallback timelines and evaluates the active eyelid
 * path from MascotMotionClock, keeping thinking/comfort on the same phase as the eye. */
[data-dsh-fairy-mascot-root="true"] .dsh-fairy-sclera {
	animation: dsh-fairy-pulse-outer calc(.72s / var(--dsh-fairy-steady-rate, 1)) cubic-bezier(.72, 0, .28, 1) 0s infinite alternate;
	transform-box: view-box;
	transform-origin: 80px 80px;
	will-change: transform;
}
[data-dsh-fairy-mascot-root="true"] .dsh-fairy-layer-three {
	animation: dsh-fairy-pulse-three calc(.72s / var(--dsh-fairy-steady-rate, 1)) cubic-bezier(.72, 0, .28, 1) calc(-.045s / var(--dsh-fairy-steady-rate, 1)) infinite alternate;
	transform-origin: 80px 80px;
	will-change: transform;
}
[data-dsh-fairy-mascot-root="true"] .dsh-fairy-layer-two {
	animation: dsh-fairy-pulse-two calc(.72s / var(--dsh-fairy-steady-rate, 1)) cubic-bezier(.72, 0, .28, 1) calc(-.09s / var(--dsh-fairy-steady-rate, 1)) infinite alternate;
	transform-origin: 80px 80px;
	will-change: transform;
}
[data-dsh-fairy-mascot-root="true"] .dsh-fairy-layer-one {
	animation: dsh-fairy-pulse-inner calc(.72s / var(--dsh-fairy-steady-rate, 1)) cubic-bezier(.72, 0, .28, 1) calc(-.18s / var(--dsh-fairy-steady-rate, 1)) infinite alternate;
	transform-origin: 80px 80px;
	will-change: transform;
}
/* Visual lifecycle is owned by the HDD host contract. Pausing the whole SVG
 * freezes every eye layer on its exact frame; resume code realigns the active
 * eyelid clip to the retained sclera phase before scheduling faults again. */
[data-dsh-fairy-mascot-root="true"][data-visual-suspended],
[data-dsh-fairy-mascot-root="true"][data-visual-suspended] * {
	animation-play-state: paused !important;
	will-change: auto !important;
}
/* Scanline texture stays static; moving this full-size rect continuously causes
 * a needless SVG repaint without changing the state expression. */
/* Correct Fairy arc: the center of the upper lid pushes downward, not upward. */
@keyframes dsh-fairy-thinking-clip {
	from { transform: translateY(14.5px) scaleY(.55); }
	to { transform: translateY(15.5px); }
}
@keyframes dsh-fairy-comforting-clip {
	from { transform: translateY(-4px); }
	to { transform: translateY(4px); }
}
@keyframes dsh-fairy-lash-pulse {
	0% { opacity: 0; transform: scale(.98); }
	/* Transform stays on one continuous 0%-36% path; only opacity steps down. */
	5% { opacity: .72; }
	12% { opacity: .52; }
	20% { opacity: .19; }
	27% { opacity: 0; }
	36%, 100% { opacity: 0; transform: scale(2.78); }
}
@keyframes dsh-fairy-lash-pulse-slow {
	0% { opacity: 0; transform: scale(.98); }
	3.9% { opacity: .72; }
	9.4% { opacity: .52; }
	15.7% { opacity: .19; }
	21.2% { opacity: 0; }
	28.3%, 100% { opacity: 0; transform: scale(2.78); }
}
@keyframes dsh-fairy-lash-pulse-fast {
	0% { opacity: 0; transform: scale(.98); }
	6.4% { opacity: .72; }
	15.3% { opacity: .52; }
	25.4% { opacity: .19; }
	34.3% { opacity: 0; }
	45.8%, 100% { opacity: 0; transform: scale(2.78); }
}
@keyframes dsh-fairy-lashes { to { transform: rotate(360deg); } }
@keyframes dsh-fairy-pulse-outer {
	/* Keep the fully expanded sclera just inside the lid edge so the ring
	 * never becomes visibly thinner than the calibrated resting thickness. */
	from { transform: scale(.985); }
	to { transform: scale(.91); }
}
@keyframes dsh-fairy-pulse-three {
	from { transform: scale(1); }
	to { transform: scale(.90); }
}
@keyframes dsh-fairy-pulse-two {
	from { transform: scale(1); }
	to { transform: scale(.87); }
}
@keyframes dsh-fairy-pulse-inner {
	from { transform: scale(1); }
	to { transform: scale(.85); }
}
@keyframes dsh-fairy-eye-flicker-overlay {
	0%, 100% { opacity: 0; }
	22% { opacity: var(--dsh-fairy-flicker-opacity-1, .04); }
	48% { opacity: var(--dsh-fairy-flicker-opacity-mid, .012); }
	72% { opacity: var(--dsh-fairy-flicker-opacity-2, .03); }
}
@media (max-width: 520px) {
	[data-dsh-fairy-mascot-root="true"] { width: min(76%, 31vh, 324px); height: min(76%, 31vh); }
}
@media (prefers-reduced-motion: reduce) {
	[data-dsh-fairy-mascot-root="true"] *, [data-dsh-fairy-mascot-root="true"] *::before, [data-dsh-fairy-mascot-root="true"] *::after {
		animation: none !important;
	}
		[data-dsh-fairy-mascot-root="true"] .dsh-fairy-signal {
			opacity: 1 !important;
			filter: none !important;
		transform: none !important;
	}
	[data-dsh-fairy-mascot-root="true"] .dsh-fairy-image { opacity: 1 !important; }
	[data-dsh-fairy-mascot-root="true"] .dsh-fairy-glitch-blocks { opacity: 0 !important; }
}
`;

module.exports = CSS;
