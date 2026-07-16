'use strict';

const zlib = require('node:zlib');

const MAX_MAP_DIMENSION = 4096;
const MAX_MAP_PIXELS = 16 * 1024 * 1024;
const MAX_DATA_URI_LENGTH = 1024 * 1024;
const EMPTY_IMAGE = '';
const MAP_BACKGROUND = [236, 236, 246, 255];
const MAP_FILL = [214, 216, 231, 255];
const MAP_EDGE = [216, 215, 231, 255];
const MOWED_PATH_COLOR = [108, 120, 232, 255];
const FORBIDDEN_AREA_COLOR = [220, 38, 38, 255];
const MOWED_PATH_HEADER_LENGTH = 22;
const MOWED_PATH_RECORD_LENGTH = 5;
const MOWED_PATH_RADIUS = 1;
const MAX_HISTORY_POINTS = 100000;

/**
 * @typedef {{ width: number, height: number, pixels: Buffer, metadata: object, mowedRaster?: MowedRaster }} MapRaster
 */

/**
 * @typedef {{ width: number, height: number, resolution: number, xMin: number, yMin: number, pixels: Buffer }} MowedRaster
 */

/**
 * @param {Buffer} archive
 * @returns {MapRaster|null}
 */
function extractMapRasterFromArchive(archive) {
    if (!Buffer.isBuffer(archive) || archive.length === 0) {
        return null;
    }

    let tar;
    try {
        tar = zlib.gunzipSync(archive);
    } catch {
        return null;
    }

    const files = new Map();
    let offset = 0;
    while (offset + 512 <= tar.length) {
        const header = tar.subarray(offset, offset + 512);
        if (header.every(byte => byte === 0)) {
            break;
        }
        const name = readTarString(header, 0, 100);
        const prefix = readTarString(header, 345, 155);
        const fileName = prefix ? `${prefix}/${name}` : name;
        const sizeText = readTarString(header, 124, 12).trim();
        const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
        if (!fileName || !Number.isSafeInteger(size) || size < 0) {
            return null;
        }
        const contentStart = offset + 512;
        const contentEnd = contentStart + size;
        if (contentEnd > tar.length) {
            return null;
        }
        if (fileName.endsWith('/remote_map_navi.map') || fileName.endsWith('/remote_map.json')) {
            files.set(fileName.split('/').at(-1), Buffer.from(tar.subarray(contentStart, contentEnd)));
        }
        if (fileName.endsWith('/rtk_mask_map')) {
            files.set('rtk_mask_map', Buffer.from(tar.subarray(contentStart, contentEnd)));
        }
        offset = contentStart + Math.ceil(size / 512) * 512;
    }

    const pixels = files.get('remote_map_navi.map');
    const metadataBytes = files.get('remote_map.json');
    if (!pixels || !metadataBytes) {
        return null;
    }

    let metadata;
    try {
        metadata = JSON.parse(metadataBytes.toString('utf8'));
    } catch {
        return null;
    }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        return null;
    }

    const naviMap = metadata.navi_map;
    const width = asMapDimension(naviMap?.width);
    const height = asMapDimension(naviMap?.height);
    if (width == null || height == null || width * height > MAX_MAP_PIXELS || pixels.length !== width * height) {
        return null;
    }

    const mapRaster = { width, height, pixels, metadata };
    const mowedRaster = parseMowedRaster(files.get('rtk_mask_map'));
    if (mowedRaster) {
        mapRaster.mowedRaster = mowedRaster;
    }
    return mapRaster;
}

/**
 * @param {Buffer|undefined} value
 * @returns {MowedRaster|null}
 */
function parseMowedRaster(value) {
    if (!Buffer.isBuffer(value) || value.length < 28) {
        return null;
    }
    const width = asMapDimension(value.readUInt32LE(0));
    const height = asMapDimension(value.readUInt32LE(4));
    const resolution = value.readFloatLE(8);
    const xMin = value.readFloatLE(12);
    const yMin = value.readFloatLE(16);
    if (
        width == null ||
        height == null ||
        !Number.isFinite(resolution) ||
        resolution <= 0 ||
        !Number.isFinite(xMin) ||
        !Number.isFinite(yMin) ||
        value.length !== 28 + width * height
    ) {
        return null;
    }
    return {
        width,
        height,
        resolution,
        xMin,
        yMin,
        pixels: Buffer.from(value.subarray(28)),
    };
}

/**
 * @param {Buffer} header
 * @param {number} start
 * @param {number} length
 * @returns {string}
 */
