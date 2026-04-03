import test from 'node:test';
import assert from 'node:assert/strict';

import {
    aggregatePreviewAlphaMaps,
    blurAlphaMap,
    buildPreviewNeighborhoodPrior,
    estimatePreviewAlphaMap,
    fitConstrainedPreviewAlphaModel,
    fitPreviewOnlyRenderModel,
    fitPreviewRenderModel,
    restorePreviewRegionWithNeighborhoodPrior,
    restorePreviewRegionWithRenderModel,
    renderPreviewWatermarkObservation
} from '../../src/core/previewAlphaCalibration.js';
import { removeWatermark } from '../../src/core/blendModes.js';
import { warpAlphaMap } from '../../src/core/adaptiveDetector.js';
import {
    applySyntheticWatermark,
    cloneTestImageData,
    createPatternImageData,
    createSyntheticAlphaMap
} from './syntheticWatermarkTestUtils.js';

function createPosition(size) {
    return {
        x: 16,
        y: 20,
        width: size,
        height: size
    };
}

function computeMeanAbsoluteError(left, right) {
    let total = 0;
    for (let i = 0; i < left.length; i++) {
        total += Math.abs(left[i] - right[i]);
    }
    return total / left.length;
}

function applyBlurIndependent(alphaMap, size, radius) {
    if (radius <= 0) return new Float32Array(alphaMap);

    let current = new Float32Array(alphaMap);
    for (let pass = 0; pass < radius; pass++) {
        const next = new Float32Array(current.length);
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                let sum = 0;
                let weight = 0;
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const xx = x + dx;
                        const yy = y + dy;
                        if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue;
                        const w = dx === 0 && dy === 0 ? 4 : (dx === 0 || dy === 0 ? 2 : 1);
                        sum += current[yy * size + xx] * w;
                        weight += w;
                    }
                }
                next[y * size + x] = sum / weight;
            }
        }
        current = next;
    }
    return current;
}

function clampChannelIndependent(value) {
    if (!Number.isFinite(value)) return 0;
    if (value <= 0) return 0;
    if (value >= 255) return 255;
    return Math.round(value);
}

function averageStripColorIndependent(imageData, {
    xFrom,
    xTo,
    yFrom,
    yTo
}) {
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let count = 0;

    const minX = Math.max(0, Math.min(xFrom, xTo));
    const maxX = Math.min(imageData.width - 1, Math.max(xFrom, xTo));
    const minY = Math.max(0, Math.min(yFrom, yTo));
    const maxY = Math.min(imageData.height - 1, Math.max(yFrom, yTo));

    for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
            const idx = (y * imageData.width + x) * 4;
            sumR += imageData.data[idx];
            sumG += imageData.data[idx + 1];
            sumB += imageData.data[idx + 2];
            count++;
        }
    }

    if (count <= 0) {
        return [0, 0, 0];
    }

    return [sumR / count, sumG / count, sumB / count];
}

function lerpColorIndependent(left, right, t) {
    return [
        left[0] * (1 - t) + right[0] * t,
        left[1] * (1 - t) + right[1] * t,
        left[2] * (1 - t) + right[2] * t
    ];
}

function buildBoundaryBlendPriorIndependent({
    previewImageData,
    position,
    radius = 6
}) {
    const stripRadius = Math.max(1, Math.round(radius || 1));
    const prior = cloneTestImageData(previewImageData);
    const leftBoundary = [];
    const rightBoundary = [];
    const topBoundary = [];
    const bottomBoundary = [];

    for (let row = 0; row < position.height; row++) {
        const y = position.y + row;
        leftBoundary.push(averageStripColorIndependent(previewImageData, {
            xFrom: position.x - stripRadius,
            xTo: position.x - 1,
            yFrom: y - 1,
            yTo: y + 1
        }));
        rightBoundary.push(averageStripColorIndependent(previewImageData, {
            xFrom: position.x + position.width,
            xTo: position.x + position.width + stripRadius - 1,
            yFrom: y - 1,
            yTo: y + 1
        }));
    }

    for (let col = 0; col < position.width; col++) {
        const x = position.x + col;
        topBoundary.push(averageStripColorIndependent(previewImageData, {
            xFrom: x - 1,
            xTo: x + 1,
            yFrom: position.y - stripRadius,
            yTo: position.y - 1
        }));
        bottomBoundary.push(averageStripColorIndependent(previewImageData, {
            xFrom: x - 1,
            xTo: x + 1,
            yFrom: position.y + position.height,
            yTo: position.y + position.height + stripRadius - 1
        }));
    }

    for (let row = 0; row < position.height; row++) {
        const ty = position.height <= 1 ? 0.5 : row / (position.height - 1);
        for (let col = 0; col < position.width; col++) {
            const tx = position.width <= 1 ? 0.5 : col / (position.width - 1);
            const horizontal = lerpColorIndependent(leftBoundary[row], rightBoundary[row], tx);
            const vertical = lerpColorIndependent(topBoundary[col], bottomBoundary[col], ty);
            const idx = ((position.y + row) * prior.width + (position.x + col)) * 4;
            prior.data[idx] = clampChannelIndependent((horizontal[0] + vertical[0]) * 0.5);
            prior.data[idx + 1] = clampChannelIndependent((horizontal[1] + vertical[1]) * 0.5);
            prior.data[idx + 2] = clampChannelIndependent((horizontal[2] + vertical[2]) * 0.5);
        }
    }

    return prior;
}

