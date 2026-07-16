'use strict';

const fs = require('node:fs');
const path = require('node:path');
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
const ROBOT_ICON_OUTLINE = [31, 41, 55, 255];
const ROBOT_ICON_BODY = [250, 204, 21, 255];
const ROBOT_ICON_DETAIL = [59, 130, 246, 255];
const MOWED_PATH_HEADER_LENGTH = 22;
const MOWED_PATH_RECORD_LENGTH = 5;
const MOWED_PATH_RADIUS = 1;
const ROBOT_ICON_RADIUS = 4;
const ROBOT_ICON_MAX_HEIGHT = 36;
const ROBOT_ICON_YAW_OFFSET = -90;
const CHARGER_ICON_ASSET_NAME = 'view_map_battery_position.png';
const CHARGER_ICON_MAX_HEIGHT = 24;
const MAX_HISTORY_POINTS = 100000;
const ROBOT_ICON_ASSET_DIR = path.join(__dirname, 'assets');
const robotIconCache = new Map();
let chargerIconCache;

/**
 * @typedef {{ width: number, height: number, pixels: Buffer, metadata: object, mowedRaster?: MowedRaster }} MapRaster
 */

/**
 * @typedef {{ width: number, height: number, resolution: number, xMin: number, yMin: number, pixels: Buffer }} MowedRaster
 */

/**
 * @typedef {{ x: number, y: number, yaw?: number }} MowerPose
 */

/**
 * @typedef {{ width: number, height: number, pixels: Buffer }} RgbaImage
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
 * @param {string|null|undefined} deviceModel
 * @returns {string|null}
 */
function getRobotIconAssetName(deviceModel) {
    const model = typeof deviceModel === 'string' ? deviceModel.toLowerCase() : '';
    if (/\bm9(?:pro)?\b/.test(model)) {
        return 'icon_device_map_m9pro.png';
    }
    if (/\bm5\b/.test(model) || /\bs2\b.*\brtk\b/.test(model)) {
        return 'icon_device_map_s2_rtk.png';
    }
    if (/\bs2\b/.test(model)) {
        return 'icon_device_map_s2.png';
    }
    if (/\bs3\b.*\brtk\b/.test(model)) {
        return 'icon_device_map_s3_rtk.png';
    }
    if (/\bs3\b/.test(model)) {
        return 'icon_device_map_s3.png';
    }
    if (model.includes('genie')) {
        return 'pic_device_map_genie.png';
    }
    return null;
}

/**
 * @param {Buffer} value
 * @returns {RgbaImage}
 */
function decodeRgbaPng(value) {
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    if (!Buffer.isBuffer(value) || value.length < signature.length || !value.subarray(0, 8).equals(signature)) {
        throw new Error('Invalid robot icon PNG');
    }

    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    let interlaceMethod = 0;
    const compressedRows = [];
    let offset = signature.length;
    while (offset + 12 <= value.length) {
        const length = value.readUInt32BE(offset);
        const chunkStart = offset + 8;
        const chunkEnd = chunkStart + length;
        if (chunkEnd + 4 > value.length) {
            throw new Error('Truncated robot icon PNG');
        }
        const type = value.toString('ascii', offset + 4, offset + 8);
        const data = value.subarray(chunkStart, chunkEnd);
        if (type === 'IHDR') {
            if (data.length !== 13) {
                throw new Error('Invalid robot icon PNG header');
            }
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            bitDepth = data[8];
            colorType = data[9];
            interlaceMethod = data[12];
        } else if (type === 'IDAT') {
            compressedRows.push(data);
        } else if (type === 'IEND') {
            break;
        }
        offset = chunkEnd + 4;
    }

    if (
        !asMapDimension(width) ||
        !asMapDimension(height) ||
        width * height > 1024 * 1024 ||
        bitDepth !== 8 ||
        colorType !== 6 ||
        interlaceMethod !== 0 ||
        compressedRows.length === 0
    ) {
        throw new Error('Unsupported robot icon PNG format');
    }

    const rowBytes = width * 4;
    const inflated = zlib.inflateSync(Buffer.concat(compressedRows));
    if (inflated.length !== (rowBytes + 1) * height) {
        throw new Error('Invalid robot icon PNG pixel data');
    }

    const pixels = Buffer.alloc(rowBytes * height);
    let previousRow = Buffer.alloc(rowBytes);
    for (let y = 0; y < height; y++) {
        const rowOffset = y * (rowBytes + 1);
        const filter = inflated[rowOffset];
        const sourceRow = inflated.subarray(rowOffset + 1, rowOffset + 1 + rowBytes);
        const currentRow = Buffer.alloc(rowBytes);
        for (let index = 0; index < rowBytes; index++) {
            const left = index >= 4 ? currentRow[index - 4] : 0;
            const above = previousRow[index];
            const upperLeft = index >= 4 ? previousRow[index - 4] : 0;
            let predictor = 0;
            if (filter === 1) {
                predictor = left;
            } else if (filter === 2) {
                predictor = above;
            } else if (filter === 3) {
                predictor = Math.floor((left + above) / 2);
            } else if (filter === 4) {
                predictor = paethPredictor(left, above, upperLeft);
            } else if (filter !== 0) {
                throw new Error('Unsupported robot icon PNG filter');
            }
            currentRow[index] = (sourceRow[index] + predictor) & 0xff;
        }
        currentRow.copy(pixels, y * rowBytes);
        previousRow = currentRow;
    }
    return { width, height, pixels };
}

