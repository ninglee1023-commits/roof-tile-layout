import { generateLayout, nominalTileSize, normalizeRotation } from './layout-engine.js';

function modulo(value, modulus) {
  return ((value % modulus) + modulus) % modulus;
}

function compareScore(a, b) {
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] < b[index] - 1e-9) return -1;
    if (a[index] > b[index] + 1e-9) return 1;
  }
  return 0;
}

function layoutScore(layout, minCut) {
  let deficit = 0;
  let totalCutArea = 0;
  for (const piece of layout.pieces || []) {
    if (!piece.cut) continue;
    const minimum = Math.min(piece.width, piece.height);
    if (minimum < minCut) deficit += minCut - minimum;
    totalCutArea += piece.area;
  }
  const stats = layout.stats || {};
  return [
    Number(stats.smallCutPieces || 0),
    deficit,
    Number(stats.cutPieces || 0),
    -(Number(stats.minPiece) || 0),
    totalCutArea
  ];
}

function phaseSequence(pitch, step) {
  const result = [];
  for (let value = 0; value < pitch - 1e-9; value += step) result.push(value);
  if (!result.length) result.push(0);
  return result;
}

function refinementSequence(center, radius, step, pitch) {
  const values = new Map();
  for (let delta = -radius; delta <= radius + step * .25; delta += step) {
    const phase = modulo(center + delta, pitch);
    values.set(phase.toFixed(6), phase);
  }
  return [...values.values()];
}

export function optimizeGroupOrigin({ settings, regions, group, bands = [] }) {
  if (!regions?.length) throw new Error('沒有可優化的區域。');
  const rotations = new Set(regions.map((region) => normalizeRotation(region.rotation)));
  if (rotations.size > 1) throw new Error('同一排布組包含混合方向；請先統一長邊方向再智能優化。');

  const tile = nominalTileSize(settings, [...rotations][0] || 0);
  const pitchX = tile.width + Math.max(0, Number(settings.jointX || 0));
  const pitchY = tile.height + Math.max(0, Number(settings.jointY || 0));
  const baseX = Math.min(...regions.map((region) => region.bbox.minX));
  const baseY = Math.min(...regions.map((region) => region.bbox.minY));
  const minCut = Math.max(0, Number(settings.minCut || 0));
  const workingGroup = {
    ...group,
    unifiedOrigin: true,
    carryAcross: group.carryAcross !== false,
    offsetX: 0,
    offsetY: 0,
    up: 0,
    down: 0,
    left: 0,
    right: 0
  };

  let evaluations = 0;
  const evaluate = (phaseX, phaseY) => {
    workingGroup.originX = baseX - modulo(phaseX, pitchX);
    workingGroup.originY = baseY - modulo(phaseY, pitchY);
    const layout = generateLayout({ settings, regions, groups: [workingGroup], bands });
    evaluations += 1;
    return {
      phaseX: modulo(phaseX, pitchX),
      phaseY: modulo(phaseY, pitchY),
      originX: workingGroup.originX,
      originY: workingGroup.originY,
      layout,
      score: layoutScore(layout, minCut)
    };
  };

  const currentPhaseX = modulo(baseX - Number(group.originX ?? baseX), pitchX);
  const currentPhaseY = modulo(baseY - Number(group.originY ?? baseY), pitchY);
  const currentCandidate = evaluate(currentPhaseX, currentPhaseY);
  let best = currentCandidate;

  const consider = (candidate) => {
    if (compareScore(candidate.score, best.score) < 0) best = candidate;
  };

  const coarseStep = Math.max(5, Math.min(50, Math.round(Math.min(pitchX, pitchY) / 20)));
  for (const phaseX of phaseSequence(pitchX, coarseStep)) consider(evaluate(phaseX, best.phaseY));
  for (const phaseY of phaseSequence(pitchY, coarseStep)) consider(evaluate(best.phaseX, phaseY));

  for (const phaseX of refinementSequence(best.phaseX, coarseStep, 1, pitchX)) consider(evaluate(phaseX, best.phaseY));
  for (const phaseY of refinementSequence(best.phaseY, coarseStep, 1, pitchY)) consider(evaluate(best.phaseX, phaseY));

  for (const phaseX of refinementSequence(best.phaseX, 1, .1, pitchX)) consider(evaluate(phaseX, best.phaseY));
  for (const phaseY of refinementSequence(best.phaseY, 1, .1, pitchY)) consider(evaluate(best.phaseX, phaseY));

  return {
    ...best,
    evaluations,
    current: {
      phaseX: currentPhaseX,
      phaseY: currentPhaseY,
      score: currentCandidate.score,
      stats: currentCandidate.layout.stats
    }
  };
}