function measureRegionAbsDelta(candidateImageData, targetImageData, position) {
    let total = 0;
    let count = 0;
    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const idx = ((position.y + row) * candidateImageData.width + (position.x + col)) * 4;
            for (let channel = 0; channel < 3; channel++) {
                total += Math.abs(candidateImageData.data[idx + channel] - targetImageData.data[idx + channel]);
                count++;
            }
        }
    }

    return count > 0 ? total / count : 0;
}

function applySyntheticPreviewObservation(imageData, alphaMap, position, {
    alphaGain = 1,
    compositeBlurRadius = 0
} = {}) {
    const rendered = cloneTestImageData(imageData);
    applySyntheticWatermark(rendered, alphaMap, position, alphaGain);

    if (compositeBlurRadius <= 0) {
        return rendered;
    }

    let current = rendered;
    for (let pass = 0; pass < compositeBlurRadius; pass++) {
        const next = cloneTestImageData(current);
        for (let row = 0; row < position.height; row++) {
            for (let col = 0; col < position.width; col++) {
                let sumR = 0;
                let sumG = 0;
                let sumB = 0;
                let weight = 0;
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const localX = Math.max(0, Math.min(position.width - 1, col + dx));
                        const localY = Math.max(0, Math.min(position.height - 1, row + dy));
                        const idx = ((position.y + localY) * current.width + (position.x + localX)) * 4;
                        const w = dx === 0 && dy === 0 ? 4 : (dx === 0 || dy === 0 ? 2 : 1);
                        sumR += current.data[idx] * w;
                        sumG += current.data[idx + 1] * w;
                        sumB += current.data[idx + 2] * w;
                        weight += w;
                    }
                }
                const outIdx = ((position.y + row) * next.width + (position.x + col)) * 4;
                next.data[outIdx] = Math.round(sumR / weight);
                next.data[outIdx + 1] = Math.round(sumG / weight);
                next.data[outIdx + 2] = Math.round(sumB / weight);
            }
        }
        current = next;
    }

    return current;
}

test('estimatePreviewAlphaMap should recover a white watermark alpha map from paired source and preview pixels', () => {
    const size = 10;
    const alphaMap = createSyntheticAlphaMap(size);
    const sourceImageData = createPatternImageData(48, 48);
    const previewImageData = cloneTestImageData(sourceImageData);
    const position = createPosition(size);

    applySyntheticWatermark(previewImageData, alphaMap, position, 1);

    const estimated = estimatePreviewAlphaMap({
        sourceImageData,
        previewImageData,
        position
    });

    const meanAbsoluteError = computeMeanAbsoluteError(estimated, alphaMap);
    assert.ok(meanAbsoluteError < 0.02, `meanAbsoluteError=${meanAbsoluteError}`);
});

test('estimatePreviewAlphaMap should clamp invalid divisions instead of emitting NaN for saturated source pixels', () => {
    const sourceImageData = createPatternImageData(32, 32);
    const previewImageData = cloneTestImageData(sourceImageData);
    const position = createPosition(4);

    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const idx = ((position.y + row) * sourceImageData.width + (position.x + col)) * 4;
            sourceImageData.data[idx] = 255;
            sourceImageData.data[idx + 1] = 255;
            sourceImageData.data[idx + 2] = 255;
            previewImageData.data[idx] = 255;
            previewImageData.data[idx + 1] = 255;
            previewImageData.data[idx + 2] = 255;
        }
    }

    const estimated = estimatePreviewAlphaMap({
        sourceImageData,
        previewImageData,
        position
    });

    assert.equal([...estimated].every((value) => Number.isFinite(value)), true);
    assert.equal([...estimated].every((value) => value === 0), true);
});

