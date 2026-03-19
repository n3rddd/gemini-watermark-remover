import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPreviewReplacementCandidates,
  hideProcessingOverlay,
  inferImageMimeTypeFromBytes,
  intersectCaptureRectWithViewport,
  resolvePreviewReplacementResult,
  resolveVisibleCaptureRect,
  showProcessingOverlay,
  waitForRenderableImageSize
} from '../../src/extension/pageImageReplacement.js';

function createMockElement(tagName = 'div') {
  return {
    tagName: String(tagName).toUpperCase(),
    dataset: {},
    style: {},
    textContent: '',
    children: [],
    parentNode: null,
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index >= 0) {
        this.children.splice(index, 1);
        child.parentNode = null;
      }
      return child;
    }
  };
}

test('resolveVisibleCaptureRect should prefer Gemini container rect when image rect is too small', () => {
  const container = {
    getBoundingClientRect() {
      return {
        left: 24,
        top: 36,
        width: 512,
        height: 512
      };
    }
  };

  const image = {
    parentElement: container,
    closest(selector) {
      return selector === 'generated-image,.generated-image-container'
        ? container
        : null;
    },
    getBoundingClientRect() {
      return {
        left: 28,
        top: 40,
        width: 8,
        height: 8
      };
    }
  };

  assert.deepEqual(resolveVisibleCaptureRect(image), {
    left: 24,
    top: 36,
    width: 512,
    height: 512
  });
});

test('resolveVisibleCaptureRect should keep image rect when it is already meaningful', () => {
  const container = {
    getBoundingClientRect() {
      return {
        left: 20,
        top: 30,
        width: 540,
        height: 540
      };
    }
  };

  const image = {
    parentElement: container,
    closest(selector) {
      return selector === 'generated-image,.generated-image-container'
        ? container
        : null;
    },
    getBoundingClientRect() {
      return {
        left: 42,
        top: 54,
        width: 480,
        height: 480
      };
    }
  };

  assert.deepEqual(resolveVisibleCaptureRect(image), {
    left: 42,
    top: 54,
    width: 480,
    height: 480
  });
});

test('resolveVisibleCaptureRect should crop to rendered image content box for object-fit contain previews', () => {
  const originalGetComputedStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => ({
    objectFit: 'contain',
    objectPosition: '50% 50%'
  });

  try {
    const image = {
      naturalWidth: 1200,
      naturalHeight: 600,
      parentElement: null,
      closest: () => null,
      getBoundingClientRect() {
        return {
          left: 20,
          top: 40,
          width: 600,
          height: 600
        };
      }
    };

    assert.deepEqual(resolveVisibleCaptureRect(image), {
      left: 20,
      top: 190,
      width: 600,
      height: 300
    });
  } finally {
    globalThis.getComputedStyle = originalGetComputedStyle;
  }
});

test('intersectCaptureRectWithViewport should clip target rect to visible viewport', () => {
  assert.deepEqual(
    intersectCaptureRectWithViewport(
      {
        left: 20,
        top: 580,
        width: 500,
        height: 220
      },
      {
        left: 0,
        top: 0,
        width: 800,
        height: 640
      }
    ),
    {
      left: 20,
      top: 580,
      width: 500,
      height: 60
    }
  );
});

test('inferImageMimeTypeFromBytes should detect common image signatures', () => {
  assert.equal(
    inferImageMimeTypeFromBytes(new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0, 0, 0, 0, 0, 0, 0, 0])),
    'image/png'
  );
  assert.equal(
    inferImageMimeTypeFromBytes(new Uint8Array([0xFF, 0xD8, 0xFF, 0xEE, 0, 0, 0, 0, 0, 0, 0, 0])),
    'image/jpeg'
  );
  assert.equal(
    inferImageMimeTypeFromBytes(new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50])),
    'image/webp'
  );
  assert.equal(
    inferImageMimeTypeFromBytes(new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66])),
    'image/avif'
  );
});

