'use strict';

/* Build the halo as a few deterministic static paths instead of hundreds of SVG nodes. */
function buildHaloLines() {
				const paths = new Map();
				for (let y = -34; y <= 194; y += 1) {
					const t = y + 34;
					/* Independent slow waves keep left/right endpoints asymmetric but static. */
					const leftWave = (Math.sin(t * 0.082 - 1.1) + 0.55 * Math.sin(t * 0.151 + 2.4) + 1.55) / 3.1;
					const rightWave = (Math.sin(t * 0.097 + 2.2) + 0.5 * Math.sin(t * 0.137 - 1.7) + 1.5) / 3;
					const leftLength = 158 + leftWave * 56;
					const rightLength = 158 + rightWave * 56;
					const length = leftLength + rightLength;
					const brightness = 0.50 + ((leftWave + rightWave) * .5) * 0.50;
					const x = 80 - leftLength;
					/* Four luminance buckets preserve the existing light falloff while allowing
					 * the browser to rasterize the complete halo in only a handful of paths. */
					const bucket = Math.max(.5, Math.min(1, Math.round(brightness * 8) / 8));
					const key = bucket.toFixed(3);
					if (!paths.has(key)) paths.set(key, []);
					paths.get(key).push("M" + x.toFixed(2) + " " + (y + .25).toFixed(2) + "h" + length.toFixed(2));
				}
				return Array.from(paths.entries()).map(function (entry) {
					return '<path d="' + entry[1].join("") + '" fill="none" stroke="currentColor" stroke-width=".62" stroke-linecap="butt" opacity="' + entry[0] + '"/>';
				}).join("");
			}
			const HALO_LINES = buildHaloLines();
			/* A deliberately oversized, independent viewport keeps the 2.78x pulse
			 * inside SVG paint bounds from its very first layout.  The 3x CSS surface
			 * and 3x viewBox preserve the eye's original pixel scale and center. */
	const PULSE_SVG = `
<svg class="dsh-fairy-pulse-layer" viewBox="-160 -160 480 480" xmlns="http://www.w3.org/2000/svg" role="presentation">
	<g class="dsh-fairy-lash-pulse" fill="none" stroke="#f4fdff">
		<g class="dsh-fairy-lash-pulse-wave">
			<circle cx="80" cy="80" r="52" stroke-width="20" stroke-opacity=".05"/>
			<circle cx="80" cy="80" r="52" stroke-width="16" stroke-opacity=".06"/>
			<circle cx="80" cy="80" r="52" stroke-width="12" stroke-opacity=".08"/>
			<circle cx="80" cy="80" r="52" stroke-width="8" stroke-opacity=".10"/>
			<circle cx="80" cy="80" r="52" stroke-width="4.5" stroke-opacity=".09"/>
		</g>
	</g>
</svg>`;
			/* Keep negative-x halo lines out of the body's 0..160 SVG viewport.
			 * Safari clips overflow from that viewport even when CSS overflow is
			 * visible; this independent user-space viewport preserves the original
			 * line coordinates and lets the halo/pulse fade continuously. */
			const HALO_SVG = `
<svg class="dsh-fairy-halo dsh-fairy-halo-layer" viewBox="-180 -70 520 320" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" role="presentation">
	<defs>
		<radialGradient id="dsh-fairy-halo-layer-fade" gradientUnits="userSpaceOnUse" color-interpolation="linearRGB" cx="80" cy="80" r="124">
			<stop offset="0" stop-color="black"/>
			<stop offset=".44" stop-color="black"/>
			<stop offset=".45" stop-color="white" stop-opacity=".08"/>
			<stop offset=".46" stop-color="white" stop-opacity=".30"/>
			<stop offset=".47" stop-color="white" stop-opacity=".65"/>
			<stop offset=".48" stop-color="white"/>
			<stop offset=".52" stop-color="white" stop-opacity=".72"/>
			<stop offset=".56" stop-color="white" stop-opacity=".56"/>
			<stop offset=".60" stop-color="white" stop-opacity=".44"/>
			<stop offset=".65" stop-color="white" stop-opacity=".30"/>
			<stop offset=".71" stop-color="white" stop-opacity=".19"/>
			<stop offset=".77" stop-color="white" stop-opacity=".135"/>
			<stop offset=".83" stop-color="white" stop-opacity=".09"/>
			<stop offset=".89" stop-color="white" stop-opacity=".058"/>
			<stop offset=".90" stop-color="white" stop-opacity=".052"/>
			<stop offset=".91" stop-color="white" stop-opacity=".046"/>
			<stop offset=".92" stop-color="white" stop-opacity=".039"/>
			<stop offset=".93" stop-color="white" stop-opacity=".032"/>
			<stop offset=".94" stop-color="white" stop-opacity=".025"/>
			<stop offset=".95" stop-color="white" stop-opacity=".019"/>
			<stop offset=".96" stop-color="white" stop-opacity=".013"/>
			<stop offset=".97" stop-color="white" stop-opacity=".0075"/>
			<stop offset=".98" stop-color="white" stop-opacity=".0035"/>
			<stop offset=".99" stop-color="white" stop-opacity=".001"/>
			<stop offset="1" stop-color="white" stop-opacity="0"/>
		</radialGradient>
		<mask id="dsh-fairy-halo-layer-mask" mask-type="luminance" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x="-260" y="-120" width="680" height="440">
			<rect x="-260" y="-120" width="680" height="440" fill="url(#dsh-fairy-halo-layer-fade)"/>
		</mask>
	</defs>
	<g mask="url(#dsh-fairy-halo-layer-mask)" opacity=".99">${HALO_LINES}</g>
</svg>`;


module.exports = Object.freeze({ PULSE_SVG, HALO_SVG });