test('aggregatePreviewAlphaMaps should use the per-pixel median to reject an outlier sample', () => {
    const baseline = new Float32Array([0.1, 0.3, 0.5, 0.7]);
    const nearBaseline = new Float32Array([0.11, 0.29, 0.51, 0.69]);
    const outlier = new Float32Array([0.9, 0.9, 0.9, 0.9]);

    const aggregated = aggregatePreviewAlphaMaps([
        baseline,
        nearBaseline,
        outlier
    ]);

    assert.deepEqual(
        [...aggregated].map((value) => Number(value.toFixed(2))),
        [0.11, 0.30, 0.51, 0.70]
    );
});

test('blurAlphaMap should preserve bounds while softening the peak alpha', () => {
    const alphaMap = new Float32Array([
        0, 0, 0,
        0, 1, 0,
        0, 0, 0
    ]);

    const blurred = blurAlphaMap(alphaMap, 3, 1);

    assert.equal([...blurred].every((value) => value >= 0 && value <= 1), true);
    assert.ok(blurred[4] < 1, `center=${blurred[4]}`);
    assert.ok(blurred[1] > 0, `edge=${blurred[1]}`);
});

test('fitConstrainedPreviewAlphaModel should beat the unwarped standard alpha on a warped blurred preview sample', () => {
    const size = 16;
    const standardAlpha = createSyntheticAlphaMap(size);
    const previewAlpha = applyBlurIndependent(
        warpAlphaMap(standardAlpha, size, { dx: -0.5, dy: 0.5, scale: 1.02 }),
        size,
        1
    );
    const sourceImageData = createPatternImageData(72, 72);
    const previewImageData = cloneTestImageData(sourceImageData);
    const position = createPosition(size);

    applySyntheticWatermark(previewImageData, previewAlpha, position, 1);

    const naiveRestored = cloneTestImageData(previewImageData);
    removeWatermark(naiveRestored, standardAlpha, position, { alphaGain: 1 });
    const naiveDelta = measureRegionAbsDelta(naiveRestored, sourceImageData, position);

    const fitted = fitConstrainedPreviewAlphaModel({
        sourceImageData,
        previewImageData,
        standardAlphaMap: standardAlpha,
        position,
        shiftCandidates: [-0.5, 0, 0.5],
        scaleCandidates: [1, 1.02],
        blurRadii: [0, 1],
        alphaGainCandidates: [1]
    });

    const fittedRestored = cloneTestImageData(previewImageData);
    removeWatermark(fittedRestored, fitted.alphaMap, position, { alphaGain: fitted.alphaGain });
    const fittedDelta = measureRegionAbsDelta(fittedRestored, sourceImageData, position);

    assert.ok(fittedDelta < naiveDelta * 0.8, `naiveDelta=${naiveDelta}, fittedDelta=${fittedDelta}`);
    assert.deepEqual(fitted.params.shift, { dx: -0.5, dy: 0.5, scale: 1.02 });
    assert.equal(fitted.params.blurRadius, 1);
});

test('fitPreviewRenderModel should recover composite blur and beat alpha-only forward reconstruction on a rendered preview sample', () => {
    const size = 16;
    const standardAlpha = createSyntheticAlphaMap(size);
    const previewAlpha = applyBlurIndependent(
        warpAlphaMap(standardAlpha, size, { dx: -0.5, dy: 0.5, scale: 1.02 }),
        size,
        1
    );
    const sourceImageData = createPatternImageData(72, 72);
    const position = createPosition(size);
    const previewImageData = applySyntheticPreviewObservation(sourceImageData, previewAlpha, position, {
        alphaGain: 1,
        compositeBlurRadius: 1
    });

    const constrained = fitConstrainedPreviewAlphaModel({
        sourceImageData,
        previewImageData,
        standardAlphaMap: standardAlpha,
        position,
        shiftCandidates: [-0.5, 0, 0.5],
        scaleCandidates: [1, 1.02],
        blurRadii: [0, 1],
        alphaGainCandidates: [1]
    });
    const constrainedForward = renderPreviewWatermarkObservation({
        sourceImageData,
        alphaMap: constrained.alphaMap,
        position,
        alphaGain: constrained.alphaGain,
        compositeBlurRadius: 0
    });
    const constrainedForwardDelta = measureRegionAbsDelta(constrainedForward, previewImageData, position);

    const fitted = fitPreviewRenderModel({
        sourceImageData,
        previewImageData,
        standardAlphaMap: standardAlpha,
        position,
        shiftCandidates: [-0.5, 0, 0.5],
        scaleCandidates: [1, 1.02],
        alphaBlurRadii: [0, 1],
        compositeBlurRadii: [0, 1],
        alphaGainCandidates: [1]
    });
    const fittedForward = renderPreviewWatermarkObservation({
        sourceImageData,
        alphaMap: fitted.alphaMap,
        position,
        alphaGain: fitted.alphaGain,
        compositeBlurRadius: fitted.params.compositeBlurRadius
    });
    const fittedForwardDelta = measureRegionAbsDelta(fittedForward, previewImageData, position);

    assert.ok(
        fittedForwardDelta < constrainedForwardDelta * 0.8,
        `constrainedForwardDelta=${constrainedForwardDelta}, fittedForwardDelta=${fittedForwardDelta}`
    );
    assert.deepEqual(fitted.params.shift, { dx: -0.5, dy: 0.5, scale: 1.02 });
    assert.equal(fitted.params.alphaBlurRadius, 1);
    assert.equal(fitted.params.compositeBlurRadius, 1);
});