function readTarString(header, start, length) {
    return header
        .subarray(start, start + length)
        .toString('utf8')
        .replace(/\0.*$/, '');
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function asMapDimension(value) {
    const dimension = typeof value === 'number' ? value : Number(value);
    return Number.isInteger(dimension) && dimension > 0 && dimension <= MAX_MAP_DIMENSION ? dimension : null;
}

/**
 * @param {Buffer} data
 * @returns {number}
 */
function crc32(data) {
    let crc = 0xffffffff;
    for (const byte of data) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) {
            crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

/**
 * @param {string} type
 * @param {Buffer} data
 * @returns {Buffer}
 */
function pngChunk(type, data) {
    const typeBuffer = Buffer.from(type, 'ascii');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
    return Buffer.concat([length, typeBuffer, data, checksum]);
}

/**
 * The mower raster uses 0 for outside the map, 255 for the traversable area,
 * and intermediate values for the map edge/obstacle pixels. The app renders
 * those classes with a light palette instead of treating them as grayscale.
 *
 * @param {number} value
 * @returns {number[]}
 */
function mapPixelColor(value) {
    if (value === 255) {
        return MAP_FILL;
    }
    if (value === 0) {
        return MAP_BACKGROUND;
    }
    return MAP_EDGE;
}

/**
 * Decode the compact path payload reported in the property shadow.
 * Each record stores an x/y coordinate in centimetres followed by a path flag.
 *
 * @param {string} value
 * @returns {{ x: number, y: number, flag: number }[]}
 */
function decodeBase64Path(value) {
    if (!value || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) {
        return [];
    }
    return decodeCompactPath(Buffer.from(value, 'base64'));
}

/**
 * @param {Buffer} bytes
 * @returns {{ x: number, y: number, flag: number }[]}
 */
function decodeCompactPath(bytes) {
    if (bytes.length < MOWED_PATH_HEADER_LENGTH) {
        return [];
    }
    const count = bytes.readUInt32LE(4);
    if (
        count === 0 ||
        count > MAX_HISTORY_POINTS ||
        bytes.length < MOWED_PATH_HEADER_LENGTH + count * MOWED_PATH_RECORD_LENGTH
    ) {
        return [];
    }

    const points = [];
    for (let index = 0; index < count; index++) {
        const offset = MOWED_PATH_HEADER_LENGTH + index * MOWED_PATH_RECORD_LENGTH;
        points.push({
            x: bytes.readInt16LE(offset),
            y: bytes.readInt16LE(offset + 2),
            flag: bytes[offset + 4],
        });
    }
    return points;
}

/**
 * Parse the historical path file downloaded by the Anthbot app.
 * The device firmware has used compact path payloads, JSON point arrays,
 * and line-oriented coordinate files across model generations.
 *
 * @param {Buffer|string|unknown} value
 * @returns {{ x: number, y: number, flag: number }[]}
 */
function parseHistoryPath(value) {
    const bytes = Buffer.isBuffer(value) ? value : typeof value === 'string' ? Buffer.from(value, 'utf8') : null;
    if (!bytes || bytes.length === 0) {
        return [];
    }

    const compactPoints = decodeCompactPath(bytes);
    if (compactPoints.length) {
        return compactPoints;
    }

    const text = bytes
        .toString('utf8')
        .replace(/^\uFEFF/, '')
        .trim();
    if (!text) {
        return [];
    }
    const encodedPoints = decodeBase64Path(text);
    if (encodedPoints.length) {
        return encodedPoints;
    }

    try {
        const jsonPoints = extractHistoryPoints(JSON.parse(text));
        if (jsonPoints.length) {
            return jsonPoints;
        }
    } catch {
        // Continue with the line-oriented format below.
    }

    return normalizePathPoints(
        text
            .split(/\r?\n/)
            .map(line => {
                const numbers = line.match(/[-+]?(?:\d+\.?\d*|\.\d+)/g)?.map(Number) || [];
                return numbers.length >= 2 ? { x: numbers[0], y: numbers[1], flag: numbers[2] ?? 5 } : null;
            })
            .filter(point => point != null),
    );
}

/**
 * @param {unknown} value
 * @returns {{ x: number, y: number, flag: number }[]}
 */
function extractHistoryPoints(value) {
    if (Array.isArray(value)) {
        const directPoints = normalizePathPoints(value);
        if (directPoints.length) {
            return directPoints;
        }
        return value.flatMap(extractHistoryPoints).slice(0, MAX_HISTORY_POINTS);
    }
    if (!value || typeof value !== 'object') {
        return [];
    }
    const directPoint = normalizePathPoint(value);
    if (directPoint) {
        return [directPoint];
    }
    const record = /** @type {Record<string, unknown>} */ (value);
    for (const key of ['points', 'path', 'hispath', 'data', 'coordinates', 'list']) {
        if (record[key] !== undefined) {
            const points = extractHistoryPoints(record[key]);
            if (points.length) {
                return points;
            }
        }
    }
    return [];
}

/**
 * @param {unknown} value
 * @returns {{ x: number, y: number, flag: number }|null}
 */
function normalizePathPoint(value) {
    if (Array.isArray(value)) {
        const x = Number(value[0]);
        const y = Number(value[1]);
        const flag = Number(value[2] ?? 5);
        return Number.isFinite(x) && Number.isFinite(y) ? { x, y, flag: Number.isFinite(flag) ? flag : 5 } : null;
    }
    if (!value || typeof value !== 'object') {
        return null;
    }
    const record = /** @type {Record<string, unknown>} */ (value);
    const x = Number(record.x ?? record.point_x ?? record.pointX);
    const y = Number(record.y ?? record.point_y ?? record.pointY);
    const flag = Number(record.flag ?? record.type ?? 5);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y, flag: Number.isFinite(flag) ? flag : 5 } : null;
}

/**
 * @param {unknown[]} points
 * @returns {{ x: number, y: number, flag: number }[]}
 */
function normalizePathPoints(points) {
    return points
        .map(normalizePathPoint)
        .filter(point => point != null)
        .slice(0, MAX_HISTORY_POINTS);
}

/**
 * @param {MapRaster} mapRaster
 * @param {{ x: number, y: number }} point
 * @returns {{ x: number, y: number }|null}
 */
function mapPointToPixel(mapRaster, point) {
    const naviMap = mapRaster.metadata?.navi_map;
    const resolution = Number(naviMap?.resolution);
    const xMin = Number(naviMap?.x_min);
    const yMin = Number(naviMap?.y_min);
    if (!Number.isFinite(resolution) || resolution <= 0 || !Number.isFinite(xMin) || !Number.isFinite(yMin)) {
        return null;
    }

    return {
        x: Math.round((point.x / 100 - xMin) / resolution),
        y: mapRaster.height - 1 - Math.round((point.y / 100 - yMin) / resolution),
    };
}

/**
 * @param {unknown} area
 * @returns {number[][]}
 */
function forbiddenAreaVertices(area) {
    const areaRecord = area && typeof area === 'object' ? /** @type {Record<string, unknown>} */ (area) : null;
    const rawVertices = areaRecord ? areaRecord.vertexs || areaRecord.vertices || areaRecord.points : null;
    if (!Array.isArray(rawVertices)) {
        return [];
    }
    const vertices = rawVertices
        .filter(point => Array.isArray(point) && point.length >= 2)
        .map(point => [Number(point[0]), Number(point[1])])
        .filter(point => Number.isFinite(point[0]) && Number.isFinite(point[1]));
    return vertices.length >= 3 ? vertices : [];
}

/**
 * @param {unknown} areas
 * @returns {number[][][]}
 */
function normalizeForbiddenAreas(areas) {
    if (!Array.isArray(areas)) {
        return [];
    }
    return areas.map(forbiddenAreaVertices).filter(vertices => vertices.length >= 3);
}

/**
 * @param {number} x
 * @param {number} y
 * @param {number[]} start
 * @param {number[]} end
 * @returns {boolean}
 */
function pointOnSegment(x, y, start, end) {
    const cross = (x - start[0]) * (end[1] - start[1]) - (y - start[1]) * (end[0] - start[0]);
    if (Math.abs(cross) > 0.0001) {
        return false;
    }
    return (
        x >= Math.min(start[0], end[0]) &&
        x <= Math.max(start[0], end[0]) &&
        y >= Math.min(start[1], end[1]) &&
        y <= Math.max(start[1], end[1])
    );
}

/**
 * @param {number} x
 * @param {number} y
 * @param {number[][]} vertices
 * @returns {boolean}
 */
function pointInPolygon(x, y, vertices) {
    let inside = false;
    for (let index = 0, previous = vertices.length - 1; index < vertices.length; previous = index++) {
        const currentVertex = vertices[index];
        const previousVertex = vertices[previous];
        if (pointOnSegment(x, y, currentVertex, previousVertex)) {
            return true;
        }
        if (
            currentVertex[1] > y !== previousVertex[1] > y &&
            x <
                ((previousVertex[0] - currentVertex[0]) * (y - currentVertex[1])) /
                    (previousVertex[1] - currentVertex[1]) +
                    currentVertex[0]
        ) {
            inside = !inside;
        }
    }
    return inside;
}

/**
 * @param {MapRaster} mapRaster
 * @param {number} x
 * @param {number} y
 * @param {number[][][]} forbiddenPolygons
 * @returns {boolean}
 */
function isForbiddenPixel(mapRaster, x, y, forbiddenPolygons) {
    const naviMap = mapRaster.metadata?.navi_map;
    const resolution = Number(naviMap?.resolution);
    const xMin = Number(naviMap?.x_min);
    const yMin = Number(naviMap?.y_min);
    if (
        !forbiddenPolygons.length ||
        !Number.isFinite(resolution) ||
        resolution <= 0 ||
        !Number.isFinite(xMin) ||
        !Number.isFinite(yMin)
    ) {
        return false;
    }
    const sourceY = mapRaster.height - 1 - y;
    const worldXMillimeters = (xMin + x * resolution) * 1000;
    const worldYMillimeters = (yMin + sourceY * resolution) * 1000;
    return forbiddenPolygons.some(vertices => pointInPolygon(worldXMillimeters, worldYMillimeters, vertices));
}

/**
 * @param {Buffer} pixels
 * @param {number} width
 * @param {number} height
 * @param {{ x: number, y: number }} start
 * @param {{ x: number, y: number }} end
 */
function drawMowedPathSegment(pixels, width, height, start, end) {
    const dx = Math.abs(end.x - start.x);
    const sx = start.x < end.x ? 1 : -1;
    const dy = -Math.abs(end.y - start.y);
    const sy = start.y < end.y ? 1 : -1;
    let error = dx + dy;
    let x = start.x;
    let y = start.y;

    while (true) {
        for (let offsetY = -MOWED_PATH_RADIUS; offsetY <= MOWED_PATH_RADIUS; offsetY++) {
            for (let offsetX = -MOWED_PATH_RADIUS; offsetX <= MOWED_PATH_RADIUS; offsetX++) {
                const pixelX = x + offsetX;
                const pixelY = y + offsetY;
                if (pixelX < 0 || pixelX >= width || pixelY < 0 || pixelY >= height) {
                    continue;
                }
                pixels.set(MOWED_PATH_COLOR, (pixelY * width + pixelX) * 4);
            }
        }

        if (x === end.x && y === end.y) {
            break;
        }
        const doubledError = 2 * error;
        if (doubledError >= dy) {
            error += dy;
            x += sx;
        }
        if (doubledError <= dx) {
            error += dx;
            y += sy;
        }
    }
}

/**
 * @param {MapRaster} mapRaster
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
function hasMowedRasterPixel(mapRaster, x, y) {
    const mowedRaster = mapRaster.mowedRaster;
    const naviMap = mapRaster.metadata?.navi_map;
    if (!mowedRaster || !naviMap) {
        return false;
    }

    const sourceY = mapRaster.height - 1 - y;
    const worldX = Number(naviMap.x_min) + x * Number(naviMap.resolution);
    const worldY = Number(naviMap.y_min) + sourceY * Number(naviMap.resolution);
    const mowedX = Math.round((worldX - mowedRaster.xMin) / mowedRaster.resolution);
    const mowedY = Math.round((worldY - mowedRaster.yMin) / mowedRaster.resolution);
    return (
        mowedX >= 0 &&
        mowedX < mowedRaster.width &&
        mowedY >= 0 &&
        mowedY < mowedRaster.height &&
        mowedRaster.pixels[mowedY * mowedRaster.width + mowedX] > 0
    );
}

/**
 * @param {MapRaster|null|undefined} mapRaster
 * @param {{ x: number, y: number, flag?: number }[]|null|undefined} mowedPath
 * @param {boolean} includeRtkMask
 * @param {boolean} includeMowedPath
 * @param {unknown} forbidAreas
 * @returns {string}
 */
function renderMapPng(mapRaster, mowedPath, includeRtkMask, includeMowedPath, forbidAreas) {
    if (!mapRaster || !Buffer.isBuffer(mapRaster.pixels)) {
        return EMPTY_IMAGE;
    }
    const { width, height, pixels } = mapRaster;
    if (
        !asMapDimension(width) ||
        !asMapDimension(height) ||
        width * height > MAX_MAP_PIXELS ||
        pixels.length !== width * height
    ) {
        return EMPTY_IMAGE;
    }

    const rgba = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
        const sourceY = height - y - 1;
        for (let x = 0; x < width; x++) {
            rgba.set(mapPixelColor(pixels[sourceY * width + x]), (y * width + x) * 4);
        }
    }

    if (includeRtkMask && mapRaster.mowedRaster) {
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (hasMowedRasterPixel(mapRaster, x, y)) {
                    rgba.set(MOWED_PATH_COLOR, (y * width + x) * 4);
                }
            }
        }
    }
    if (includeMowedPath) {
        const pathPoints = normalizePathPoints(Array.isArray(mowedPath) ? mowedPath : [])
            .map(point => mapPointToPixel(mapRaster, point))
            .filter(point => point != null);
        for (let index = 1; index < pathPoints.length; index++) {
            drawMowedPathSegment(rgba, width, height, pathPoints[index - 1], pathPoints[index]);
        }
    }
    const forbiddenPolygons = normalizeForbiddenAreas(forbidAreas);
    if ((includeRtkMask || includeMowedPath) && forbiddenPolygons.length) {
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (isForbiddenPixel(mapRaster, x, y, forbiddenPolygons)) {
                    rgba.set(FORBIDDEN_AREA_COLOR, (y * width + x) * 4);
                }
            }
        }
    }

    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 6;
    const scanlines = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) {
        const scanlineOffset = y * (width * 4 + 1);
        scanlines[scanlineOffset] = 0;
        rgba.copy(scanlines, scanlineOffset + 1, y * width * 4, (y + 1) * width * 4);
    }

    const png = Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk('IHDR', header),
        pngChunk('IDAT', zlib.deflateSync(scanlines, { level: 9 })),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
    const dataUri = `data:image/png;base64,${png.toString('base64')}`;
    return dataUri.length <= MAX_DATA_URI_LENGTH ? dataUri : EMPTY_IMAGE;
}