/**
 * @param {number} left
 * @param {number} above
 * @param {number} upperLeft
 * @returns {number}
 */
function paethPredictor(left, above, upperLeft) {
    const estimate = left + above - upperLeft;
    const leftDistance = Math.abs(estimate - left);
    const aboveDistance = Math.abs(estimate - above);
    const upperLeftDistance = Math.abs(estimate - upperLeft);
    if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) {
        return left;
    }
    return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

/**
 * @param {RgbaImage} image
 * @param {number} maxHeight
 * @returns {RgbaImage}
 */
function resizeRgbaImage(image, maxHeight) {
    const scale = Math.min(1, maxHeight / image.height);
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    if (width === image.width && height === image.height) {
        return image;
    }

    const pixels = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
        const sourceY = Math.min(image.height - 1, Math.floor((y * image.height) / height));
        for (let x = 0; x < width; x++) {
            const sourceX = Math.min(image.width - 1, Math.floor((x * image.width) / width));
            const sourceOffset = (sourceY * image.width + sourceX) * 4;
            pixels.set(image.pixels.subarray(sourceOffset, sourceOffset + 4), (y * width + x) * 4);
        }
    }
    return { width, height, pixels };
}

/**
 * Rotate an RGBA image around its centre using the PNG coordinate convention
 * used by the map: a negative image rotation turns a front-down icon towards the right.
 *
 * @param {RgbaImage} image
 * @param {number} degrees
 * @returns {RgbaImage}
 */
function rotateRgbaImage(image, degrees) {
    if (!Number.isFinite(degrees)) {
        return image;
    }
    const normalizedDegrees = ((degrees % 360) + 360) % 360;
    if (normalizedDegrees === 0) {
        return image;
    }

    const radians = (degrees * Math.PI) / 180;
    const rawCosine = Math.cos(radians);
    const rawSine = Math.sin(radians);
    const cosine = Math.abs(rawCosine) < 1e-12 ? 0 : rawCosine;
    const sine = Math.abs(rawSine) < 1e-12 ? 0 : rawSine;
    const width = Math.max(1, Math.ceil(image.width * Math.abs(cosine) + image.height * Math.abs(sine)));
    const height = Math.max(1, Math.ceil(image.width * Math.abs(sine) + image.height * Math.abs(cosine)));
    const pixels = Buffer.alloc(width * height * 4);
    const sourceCenterX = (image.width - 1) / 2;
    const sourceCenterY = (image.height - 1) / 2;
    const targetCenterX = (width - 1) / 2;
    const targetCenterY = (height - 1) / 2;

    for (let targetY = 0; targetY < height; targetY++) {
        for (let targetX = 0; targetX < width; targetX++) {
            const targetOffsetX = targetX - targetCenterX;
            const targetOffsetY = targetY - targetCenterY;
            const sourceX = Math.round(sourceCenterX + targetOffsetX * cosine + targetOffsetY * sine);
            const sourceY = Math.round(sourceCenterY - targetOffsetX * sine + targetOffsetY * cosine);
            if (sourceX < 0 || sourceX >= image.width || sourceY < 0 || sourceY >= image.height) {
                continue;
            }
            const sourceOffset = (sourceY * image.width + sourceX) * 4;
            pixels.set(image.pixels.subarray(sourceOffset, sourceOffset + 4), (targetY * width + targetX) * 4);
        }
    }
    return { width, height, pixels };
}

/**
 * Convert the mower's yaw convention to the bundled front-down icon
 * convention. A missing yaw keeps the asset in its original orientation.
 *
 * @param {number|undefined} yaw
 * @returns {number}
 */