test('restorePreviewRegionWithRenderModel should beat direct inverse alpha removal when preview observation includes composite blur', () => {
    const size = 16;
    const standardAlpha = createSyntheticAlphaMap(size);
    const previewAlpha = applyBlurIndependent(
        warpAlphaMap(standardAlpha, size, { dx: 0.5, dy: -0.5, scale: 0.99 }),
        size,
        1
    );
    const sourceImageData = createPatternImageData(72, 72);
    const position = createPosition(size);
    const previewImageData = applySyntheticPreviewObservation(sourceImageData, previewAlpha, position, {
        alphaGain: 1,
        compositeBlurRadius: 1
    });

    const constrained = fitConstrainedPreviewAlphaModel({
        sourceImageData,
        previewImageData,
        standardAlphaMap: standardAlpha,
        position,
        shiftCandidates: [-0.5, 0, 0.5],
        scaleCandidates: [0.99, 1],
        blurRadii: [0, 1],
        alphaGainCandidates: [1]
    });
    const naiveRestored = cloneTestImageData(previewImageData);
    removeWatermark(naiveRestored, constrained.alphaMap, position, { alphaGain: constrained.alphaGain });
    const naiveDelta = measureRegionAbsDelta(naiveRestored, sourceImageData, position);

    const fitted = fitPreviewRenderModel({
        sourceImageData,
        previewImageData,
        standardAlphaMap: standardAlpha,
        position,
        shiftCandidates: [-0.5, 0, 0.5],
        scaleCandidates: [0.99, 1],
        alphaBlurRadii: [0, 1],
        compositeBlurRadii: [0, 1],
        alphaGainCandidates: [1]
    });
    const restored = restorePreviewRegionWithRenderModel({
        previewImageData,
        alphaMap: fitted.alphaMap,
        position,
        alphaGain: fitted.alphaGain,
        compositeBlurRadius: fitted.params.compositeBlurRadius,
        iterations: 12,
        stepSize: 0.85
    });
    const restoredDelta = measureRegionAbsDelta(restored, sourceImageData, position);

    assert.ok(restoredDelta < naiveDelta * 0.8, `naiveDelta=${naiveDelta}, restoredDelta=${restoredDelta}`);
});

test('buildPreviewNeighborhoodPrior should reconstruct a smooth local background without using source truth', () => {
    const size = 18;
    const sourceImageData = createPatternImageData(80, 80);
    const position = createPosition(size);

    for (let row = -6; row < position.height + 6; row++) {
        for (let col = -6; col < position.width + 6; col++) {
            const x = position.x + col;
            const y = position.y + row;
            if (x < 0 || y < 0 || x >= sourceImageData.width || y >= sourceImageData.height) continue;
            const idx = (y * sourceImageData.width + x) * 4;
            const value = 45 + row * 3 + col * 2;
            sourceImageData.data[idx] = value;
            sourceImageData.data[idx + 1] = value + 5;
            sourceImageData.data[idx + 2] = value + 10;
        }
    }

    const previewImageData = cloneTestImageData(sourceImageData);
    const alphaMap = applyBlurIndependent(createSyntheticAlphaMap(size), size, 1);
    applySyntheticWatermark(previewImageData, alphaMap, position, 1);

    const prior = buildPreviewNeighborhoodPrior({
        previewImageData,
        position,
        radius: 6
    });
    const priorDelta = measureRegionAbsDelta(prior, sourceImageData, position);

    assert.ok(priorDelta < 12, `priorDelta=${priorDelta}`);
});

