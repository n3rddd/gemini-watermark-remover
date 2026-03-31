import exifr from 'exifr';
import i18n from './i18n.js';
import { isOfficialOrKnownGeminiDimensions } from './core/geminiSizeCatalog.js';
import { classifyGeminiAttributionFromWatermarkMeta } from './core/watermarkDecisionPolicy.js';

function normalizeDimension(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    const rounded = Math.round(numeric);
    return rounded > 0 ? rounded : null;
}

export function isLikelyGeminiDimensions(width, height) {
    const normalizedWidth = normalizeDimension(width);
    const normalizedHeight = normalizeDimension(height);
    if (!normalizedWidth || !normalizedHeight) return false;
    return isOfficialOrKnownGeminiDimensions(normalizedWidth, normalizedHeight);
}

function extractImageDimensions(exif) {
    const width =
        normalizeDimension(exif?.ImageWidth) ??
        normalizeDimension(exif?.ExifImageWidth) ??
        normalizeDimension(exif?.PixelXDimension);
    const height =
        normalizeDimension(exif?.ImageHeight) ??
        normalizeDimension(exif?.ExifImageHeight) ??
        normalizeDimension(exif?.PixelYDimension);
    return { width, height };
}

function readUint16LE(bytes, offset) {
    if (offset + 1 >= bytes.length) return null;
    return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint16BE(bytes, offset) {
    if (offset + 1 >= bytes.length) return null;
    return (bytes[offset] << 8) | bytes[offset + 1];
}

function readUint24LE(bytes, offset) {
    if (offset + 2 >= bytes.length) return null;
    return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readUint32LE(bytes, offset) {
    if (offset + 3 >= bytes.length) return null;
    return (
        bytes[offset] |
        (bytes[offset + 1] << 8) |
        (bytes[offset + 2] << 16) |
        (bytes[offset + 3] << 24)
    ) >>> 0;
}

function readUint32BE(bytes, offset) {
    if (offset + 3 >= bytes.length) return null;
    return (
        (bytes[offset] << 24) |
        (bytes[offset + 1] << 16) |
        (bytes[offset + 2] << 8) |
        bytes[offset + 3]
    ) >>> 0;
}

function extractPngDimensionsFromBytes(bytes) {
    if (bytes.length < 24) return null;
    const isPngSignature = (
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47 &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a
    );
    if (!isPngSignature) return null;

    return {
        width: normalizeDimension(readUint32BE(bytes, 16)),
        height: normalizeDimension(readUint32BE(bytes, 20))
    };
}

function extractWebpDimensionsFromBytes(bytes) {
    if (bytes.length < 30) return null;
    const isWebp = (
        String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
        String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
    );
    if (!isWebp) return null;

    let offset = 12;
    while (offset + 8 <= bytes.length) {
        const chunkType = String.fromCharCode(...bytes.slice(offset, offset + 4));
        const chunkSize = readUint32LE(bytes, offset + 4);
        if (chunkSize === null) return null;
        const chunkDataOffset = offset + 8;
        if (chunkDataOffset + chunkSize > bytes.length) break;

        if (chunkType === 'VP8X' && chunkSize >= 10) {
            return {
                width: normalizeDimension(readUint24LE(bytes, chunkDataOffset + 4) + 1),
                height: normalizeDimension(readUint24LE(bytes, chunkDataOffset + 7) + 1)
            };
        }

        if (chunkType === 'VP8 ' && chunkSize >= 10) {
            const startCodeMatches = (
                bytes[chunkDataOffset + 3] === 0x9d &&
                bytes[chunkDataOffset + 4] === 0x01 &&
                bytes[chunkDataOffset + 5] === 0x2a
            );
            if (startCodeMatches) {
                return {
                    width: normalizeDimension((readUint16LE(bytes, chunkDataOffset + 6) ?? 0) & 0x3fff),
                    height: normalizeDimension((readUint16LE(bytes, chunkDataOffset + 8) ?? 0) & 0x3fff)
                };
            }
        }

        if (chunkType === 'VP8L' && chunkSize >= 5 && bytes[chunkDataOffset] === 0x2f) {
            const b0 = bytes[chunkDataOffset + 1];
            const b1 = bytes[chunkDataOffset + 2];
            const b2 = bytes[chunkDataOffset + 3];
            const b3 = bytes[chunkDataOffset + 4];
            return {
                width: normalizeDimension(1 + b0 + ((b1 & 0x3f) << 8)),
                height: normalizeDimension(1 + (b1 >> 6) + (b2 << 2) + ((b3 & 0x0f) << 10))
            };
        }

        offset = chunkDataOffset + chunkSize + (chunkSize % 2);
    }

    return null;
}

function extractJpegDimensionsFromBytes(bytes) {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
        return null;
    }

    let offset = 2;
    while (offset + 9 < bytes.length) {
        while (offset < bytes.length && bytes[offset] === 0xff) {
            offset++;
        }
        if (offset >= bytes.length) break;

        const marker = bytes[offset];
        offset++;

        if (marker === 0xd9 || marker === 0xda) break;

        const segmentLength = readUint16BE(bytes, offset);
        if (segmentLength === null || segmentLength < 2) break;

        const segmentDataOffset = offset + 2;
        const isStartOfFrame = (
            marker >= 0xc0 &&
            marker <= 0xcf &&
            marker !== 0xc4 &&
            marker !== 0xc8 &&
            marker !== 0xcc
        );
        if (isStartOfFrame && segmentDataOffset + 4 < bytes.length) {
            return {
                width: normalizeDimension(readUint16BE(bytes, segmentDataOffset + 3)),
                height: normalizeDimension(readUint16BE(bytes, segmentDataOffset + 1))
            };
        }

        offset += segmentLength;
    }

    return null;
}

async function extractImageDimensionsFromFile(file) {
    if (!file || typeof file.arrayBuffer !== 'function') {
        return { width: null, height: null };
    }

    try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        return (
            extractPngDimensionsFromBytes(bytes) ??
            extractWebpDimensionsFromBytes(bytes) ??
            extractJpegDimensionsFromBytes(bytes) ??
            { width: null, height: null }
        );
    } catch {
        return { width: null, height: null };
    }
}