function robotIconRotation(yaw) {
    return Number.isFinite(yaw) ? yaw + ROBOT_ICON_YAW_OFFSET : 0;
}

/**
 * @param {string|null|undefined} deviceModel
 * @returns {RgbaImage|null}
 */
function loadRobotIconAsset(deviceModel) {
    const assetName = getRobotIconAssetName(deviceModel);
    if (!assetName) {
        return null;
    }
    if (robotIconCache.has(assetName)) {
        return robotIconCache.get(assetName) || null;
    }

    try {
        const asset = decodeRgbaPng(fs.readFileSync(path.join(ROBOT_ICON_ASSET_DIR, assetName)));
        const resized = resizeRgbaImage(asset, ROBOT_ICON_MAX_HEIGHT);
        robotIconCache.set(assetName, resized);
        return resized;
    } catch {
        robotIconCache.set(assetName, null);
        return null;
    }
}

/**
 * @param {string|null|undefined} deviceModel
 * @returns {boolean}
 */
function hasRobotIconAsset(deviceModel) {
    return loadRobotIconAsset(deviceModel) != null;
}

/**
 * @returns {RgbaImage|null}
 */
function loadChargerIconAsset() {
    if (chargerIconCache !== undefined) {
        return chargerIconCache;
    }

    try {
        const asset = decodeRgbaPng(fs.readFileSync(path.join(ROBOT_ICON_ASSET_DIR, CHARGER_ICON_ASSET_NAME)));
        chargerIconCache = resizeRgbaImage(asset, CHARGER_ICON_MAX_HEIGHT);
    } catch {
        chargerIconCache = null;
    }
    return chargerIconCache;
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
    return mapWorldPointToPixel(mapRaster, { x: point.x / 100, y: point.y / 100 });
}

/**
 * @param {MapRaster} mapRaster
 * @param {{ x: number, y: number }} point
 * @returns {{ x: number, y: number }|null}
 */
function mapWorldPointToPixel(mapRaster, point) {
    const naviMap = mapRaster.metadata?.navi_map;
    const resolution = Number(naviMap?.resolution);
    const xMin = Number(naviMap?.x_min);
    const yMin = Number(naviMap?.y_min);
    if (!Number.isFinite(resolution) || resolution <= 0 || !Number.isFinite(xMin) || !Number.isFinite(yMin)) {
        return null;
    }

    return {
        x: Math.round((point.x - xMin) / resolution),
        y: mapRaster.height - 1 - Math.round((point.y - yMin) / resolution),
    };
}

/**
 * @param {MapRaster} mapRaster
 * @param {MowerPose} pose
 * @returns {{ x: number, y: number }|null}
 */
function mapPoseToPixel(mapRaster, pose) {
    if (!pose || !Number.isFinite(pose.x) || !Number.isFinite(pose.y)) {
        return null;
    }
    return mapWorldPointToPixel(mapRaster, pose);
}

/**
 * The map metadata reports charger_point coordinates in millimetres, like the
 * mower pose payload. They use the same local map coordinate system.
 *
 * @param {MapRaster} mapRaster
 * @returns {{ x: number, y: number }|null}
 */