test('buildPreviewNeighborhoodPrior should beat simple boundary interpolation on a diagonal harmonic background', () => {
    const size = 18;
    const sourceImageData = createPatternImageData(80, 80);
    const position = createPosition(size);

    const centerX = position.x + (position.width - 1) / 2;
    const centerY = position.y + (position.height - 1) / 2;
    for (let row = -6; row < position.height + 6; row++) {
        for (let col = -6; col < position.width + 6; col++) {
            const x = position.x + col;
            const y = position.y + row;
            if (x < 0 || y < 0 || x >= sourceImageData.width || y >= sourceImageData.height) continue;

            const localX = x - centerX;
            const localY = y - centerY;
            const base = 118
                + 0.14 * (localX * localX - localY * localY)
                + 0.35 * localX
                - 0.22 * localY;
            const idx = (y * sourceImageData.width + x) * 4;
            sourceImageData.data[idx] = clampChannelIndependent(base);
            sourceImageData.data[idx + 1] = clampChannelIndependent(base + 7);
            sourceImageData.data[idx + 2] = clampChannelIndependent(base + 14);
        }
    }

    const previewImageData = cloneTestImageData(sourceImageData);
    const alphaMap = applyBlurIndependent(createSyntheticAlphaMap(size), size, 1);
    applySyntheticWatermark(previewImageData, alphaMap, position, 1);

    const baselinePrior = buildBoundaryBlendPriorIndependent({
        previewImageData,
        position,
        radius: 3
    });
    const prior = buildPreviewNeighborhoodPrior({
        previewImageData,
        position,
        radius: 3
    });
    const baselineDelta = measureRegionAbsDelta(baselinePrior, sourceImageData, position);
    const priorDelta = measureRegionAbsDelta(prior, sourceImageData, position);

    assert.ok(
        priorDelta < baselineDelta * 0.75,
        `baselineDelta=${baselineDelta}, priorDelta=${priorDelta}`
    );
});

test('fitPreviewOnlyRenderModel should beat direct inverse alpha removal using only preview neighborhood prior', () => {
    const size = 16;
    const sourceImageData = createPatternImageData(72, 72);
    const position = createPosition(size);

    for (let row = -8; row < position.height + 8; row++) {
        for (let col = -8; col < position.width + 8; col++) {
            const x = position.x + col;
            const y = position.y + row;
            if (x < 0 || y < 0 || x >= sourceImageData.width || y >= sourceImageData.height) continue;
            const idx = (y * sourceImageData.width + x) * 4;
            const wave = Math.round(18 * Math.sin((x + y) / 7));
            sourceImageData.data[idx] = 92 + wave;
            sourceImageData.data[idx + 1] = 112 + wave;
            sourceImageData.data[idx + 2] = 138 + wave;
        }
    }

    const standardAlpha = createSyntheticAlphaMap(size);
    const previewAlpha = applyBlurIndependent(
        warpAlphaMap(standardAlpha, size, { dx: 0.5, dy: -0.5, scale: 0.99 }),
        size,
        1
    );
    const previewImageData = applySyntheticPreviewObservation(sourceImageData, previewAlpha, position, {
        alphaGain: 1,
        compositeBlurRadius: 1
    });

    const naiveRestored = cloneTestImageData(previewImageData);
    removeWatermark(naiveRestored, standardAlpha, position, { alphaGain: 1 });
    const naiveDelta = measureRegionAbsDelta(naiveRestored, sourceImageData, position);

    const fitted = fitPreviewOnlyRenderModel({
        previewImageData,
        standardAlphaMap: standardAlpha,
        position,
        shiftCandidates: [-0.5, 0, 0.5],
        scaleCandidates: [0.99, 1],
        alphaBlurRadii: [0, 1],
        compositeBlurRadii: [0, 1],
        alphaGainCandidates: [1],
        priorRadius: 6
    });
    const restored = restorePreviewRegionWithNeighborhoodPrior({
        previewImageData,
        alphaMap: fitted.alphaMap,
        position,
        alphaGain: fitted.alphaGain,
        priorImageData: fitted.priorImageData,
        blendStrength: 0.85
    });
    const restoredDelta = measureRegionAbsDelta(restored, sourceImageData, position);

    assert.ok(restoredDelta < naiveDelta * 0.85, `naiveDelta=${naiveDelta}, restoredDelta=${restoredDelta}`);
    assert.deepEqual({ dx: fitted.params.shift.dx, dy: fitted.params.shift.dy }, { dx: 0.5, dy: -0.5 });
});