export function evaluateOriginalFromExif(exif) {
    const { width, height } = extractImageDimensions(exif);
    const isOriginal = Boolean(width && height);

    const credit = typeof exif?.Credit === 'string' ? exif.Credit.trim() : '';
    const isGoogleByCredit = credit.toLowerCase() === 'made with google ai';

    // Fallback for metadata-stripped exports: accept known Gemini output dimensions.
    const isGoogleByDimension = isOriginal && isLikelyGeminiDimensions(width, height);

    return {
        is_google: isGoogleByCredit || isGoogleByDimension,
        is_original: isOriginal
    };
}

export function loadImage(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = e.target.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

export async function checkOriginal(file) {
    try {
        const exif = await exifr.parse(file, { xmp: true }).catch(() => null);
        const resolvedExif = exif ?? {};
        const evaluated = evaluateOriginalFromExif(resolvedExif);
        if (evaluated.is_original) return evaluated;

        const fallbackDimensions = await extractImageDimensionsFromFile(file);
        if (!fallbackDimensions.width || !fallbackDimensions.height) {
            return evaluated;
        }

        return evaluateOriginalFromExif({
            ...resolvedExif,
            ImageWidth: fallbackDimensions.width,
            ImageHeight: fallbackDimensions.height
        });
    } catch {
        return { is_google: false, is_original: false };
    }
}

export function isLikelyGeminiByWatermarkMeta(
    watermarkMeta
) {
    return classifyGeminiAttributionFromWatermarkMeta(watermarkMeta).tier !== 'insufficient';
}

export function resolveOriginalValidation(validation, watermarkMeta) {
    const normalized = {
        is_google: Boolean(validation?.is_google),
        is_original: Boolean(validation?.is_original)
    };

    if (normalized.is_google) return normalized;
    if (!isLikelyGeminiByWatermarkMeta(watermarkMeta)) return normalized;

    return {
        ...normalized,
        is_google: true
    };
}

export function getOriginalStatus({ is_google, is_original }) {
    if (!is_google) return i18n.t('original.unconfirmed');
    return i18n.t('original.pass');
}

const statusMessage = typeof document !== 'undefined'
    ? document.getElementById('statusMessage')
    : null;
export function setStatusMessage(message = '', type = '') {
    if (!statusMessage) return;
    statusMessage.textContent = message;
    statusMessage.style.display = message ? 'block' : 'none';
    const colorMap = { warn: 'text-warn', success: 'text-success' };
    statusMessage.classList.remove(...Object.values(colorMap));
    if (colorMap[type]) statusMessage.classList.add(colorMap[type]);
}

const loadingOverlay = typeof document !== 'undefined'
    ? document.getElementById('loadingOverlay')
    : null;
export function showLoading(text = null) {
    if (!loadingOverlay) return;
    loadingOverlay.style.display = 'flex';
    const textEl = loadingOverlay.querySelector('p');
    if (textEl && text) textEl.textContent = text;
}

export function hideLoading() {
    if (!loadingOverlay) return;
    loadingOverlay.style.display = 'none';
}