function mapChargerPointToPixel(mapRaster) {
    const chargerPoint = mapRaster.metadata?.charger_point;
    if (!chargerPoint || typeof chargerPoint !== 'object') {
        return null;
    }
    const record = /** @type {Record<string, unknown>} */ (chargerPoint);
    const x = Number(record.x);
    const y = Number(record.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return null;
    }
    return mapWorldPointToPixel(mapRaster, { x: x / 1000, y: y / 1000 });
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
 * @param {Buffer} pixels
 * @param {number} width
 * @param {number} height
 * @param {number} x
 * @param {number} y
 * @param {number[]} color
 */
function setPixel(pixels, width, height, x, y, color) {
    if (x < 0 || x >= width || y < 0 || y >= height) {
        return;
    }
    pixels.set(color, (y * width + x) * 4);
}

/**
 * @param {Buffer} pixels
 * @param {number} width
 * @param {number} height
 * @param {{ x: number, y: number }} center
 * @param {number} radius
 * @param {number[]} color
 */
function drawFilledCircle(pixels, width, height, center, radius, color) {
    for (let y = -radius; y <= radius; y++) {
        for (let x = -radius; x <= radius; x++) {
            if (x * x + y * y <= radius * radius) {
                setPixel(pixels, width, height, center.x + x, center.y + y, color);
            }
        }
    }
}

/**
 * @param {Buffer} pixels
 * @param {number} width
 * @param {number} height
 * @param {{ x: number, y: number }} start
 * @param {{ x: number, y: number }} end
 * @param {number[]} color
 */
function drawColoredLine(pixels, width, height, start, end, color) {
    const dx = Math.abs(end.x - start.x);
    const sx = start.x < end.x ? 1 : -1;
    const dy = -Math.abs(end.y - start.y);
    const sy = start.y < end.y ? 1 : -1;
    let error = dx + dy;
    let x = start.x;
    let y = start.y;

    while (true) {
        setPixel(pixels, width, height, x, y, color);
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
 * Draw the charging-station marker reported by the native map metadata.
 *
 * @param {Buffer} pixels
 * @param {number} width
 * @param {number} height
 * @param {MapRaster} mapRaster
 */
function drawChargerIcon(pixels, width, height, mapRaster) {
    const center = mapChargerPointToPixel(mapRaster);
    const chargerIcon = loadChargerIconAsset();
    if (!center || !chargerIcon) {
        return;
    }
    drawRgbaImageCentered(pixels, width, height, chargerIcon, center);
}

/**
 * Draw a compact robot marker on top of the historical path image.
 * The pose is already expressed in map metres; yaw rotates the marker while
 * the marker remains centred on x/y.
 *
 * @param {Buffer} pixels
 * @param {number} width
 * @param {number} height
 * @param {MapRaster} mapRaster
 * @param {MowerPose|null|undefined} pose
 * @param {string|null|undefined} deviceModel
 */
function drawRobotIcon(pixels, width, height, mapRaster, pose, deviceModel) {
    const center = pose ? mapPoseToPixel(mapRaster, pose) : null;
    if (!center) {
        return;
    }

    const appIcon = loadRobotIconAsset(deviceModel);
    if (appIcon) {
        drawRgbaImageCentered(pixels, width, height, rotateRgbaImage(appIcon, robotIconRotation(pose?.yaw)), center);
        return;
    }

    drawFallbackRobotIcon(pixels, width, height, center, pose);
}

/**
 * @param {Buffer} pixels
 * @param {number} width
 * @param {number} height
 * @param {RgbaImage} image
 * @param {{ x: number, y: number }} center
 */
function drawRgbaImageCentered(pixels, width, height, image, center) {
    const left = center.x - Math.floor(image.width / 2);
    const top = center.y - Math.floor(image.height / 2);
    for (let y = 0; y < image.height; y++) {
        for (let x = 0; x < image.width; x++) {
            const sourceOffset = (y * image.width + x) * 4;
            const alpha = image.pixels[sourceOffset + 3];
            if (alpha === 0) {
                continue;
            }
            const targetX = left + x;
            const targetY = top + y;
            if (targetX < 0 || targetX >= width || targetY < 0 || targetY >= height) {
                continue;
            }
            const targetOffset = (targetY * width + targetX) * 4;
            if (alpha === 255) {
                pixels.set(image.pixels.subarray(sourceOffset, sourceOffset + 4), targetOffset);
                continue;
            }
            const inverseAlpha = 255 - alpha;
            for (let channel = 0; channel < 3; channel++) {
                pixels[targetOffset + channel] = Math.round(
                    (image.pixels[sourceOffset + channel] * alpha + pixels[targetOffset + channel] * inverseAlpha) /
                        255,
                );
            }
            pixels[targetOffset + 3] = Math.min(
                255,
                alpha + Math.round((pixels[targetOffset + 3] * inverseAlpha) / 255),
            );
        }
    }
}

/**
 * @param {Buffer} pixels
 * @param {number} width
 * @param {number} height
 * @param {{ x: number, y: number }} center
 * @param {MowerPose} pose
 */
function drawFallbackRobotIcon(pixels, width, height, center, pose) {
    drawFilledCircle(pixels, width, height, center, ROBOT_ICON_RADIUS, ROBOT_ICON_OUTLINE);
    drawFilledCircle(pixels, width, height, center, ROBOT_ICON_RADIUS - 1, ROBOT_ICON_BODY);

    const yaw = (robotIconRotation(pose?.yaw) * Math.PI) / 180;
    const rotate = (x, y) => ({
        x: center.x + Math.round(x * Math.cos(yaw) - y * Math.sin(yaw)),
        y: center.y + Math.round(x * Math.sin(yaw) + y * Math.cos(yaw)),
    });
    const antennaStart = rotate(0, ROBOT_ICON_RADIUS - 1);
    const antennaEnd = rotate(0, ROBOT_ICON_RADIUS + 2);
    drawColoredLine(pixels, width, height, antennaStart, antennaEnd, ROBOT_ICON_OUTLINE);
    drawFilledCircle(pixels, width, height, antennaEnd, 1, ROBOT_ICON_DETAIL);
    drawFilledCircle(pixels, width, height, rotate(-2, 1), 1, ROBOT_ICON_OUTLINE);
    drawFilledCircle(pixels, width, height, rotate(2, 1), 1, ROBOT_ICON_OUTLINE);
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
 * @param {MowerPose|null|undefined} mowerPose
 * @param {string|null|undefined} deviceModel
 * @returns {string}
 */
function renderMapPng(
    mapRaster,
    mowedPath,
    includeRtkMask,
    includeMowedPath,
    forbidAreas,
    mowerPose = null,
    deviceModel = null,
) {
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
    if (includeMowedPath) {
        drawChargerIcon(rgba, width, height, mapRaster);
        drawRobotIcon(rgba, width, height, mapRaster, mowerPose, deviceModel);
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
 * @param {MowerPose|null|undefined} [mowerPose]
 * @param {string|null|undefined} [deviceModel]
 * @returns {string}
 */
function renderMapImageWithMowedPath(mapRaster, mowedPath, forbidAreas = [], mowerPose, deviceModel) {
    return renderMapPng(mapRaster, mowedPath, false, true, forbidAreas, mowerPose, deviceModel);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function pathCacheKey(value) {
    return Array.isArray(value) ? JSON.stringify(value) : '';
}

/**
 * @param {MowerPose|null|undefined} value
 * @returns {string}
 */
function poseCacheKey(value) {
    if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y)) {
        return '';
    }
    return JSON.stringify({
        x: value.x,
        y: value.y,
        yaw: Number.isFinite(value.yaw) ? value.yaw : null,
    });
}

/**
 * @param {object} context
 * @param {{ mapVersion: string|null, mowedPath?: { x: number, y: number, flag?: number }[], includeMowedPath?: boolean, forbidAreas?: unknown, mowerPose?: MowerPose|null, deviceModel?: string|null }} params
 * @returns {{ mapVersion: string|null, mowedPath: string, includeMowedPath: boolean, mowerPose: string, deviceModel: string, forbidAreaKey: string, mapRaster: MapRaster|null, image: string, imageWithRtkMask: string, imageWithMowedPath: string }}
 */
function updateMapImageCache(
    context,
    { mapVersion, mowedPath = [], includeMowedPath = true, forbidAreas = [], mowerPose = null, deviceModel = null },
) {
    const pathPoints = includeMowedPath && Array.isArray(mowedPath) ? mowedPath : [];
    const pathValue = includeMowedPath ? pathCacheKey(pathPoints) : '';
    const mowerPoseValue = includeMowedPath ? poseCacheKey(mowerPose) : '';
    const deviceModelValue = includeMowedPath && typeof deviceModel === 'string' ? deviceModel : '';
    const forbidAreaValue = Array.isArray(forbidAreas) ? forbidAreas : [];
    const forbidAreaKey = JSON.stringify(forbidAreaValue);
    const current = context.mapImageCache;
    if (
        current &&
        current.mapVersion === mapVersion &&
        current.mowedPath === pathValue &&
        current.includeMowedPath === includeMowedPath &&
        current.mowerPose === mowerPoseValue &&
        current.deviceModel === deviceModelValue &&
        current.forbidAreaKey === forbidAreaKey &&
        current.mapRaster === context.mapRaster
    ) {
        return current;
    }
    context.mapImageCache = {
        mapVersion,
        mowedPath: pathValue,
        includeMowedPath,
        mowerPose: mowerPoseValue,
        deviceModel: deviceModelValue,
        forbidAreaKey,
        mapRaster: context.mapRaster || null,
        image: renderMapImage(context.mapRaster),
        imageWithRtkMask: renderMapImageWithRtkMask(context.mapRaster, forbidAreaValue),
        imageWithMowedPath: includeMowedPath
            ? renderMapImageWithMowedPath(context.mapRaster, pathPoints, forbidAreaValue, mowerPose, deviceModel)
            : '',
    };
    return context.mapImageCache;
}

module.exports = {
    extractMapRasterFromArchive,
    getRobotIconAssetName,
    hasRobotIconAsset,
    parseHistoryPath,
    renderMapImage,
    renderMapImageWithRtkMask,
    renderMapImageWithMowedPath,
    robotIconRotation,
    rotateRgbaImage,
    updateMapImageCache,
};
