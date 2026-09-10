'use strict';

const geometry = require('./mascot-geometry.js');
const {
	outerDiscRadius,
	outerStrokeWidth,
	outerHaloRadius,
	outerVisibleEdge,
	outerHaloPeak,
	scleraRadius,
	scleraContactStrokeWidth,
	scleraHaloRadius,
	scleraHaloPeak,
	pupilRadius,
	highlightCenter,
	highlightRadius,
	highlightHaloRadius,
	highlightHaloPeak,
	formatRatio,
} = geometry;

const SVG = `
<svg class="dsh-fairy-main" viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg" role="presentation">
	<defs>
		<!-- Color, glow, scanline, and horizontal-only displacement resources. -->
		<linearGradient id="dsh-fairy-outer-gradient" x1=".2" y1="0" x2=".8" y2="1">
			<stop stop-color="#4053f0"/>
			<stop offset=".54" stop-color="#3045dc"/>
			<stop offset="1" stop-color="#3d50c8"/>
		</linearGradient>
		<!-- One static radial field replaces separate halo strokes, avoiding alpha seams. -->
		<radialGradient id="dsh-fairy-sclera-halo-gradient" gradientUnits="userSpaceOnUse" cx="80" cy="80" r="${scleraHaloRadius}" color-interpolation="linearRGB">
			<stop offset=".82" stop-color="#ffffff" stop-opacity="0"/>
			<stop offset="${formatRatio(scleraHaloPeak)}" stop-color="#ffffff" stop-opacity=".22"/>
			<stop offset=".875" stop-color="#ffffff" stop-opacity=".28"/>
			<stop offset=".89" stop-color="#ffffff" stop-opacity=".19"/>
			<stop offset=".91" stop-color="#ffffff" stop-opacity=".11"/>
			<stop offset=".94" stop-color="#ffffff" stop-opacity=".07"/>
			<stop offset=".96" stop-color="#ffffff" stop-opacity=".035"/>
			<stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
		</radialGradient>
		<radialGradient id="dsh-fairy-outer-halo-gradient" gradientUnits="userSpaceOnUse" cx="80" cy="80" r="${outerHaloRadius}" color-interpolation="linearRGB">
			<stop offset=".80" stop-color="var(--dsh-fairy-outer-halo-color)" stop-opacity="0"/>
			<stop offset=".84" stop-color="var(--dsh-fairy-outer-halo-color)" stop-opacity=".10"/>
			<stop offset="${formatRatio(outerHaloPeak)}" stop-color="var(--dsh-fairy-outer-halo-color)" stop-opacity=".28"/>
			<stop offset=".90" stop-color="var(--dsh-fairy-outer-halo-color)" stop-opacity=".18"/>
			<stop offset=".95" stop-color="var(--dsh-fairy-outer-halo-color)" stop-opacity=".06"/>
			<stop offset=".99" stop-color="var(--dsh-fairy-outer-halo-color)" stop-opacity=".02"/>
			<stop offset="1" stop-color="var(--dsh-fairy-outer-halo-color)" stop-opacity="0"/>
		</radialGradient>
		<radialGradient id="dsh-fairy-highlight-halo-gradient" gradientUnits="userSpaceOnUse" cx="${highlightCenter.x}" cy="${highlightCenter.y}" r="${highlightHaloRadius}" color-interpolation="linearRGB">
			<stop offset=".53" stop-color="#f5f8fd" stop-opacity="0"/>
			<stop offset=".56" stop-color="#f5f8fd" stop-opacity=".16"/>
			<stop offset="${formatRatio(highlightHaloPeak)}" stop-color="#f5f8fd" stop-opacity=".43"/>
			<stop offset=".72" stop-color="#f5f8fd" stop-opacity=".19"/>
			<stop offset=".77" stop-color="#f5f8fd" stop-opacity=".12"/>
			<stop offset=".83" stop-color="#f5f8fd" stop-opacity=".055"/>
			<stop offset=".89" stop-color="#f5f8fd" stop-opacity=".02"/>
			<stop offset=".96" stop-color="#f5f8fd" stop-opacity=".004"/>
			<stop offset="1" stop-color="#f5f8fd" stop-opacity="0"/>
		</radialGradient>
		<pattern id="dsh-fairy-lines" width="4" height="4" patternUnits="userSpaceOnUse">
			<!-- Keep the internal scanline texture present but quieter against the eye. -->
			<rect width="4" height="1" fill="#c9f8ff" opacity=".055"/>
		</pattern>
			<!-- Blue is forced to 0.5 so the displacement map moves pixels horizontally only. -->
			<!-- Horizontal glitch noise is intentionally low-resolution. The map never
			     moves pixels vertically, so its filter cache needs less vertical coverage
			     and resolution while interpolation keeps the tear continuous. -->
			<filter id="dsh-fairy-interference" x="-30%" y="0%" width="160%" height="100%" filterRes="96 72" color-interpolation-filters="sRGB">
			<feTurbulence id="dsh-fairy-noise" type="fractalNoise" baseFrequency=".012 .72" numOctaves="1" seed="1" result="noise"/>
			<feColorMatrix in="noise" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 0 0 .5  0 0 0 1 0" result="horizontal-noise"/>
			<feDisplacementMap id="dsh-fairy-displace" in="SourceGraphic" in2="horizontal-noise" scale="5" xChannelSelector="R" yChannelSelector="B"/>
		</filter>
		<clipPath id="dsh-fairy-disc-clip"><circle cx="80" cy="80" r="${outerDiscRadius - 1}"/></clipPath>
		<clipPath id="dsh-fairy-thinking-eye-clip">
			<path class="dsh-fairy-thinking-clip-shape" d="M20 60 Q80 90 140 60 V160 H20 Z"/>
			<!-- This fixed lower region prevents curve scaling from clipping the lower eye. -->
			<rect x="0" y="108" width="160" height="52"/>
		</clipPath>
		<!-- A shallow reversed arc gives Fairy the gentle, slightly drooped brow. -->
		<clipPath id="dsh-fairy-comforting-eye-clip">
			<path class="dsh-fairy-comforting-clip-shape" d="M20 60 Q80 30 140 60 V160 H20 Z"/>
			<rect x="0" y="108" width="160" height="52"/>
		</clipPath>
		<!-- These five rectangles are resized slightly for every block-glitch event. -->
		<clipPath id="dsh-fairy-slice-1"><rect x="4" y="12" width="152" height="25"/></clipPath>
		<clipPath id="dsh-fairy-slice-2"><rect x="4" y="37" width="152" height="28"/></clipPath>
		<clipPath id="dsh-fairy-slice-3"><rect x="4" y="65" width="152" height="26"/></clipPath>
		<clipPath id="dsh-fairy-slice-4"><rect x="4" y="91" width="152" height="30"/></clipPath>
		<clipPath id="dsh-fairy-slice-5"><rect x="4" y="121" width="152" height="27"/></clipPath>
		</defs>
	
		<g class="dsh-fairy-body">
	<!-- Stable outer radial halo stays outside the fault signal so it is not
	     filtered or duplicated by the block-glitch clones. -->
		<circle class="dsh-fairy-outer-halo" cx="80" cy="80" r="${outerHaloRadius}" fill="url(#dsh-fairy-outer-halo-gradient)"/>
	<g class="dsh-fairy-signal" data-fault-source="true">
	<!-- The complete normal visual. Glitch modes filter or slice this entire group. -->
	<g id="dsh-fairy-image" class="dsh-fairy-image">
		<circle class="dsh-fairy-outer-disc" cx="80" cy="80" r="${outerDiscRadius}" fill="url(#dsh-fairy-outer-gradient)" stroke="#f2fbff" stroke-width="${outerStrokeWidth}"/>
	<!-- Dark circle + square form the four rotating lashes / eyelids. -->
	<g class="dsh-fairy-corners" clip-path="url(#dsh-fairy-disc-clip)" fill="#2b3388">
		<!-- Slightly open the eye: reduce the lid ring without changing its silhouette. -->
		<circle cx="80" cy="80" r="51.75"/>
		<rect x="37" y="37" width="86" height="86" rx="2" transform="rotate(3 80 80)"/>
	</g>

	<!-- Eye anatomy: sclera, layered eyeball, pupil, then highlight. -->
	<g class="dsh-fairy-eye">
			<!-- One animated group keeps the vector rim pixel-locked to the sclera. -->
			<g class="dsh-fairy-sclera">
				<circle cx="80" cy="80" r="${scleraRadius}" fill="#eef0f5"/>
				<circle class="dsh-fairy-sclera-halo" cx="80" cy="80" r="${scleraHaloRadius}" fill="url(#dsh-fairy-sclera-halo-gradient)"/>
				<!-- A thin contact rim closes subpixel seams at the sclera/halo boundary. -->
				<circle class="dsh-fairy-sclera-contact" cx="80" cy="80" r="${scleraRadius}" fill="none" stroke="#ffffff" stroke-width="${scleraContactStrokeWidth}" stroke-opacity=".16"/>
			</g>
		<g class="dsh-fairy-eyeball">
			<circle class="dsh-fairy-layer-three" cx="80" cy="80" r="33" fill="#9daee0"/>
			<circle class="dsh-fairy-layer-two" cx="80" cy="80" r="24.15" fill="#eef0f5"/>
			<circle class="dsh-fairy-layer-two" cx="80" cy="80" r="23.5" fill="#317bcf"/>
			<circle class="dsh-fairy-layer-one" cx="80" cy="80" r="16.6" fill="none" stroke="#f5f8fd" stroke-width=".1"/>
			<circle class="dsh-fairy-layer-one" cx="80" cy="80" r="${pupilRadius}" fill="#3b3d8a"/>
				<g class="dsh-fairy-highlight dsh-fairy-layer-two">
					<circle class="dsh-fairy-highlight-halo" cx="${highlightCenter.x}" cy="${highlightCenter.y}" r="${highlightHaloRadius}" fill="url(#dsh-fairy-highlight-halo-gradient)"/>
					<circle class="dsh-fairy-highlight-glow" cx="${highlightCenter.x}" cy="${highlightCenter.y}" r="${highlightRadius}" fill="#f5f8fd"/>
			</g>
		</g>
	</g>
	<!-- Full-eye flicker layer stays outside the scaled eye group and is not part
	     of the fault clone source; it covers the disc and brows only. -->
	<circle class="dsh-fairy-eye-flicker" cx="80" cy="80" r="${outerVisibleEdge}" fill="#ffffff" pointer-events="none"/>

	<g clip-path="url(#dsh-fairy-disc-clip)" opacity=".42">
		<rect class="dsh-fairy-scanlines" x="12" y="10" width="136" height="146" fill="url(#dsh-fairy-lines)"/>
	</g>
	</g>
	<!-- Five complete-image clones clipped into horizontal blocks for left/right displacement. -->
	<g class="dsh-fairy-glitch-blocks">
		<use href="#dsh-fairy-image" class="dsh-fairy-glitch-1" clip-path="url(#dsh-fairy-slice-1)"/>
		<use href="#dsh-fairy-image" class="dsh-fairy-glitch-2" clip-path="url(#dsh-fairy-slice-2)"/>
		<use href="#dsh-fairy-image" class="dsh-fairy-glitch-3" clip-path="url(#dsh-fairy-slice-3)"/>
		<use href="#dsh-fairy-image" class="dsh-fairy-glitch-4" clip-path="url(#dsh-fairy-slice-4)"/>
		<use href="#dsh-fairy-image" class="dsh-fairy-glitch-5" clip-path="url(#dsh-fairy-slice-5)"/>
	</g>
	</g>
	</g>
		</svg>`;



module.exports = SVG;