/**
 * Render the mower's native navigation raster with the app's light palette.
 * The source rows are vertically inverted relative to the app coordinate
 * system. No zones, mowing path, or other geometry is added.
 *
 * @param {MapRaster|null|undefined} mapRaster
 * @returns {string}
 */
function renderMapImage(mapRaster) {
    return renderMapPng(mapRaster, null, false, false, []);
}

/**
 * @param {MapRaster|null|undefined} mapRaster
 * @param {unknown} [forbidAreas]
 * @returns {string}
 */
function renderMapImageWithRtkMask(mapRaster, forbidAreas = []) {
    return renderMapPng(mapRaster, null, true, false, forbidAreas);
}

/**
 * @param {MapRaster|null|undefined} mapRaster
 * @param {{ x: number, y: number, flag?: number }[]|null|undefined} mowedPath
 * @param {unknown} [forbidAreas]
 * @returns {string}
 */
function renderMapImageWithMowedPath(mapRaster, mowedPath, forbidAreas = []) {
    return renderMapPng(mapRaster, mowedPath, false, true, forbidAreas);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function pathCacheKey(value) {
    return Array.isArray(value) ? JSON.stringify(value) : '';
}

/**
 * @param {object} context
 * @param {{ mapVersion: string|null, mowedPath?: { x: number, y: number, flag?: number }[], forbidAreas?: unknown }} params
 * @returns {{ mapVersion: string|null, mowedPath: string, forbidAreaKey: string, mapRaster: MapRaster|null, image: string, imageWithRtkMask: string, imageWithMowedPath: string }}
 */
function updateMapImageCache(context, { mapVersion, mowedPath = [], forbidAreas = [] }) {
    const pathPoints = Array.isArray(mowedPath) ? mowedPath : [];
    const pathValue = pathCacheKey(pathPoints);
    const forbidAreaValue = Array.isArray(forbidAreas) ? forbidAreas : [];
    const forbidAreaKey = JSON.stringify(forbidAreaValue);
    const current = context.mapImageCache;
    if (
        current &&
        current.mapVersion === mapVersion &&
        current.mowedPath === pathValue &&
        current.forbidAreaKey === forbidAreaKey &&
        current.mapRaster === context.mapRaster
    ) {
        return current;
    }
    context.mapImageCache = {
        mapVersion,
        mowedPath: pathValue,
        forbidAreaKey,
        mapRaster: context.mapRaster || null,
        image: renderMapImage(context.mapRaster),
        imageWithRtkMask: renderMapImageWithRtkMask(context.mapRaster, forbidAreaValue),
        imageWithMowedPath: renderMapImageWithMowedPath(context.mapRaster, pathPoints, forbidAreaValue),
    };
    return context.mapImageCache;
}

module.exports = {
    extractMapRasterFromArchive,
    parseHistoryPath,
    renderMapImage,
    renderMapImageWithRtkMask,
    renderMapImageWithMowedPath,
    updateMapImageCache,
};