test('resolvePreviewReplacementResult should skip insufficient preview candidates and choose a confirmed one', async () => {
  const visibleBlob = new Blob(['visible'], { type: 'image/png' });
  const renderedBlob = new Blob(['rendered'], { type: 'image/png' });

  const result = await resolvePreviewReplacementResult({
    candidates: [
      { strategy: 'visible-capture' },
      { strategy: 'rendered-capture' }
    ],
    processCandidate: async (candidate) => {
      if (candidate.strategy === 'visible-capture') {
        return {
          processedBlob: visibleBlob,
          processedMeta: {
            applied: false
          }
        };
      }

      return {
        processedBlob: renderedBlob,
        processedMeta: {
          applied: true,
          size: 48,
          position: {
            x: 900,
            y: 900,
            width: 48,
            height: 48
          },
          source: 'validated-standard',
          detection: {
            originalSpatialScore: 0.24,
            processedSpatialScore: 0.08,
            suppressionGain: 0.35
          }
        }
      };
    }
  });

  assert.equal(result.strategy, 'rendered-capture');
  assert.equal(result.processedBlob, renderedBlob);
});

test('resolvePreviewReplacementResult should allow rendered capture as a safe fallback when visible capture is insufficient', async () => {
  const renderedBlob = new Blob(['rendered'], { type: 'image/png' });

  const result = await resolvePreviewReplacementResult({
    candidates: [
      { strategy: 'visible-capture' },
      { strategy: 'rendered-capture' }
    ],
    processCandidate: async (candidate) => {
      if (candidate.strategy === 'visible-capture') {
        return {
          processedBlob: new Blob(['visible'], { type: 'image/png' }),
          processedMeta: {
            applied: false
          }
        };
      }

      return {
        processedBlob: renderedBlob,
        processedMeta: {
          applied: false
        }
      };
    }
  });

  assert.equal(result.strategy, 'rendered-capture');
  assert.equal(result.processedBlob, renderedBlob);
});

test('resolvePreviewReplacementResult should throw when every preview candidate is insufficient', async () => {
  await assert.rejects(
    () => resolvePreviewReplacementResult({
      candidates: [
        { strategy: 'visible-capture' }
      ],
      processCandidate: async () => ({
        processedBlob: new Blob(['noop'], { type: 'image/png' }),
        processedMeta: {
          applied: false
        }
      })
    }),
    /No confirmed Gemini preview candidate succeeded/
  );
});

test('resolvePreviewReplacementResult should not accept visible capture only because the blob is large', async () => {
  const largeVisibleBlob = new Blob([new Uint8Array(160 * 1024)], { type: 'image/png' });

  await assert.rejects(
    () => resolvePreviewReplacementResult({
      candidates: [
        { strategy: 'visible-capture' }
      ],
      processCandidate: async () => ({
        processedBlob: largeVisibleBlob,
        processedMeta: {
          applied: false
        },
        sourceBlobType: 'image/png',
        sourceBlobSize: largeVisibleBlob.size
      })
    }),
    /No confirmed Gemini preview candidate succeeded/
  );
});

test('resolvePreviewReplacementResult should surface safe fallback errors instead of masking them as insufficient', async () => {
  await assert.rejects(
    async () => {
      await resolvePreviewReplacementResult({
        candidates: [
          { strategy: 'visible-capture' },
          { strategy: 'rendered-capture' }
        ],
        processCandidate: async (candidate) => {
          if (candidate.strategy === 'visible-capture') {
            return {
              processedBlob: new Blob(['visible'], { type: 'image/png' }),
              processedMeta: {
                applied: false
              }
            };
          }

          throw new Error('Rendered capture tainted');
        }
      });
    },
    /Rendered capture tainted/
  );
});

test('buildPreviewReplacementCandidates should include rendered capture when runtime messaging is unavailable', async () => {
  const image = { id: 'fixture-image' };
  const renderedBlob = new Blob(['rendered'], { type: 'image/png' });

  const candidates = buildPreviewReplacementCandidates({
    imageElement: image,
    sendRuntimeMessage: null,
    captureRenderedImageBlob: async (targetImage) => {
      assert.equal(targetImage, image);
      return renderedBlob;
    }
  });

  assert.deepEqual(
    candidates.map((candidate) => candidate.strategy),
    ['rendered-capture']
  );
  assert.equal(await candidates[0].getOriginalBlob(), renderedBlob);
});

