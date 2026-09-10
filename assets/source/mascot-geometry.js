'use strict';

const MASCOT_GEOMETRY = Object.freeze({
  outerDiscRadius: 68,
  outerStrokeWidth: 1.2,
  outerHaloRadius: 79,
  scleraRadius: 48,
  scleraContactStrokeWidth: 0.8,
  scleraHaloRadius: 56,
  pupilRadius: 16,
  highlightCenter: Object.freeze({ x: 98, y: 100.5 }),
  highlightRadius: 11,
  highlightHaloRadius: 18,
});

const finitePositive = (name, value) => {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid Fairy geometry: ${name}`);
  return value;
};

// Validate every primitive before deriving any dependent edge or ratio. Keeping
// this at the contract boundary prevents malformed settings from leaking into
// SVG attributes or producing an invisible/oversized halo.
for (const [name, value] of Object.entries(MASCOT_GEOMETRY)) {
  if (name === 'highlightCenter') continue;
  finitePositive(name, value);
}

const outerVisibleEdge = finitePositive('outerVisibleEdge', MASCOT_GEOMETRY.outerDiscRadius + MASCOT_GEOMETRY.outerStrokeWidth / 2);
const scleraVisibleEdge = finitePositive('scleraVisibleEdge', MASCOT_GEOMETRY.scleraRadius + MASCOT_GEOMETRY.scleraContactStrokeWidth / 2);
const outerHaloPeak = outerVisibleEdge / finitePositive('outerHaloRadius', MASCOT_GEOMETRY.outerHaloRadius);
const scleraHaloPeak = scleraVisibleEdge / finitePositive('scleraHaloRadius', MASCOT_GEOMETRY.scleraHaloRadius);
const highlightHaloPeak = MASCOT_GEOMETRY.highlightRadius / finitePositive('highlightHaloRadius', MASCOT_GEOMETRY.highlightHaloRadius);

for (const [edge, halo] of [[outerVisibleEdge, MASCOT_GEOMETRY.outerHaloRadius], [scleraVisibleEdge, MASCOT_GEOMETRY.scleraHaloRadius], [MASCOT_GEOMETRY.highlightRadius, MASCOT_GEOMETRY.highlightHaloRadius]]) {
  if (edge >= halo) throw new Error('Invalid Fairy geometry: visible edge must be inside its halo radius');
}
for (const [name, value] of Object.entries(MASCOT_GEOMETRY.highlightCenter)) {
  if (!Number.isFinite(value)) throw new Error(`Invalid Fairy geometry: highlightCenter.${name}`);
}

for (const [name, value] of Object.entries({ outerHaloPeak, scleraHaloPeak, highlightHaloPeak })) {
  if (!(value > 0 && value < 1)) throw new Error(`Invalid Fairy geometry ratio: ${name}`);
}

const formatRatio = (value) => value.toFixed(3).replace(/^0/, '');

module.exports = Object.freeze({
  ...MASCOT_GEOMETRY,
  outerVisibleEdge,
  scleraVisibleEdge,
  outerHaloPeak,
  scleraHaloPeak,
  highlightHaloPeak,
  formatRatio,
});
