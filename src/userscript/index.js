import { WatermarkEngine } from '../core/watermarkEngine.js';
import { canvasToBlob } from '../core/canvasBlob.js';
import { installPageImageReplacement } from '../extension/pageImageReplacement.js';
import { isGeminiGeneratedAssetUrl, normalizeGoogleusercontentImageUrl } from './urlUtils.js';
import { toWorkerScriptUrl } from './trustedTypes.js';
import { shouldUseInlineWorker } from './runtimeFlags.js';
import { installGeminiDownloadHook } from './downloadHook.js';
import { createUserscriptBlobFetcher } from './crossOriginFetch.js';

const USERSCRIPT_WORKER_CODE = typeof __US_WORKER_CODE__ === 'string' ? __US_WORKER_CODE__ : '';

let enginePromise = null;
let workerClient = null;

const loadImage = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = reject;
  img.src = src;
});

const canUseInlineWorker = () => shouldUseInlineWorker(USERSCRIPT_WORKER_CODE);

const toError = (errorLike, fallback = 'Inline worker error') => {
  if (errorLike instanceof Error) return errorLike;
  if (typeof errorLike === 'string' && errorLike.length > 0) return new Error(errorLike);
  if (errorLike && typeof errorLike.message === 'string' && errorLike.message.length > 0) {
    return new Error(errorLike.message);
  }
  return new Error(fallback);
};

class InlineWorkerClient {
  constructor(workerCode) {
    const blob = new Blob([workerCode], { type: 'text/javascript' });
    this.workerUrl = URL.createObjectURL(blob);
    const workerScriptUrl = toWorkerScriptUrl(this.workerUrl);
    if (!workerScriptUrl) {
      URL.revokeObjectURL(this.workerUrl);
      this.workerUrl = null;
      throw new Error('Trusted Types policy unavailable for inline worker');
    }
    try {
      this.worker = new Worker(workerScriptUrl);
    } catch (error) {
      URL.revokeObjectURL(this.workerUrl);
      this.workerUrl = null;
      throw error;
    }
    this.pending = new Map();
    this.requestId = 0;
    this.handleMessage = this.handleMessage.bind(this);
    this.handleError = this.handleError.bind(this);
    this.worker.addEventListener('message', this.handleMessage);
    this.worker.addEventListener('error', this.handleError);
  }

  dispose() {
    this.worker.removeEventListener('message', this.handleMessage);
    this.worker.removeEventListener('error', this.handleError);
    this.worker.terminate();
    if (this.workerUrl) {
      URL.revokeObjectURL(this.workerUrl);
      this.workerUrl = null;
    }
    const error = new Error('Inline worker disposed');
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    this.pending.clear();
  }

  handleMessage(event) {
    const payload = event?.data;
    if (!payload || typeof payload.id === 'undefined') return;
    const pending = this.pending.get(payload.id);
    if (!pending) return;
    this.pending.delete(payload.id);
    clearTimeout(pending.timeoutId);
    if (payload.ok) {
      pending.resolve(payload.result);
      return;
    }
    pending.reject(new Error(payload.error?.message || 'Inline worker request failed'));
  }

  handleError(event) {
    const error = new Error(event?.message || 'Inline worker crashed');
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    this.pending.clear();
  }

  request(type, payload, transferList = [], timeoutMs = 120000) {
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Inline worker request timed out: ${type}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeoutId });
      try {
        this.worker.postMessage({ id, type, ...payload }, transferList);
      } catch (error) {
        clearTimeout(timeoutId);
        this.pending.delete(id);
        reject(toError(error));
      }
    });
  }

  async processBlob(blob, options = {}) {
    const inputBuffer = await blob.arrayBuffer();
    const result = await this.request(
      'process-image',
      { inputBuffer, mimeType: blob.type || 'image/png', options },
      [inputBuffer]
    );
    return new Blob([result.processedBuffer], { type: result.mimeType || 'image/png' });
  }
}

async function getEngine() {
  if (!enginePromise) {
    enginePromise = WatermarkEngine.create().catch((error) => {
      enginePromise = null;
      throw error;
    });
  }
  return enginePromise;
}

function disableInlineWorker(reason) {
  if (!workerClient) return;
  console.warn('[Gemini Watermark Remover] Disable worker path:', reason);
  workerClient.dispose();
  workerClient = null;
}

async function processBlobWithBestPath(blob, options = {}) {
  if (workerClient) {
    try {
      return await workerClient.processBlob(blob, options);
    } catch (error) {
      console.warn('[Gemini Watermark Remover] Worker path failed, fallback to main thread:', error);
      disableInlineWorker(error);
    }
  }

  const engine = await getEngine();
  const blobUrl = URL.createObjectURL(blob);
  try {
    const img = await loadImage(blobUrl);
    const canvas = await engine.removeWatermarkFromImage(img, options);
    return await canvasToBlob(canvas);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

async function processImageBlob(blob) {
  return processBlobWithBestPath(blob, { adaptiveMode: 'always' });
}

(async function init() {
  try {
    console.log('[Gemini Watermark Remover] Initializing...');
    const originalPageFetch = typeof unsafeWindow?.fetch === 'function'
      ? unsafeWindow.fetch.bind(unsafeWindow)
      : null;
    const userscriptRequest = typeof GM_xmlhttpRequest === 'function'
      ? GM_xmlhttpRequest
      : globalThis.GM_xmlhttpRequest;
    if (canUseInlineWorker()) {
      try {
        workerClient = new InlineWorkerClient(USERSCRIPT_WORKER_CODE);
        console.log('[Gemini Watermark Remover] Worker acceleration enabled');
      } catch (workerError) {
        workerClient = null;
        console.warn('[Gemini Watermark Remover] Worker initialization failed, using main thread:', workerError);
      }
    }

    if (!workerClient) {
      // Warm up main-thread engine when worker acceleration is unavailable.
      getEngine().catch((error) => {
        console.warn('[Gemini Watermark Remover] Engine warmup failed:', error);
      });
    }

    installGeminiDownloadHook(unsafeWindow, {
      isTargetUrl: isGeminiGeneratedAssetUrl,
      normalizeUrl: normalizeGoogleusercontentImageUrl,
      processBlob: processImageBlob,
      logger: console
    });

    installPageImageReplacement({
      logger: console,
      fetchPreviewBlob: createUserscriptBlobFetcher({
        gmRequest: userscriptRequest,
        fallbackFetch: originalPageFetch
      }),
      removeWatermarkFromBlobImpl: processImageBlob
    });

    window.addEventListener('beforeunload', () => {
      disableInlineWorker('beforeunload');
    });

    console.log('[Gemini Watermark Remover] Ready');
  } catch (error) {
    console.error('[Gemini Watermark Remover] Initialization failed:', error);
  }
})();