test('buildPreviewReplacementCandidates should prefer page fetch when an original preview fetcher is available', async () => {
  const image = { id: 'fixture-image' };
  const fetchedBlob = new Blob(['fetched'], { type: 'image/webp' });
  const sourceUrl = 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj';
  const normalizedSourceUrl = 'https://lh3.googleusercontent.com/gg/example-token=s0-rj';

  const candidates = buildPreviewReplacementCandidates({
    imageElement: image,
    sourceUrl,
    sendRuntimeMessage: null,
    fetchPreviewBlob: async (url) => {
      assert.equal(url, normalizedSourceUrl);
      return fetchedBlob;
    },
    captureRenderedImageBlob: async () => new Blob(['rendered'], { type: 'image/png' })
  });

  assert.deepEqual(
    candidates.map((candidate) => candidate.strategy),
    ['page-fetch', 'rendered-capture']
  );
  assert.equal(await candidates[0].getOriginalBlob(), fetchedBlob);
});

test('showProcessingOverlay should append one overlay and apply a subdued processing look to the image', () => {
  const container = createMockElement('div');
  const image = createMockElement('img');
  image.style.filter = 'contrast(1.1)';

  const createdElements = [];
  const createElement = (tagName) => {
    const element = createMockElement(tagName);
    createdElements.push(element);
    return element;
  };

  showProcessingOverlay(image, {
    container,
    createElement
  });
  showProcessingOverlay(image, {
    container,
    createElement
  });

  assert.equal(container.children.length, 1);
  assert.equal(createdElements.length, 1);
  assert.equal(container.children[0].dataset.gwrProcessingOverlay, 'true');
  assert.equal(container.children[0].textContent, 'Processing...');
  assert.match(image.style.filter, /blur/);
  assert.match(image.style.filter, /brightness/);
  assert.match(image.style.filter, /contrast\(1\.1\)/);
});

test('hideProcessingOverlay should remove overlay and restore the previous image filter', () => {
  const container = createMockElement('div');
  const image = createMockElement('img');
  image.style.filter = 'saturate(1.2)';

  showProcessingOverlay(image, {
    container,
    createElement: createMockElement
  });

  hideProcessingOverlay(image, {
    removeImmediately: true
  });

  assert.equal(container.children.length, 0);
  assert.equal(image.style.filter, 'saturate(1.2)');
  assert.equal(image.dataset.gwrProcessingVisual, undefined);
});

test('hideProcessingOverlay should fade the overlay out before removing it by default', () => {
  const container = createMockElement('div');
  const image = createMockElement('img');
  const timers = [];

  showProcessingOverlay(image, {
    container,
    createElement: createMockElement
  });

  hideProcessingOverlay(image, {
    setTimeoutImpl(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    }
  });

  assert.equal(container.children.length, 1);
  assert.equal(container.children[0].style.opacity, '0');
  assert.equal(timers.length, 1);
  assert.ok(timers[0].delay > 0);

  timers[0].callback();

  assert.equal(container.children.length, 0);
  assert.equal(image.dataset.gwrProcessingVisual, undefined);
});

test('waitForRenderableImageSize should wait for preview images that become renderable on the next frame', async () => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const image = {
    naturalWidth: 0,
    naturalHeight: 0,
    width: 0,
    height: 0,
    clientWidth: 0,
    clientHeight: 0
  };

  globalThis.requestAnimationFrame = (callback) => {
    image.naturalWidth = 1024;
    image.naturalHeight = 1024;
    image.clientWidth = 512;
    image.clientHeight = 512;
    setTimeout(() => callback(16), 0);
    return 1;
  };

  try {
    await assert.doesNotReject(() => waitForRenderableImageSize(image, 50));
  } finally {
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  }
});
