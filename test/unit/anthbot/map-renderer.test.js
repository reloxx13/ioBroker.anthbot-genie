'use strict';

const assert = require('node:assert/strict');
const zlib = require('node:zlib');

const {
    extractMapRasterFromArchive,
    parseHistoryPath,
    renderMapImage,
    renderMapImageWithRtkMask,
    renderMapImageWithMowedPath,
    updateMapImageCache,
} = require('../../../lib/anthbot/map-renderer');

function tarEntry(name, content) {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write(`00000000000${bytes.length.toString(8)}`.slice(-11), 124, 11, 'ascii');
    header[156] = '0'.charCodeAt(0);
    header.write('ustar', 257, 5, 'ascii');
    const padding = Buffer.alloc((512 - (bytes.length % 512)) % 512);
    return Buffer.concat([header, bytes, padding]);
}

function mowedRasterEntry({ width, height, resolution, xMin, yMin, pixels }) {
    const header = Buffer.alloc(28);
    header.writeUInt32LE(width, 0);
    header.writeUInt32LE(height, 4);
    header.writeFloatLE(resolution, 8);
    header.writeFloatLE(xMin, 12);
    header.writeFloatLE(yMin, 16);
    return Buffer.concat([header, Buffer.from(pixels)]);
}

function mapArchive({
    width = 2,
    height = 2,
    pixels = [0, 255, 128, 160],
    resolution = 0.05,
    xMin = -1.25,
    yMin = -2.5,
    mowedMap = null,
} = {}) {
    const metadata = JSON.stringify({
        navi_map: {
            width,
            height,
            resolution,
            x_min: xMin,
            y_min: yMin,
        },
    });
    return zlib.gzipSync(Buffer.concat([
        tarEntry('maps/remote_map_navi.map', Buffer.from(pixels)),
        tarEntry('maps/remote_map.json', metadata),
        ...(mowedMap ? [tarEntry('maps/rtk_mask_map', mowedMap)] : []),
        Buffer.alloc(1024),
    ]));
}

function mowedPathPayload(points) {
    const payload = Buffer.alloc(22 + points.length * 5);
    payload[0] = 0x16;
    payload[1] = 1;
    payload[2] = 2;
    payload[3] = 5;
    payload.writeUInt32LE(points.length, 4);
    points.forEach(([x, y], index) => {
        const offset = 22 + index * 5;
        payload.writeInt16LE(x, offset);
        payload.writeInt16LE(y, offset + 2);
        payload[offset + 4] = 5;
    });
    return payload.toString('base64');
}

function readRenderedPixels(dataUri) {
    const png = Buffer.from(dataUri.split(',', 2)[1], 'base64');
    const chunks = [];
    let offset = 8;
    while (offset < png.length) {
        const length = png.readUInt32BE(offset);
        const type = png.toString('ascii', offset + 4, offset + 8);
        if (type === 'IDAT') {
            chunks.push(png.subarray(offset + 8, offset + 8 + length));
        }
        offset += 12 + length;
    }

    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    const scanlines = zlib.inflateSync(Buffer.concat(chunks));
    const pixels = [];
    for (let y = 0; y < height; y++) {
        const rowOffset = y * (width * 4 + 1);
        assert.equal(scanlines[rowOffset], 0);
        for (let x = 0; x < width; x++) {
            const pixelOffset = rowOffset + 1 + x * 4;
            pixels.push([...scanlines.subarray(pixelOffset, pixelOffset + 4)]);
        }
    }
    return { width, height, pixels };
}

describe('lib/anthbot/map-renderer', () => {
    it('extracts the native navigation raster from the multi_maps archive', () => {
        assert.deepEqual(extractMapRasterFromArchive(mapArchive()), {
            width: 2,
            height: 2,
            pixels: Buffer.from([0, 255, 128, 160]),
            metadata: {
                navi_map: {
                    width: 2,
                    height: 2,
                    resolution: 0.05,
                    x_min: -1.25,
                    y_min: -2.5,
                },
            },
        });
    });

    it('renders the native raster with the app palette and orientation', () => {
        const mapRaster = extractMapRasterFromArchive(mapArchive());
        const first = renderMapImage(mapRaster);
        const second = renderMapImage(mapRaster);

        assert.match(first, /^data:image\/png;base64,/);
        assert.equal(first, second);
        const rendered = readRenderedPixels(first);
        assert.deepEqual(rendered, {
            width: 2,
            height: 2,
            pixels: [
                [216, 215, 231, 255], [216, 215, 231, 255],
                [236, 236, 246, 255], [214, 216, 231, 255],
            ],
        });
    });

    it('decodes the native path and renders it as a separate blue image', () => {
        const points = [[0, 0], [50, 0]];
        const path = mowedPathPayload(points);
        const parsedPath = parseHistoryPath(Buffer.from(path, 'base64'));
        assert.deepEqual(parsedPath, points.map(([x, y]) => ({ x, y, flag: 5 })));

        const mapRaster = extractMapRasterFromArchive(mapArchive({
            width: 4,
            height: 4,
            pixels: Array(16).fill(0),
            resolution: 0.5,
            xMin: -1,
            yMin: -1,
        }));
        const image = renderMapImageWithMowedPath(mapRaster, parsedPath);
        const rendered = readRenderedPixels(image);

        assert.deepEqual(rendered.pixels[1 * 4 + 2], [108, 120, 232, 255]);
        assert.deepEqual(rendered.pixels[0], [236, 236, 246, 255]);
        assert.notEqual(image, renderMapImage(mapRaster));
    });

    it('parses historical path files as map coordinates', () => {
        assert.deepEqual(parseHistoryPath(Buffer.from('0,0\n10,20\n')), [
            { x: 0, y: 0, flag: 5 },
            { x: 10, y: 20, flag: 5 },
        ]);
        assert.deepEqual(parseHistoryPath(JSON.stringify({ points: [[30, 40], { x: 50, y: 60, flag: 7 }] })), [
            { x: 30, y: 40, flag: 5 },
            { x: 50, y: 60, flag: 7 },
        ]);
    });

    it('renders the rtk mask and historical path as separate images', () => {
        const mowedMapPixels = Array(32).fill(0);
        mowedMapPixels[9] = 255;
        const mowedMap = mowedRasterEntry({
            width: 8,
            height: 4,
            resolution: 0.5,
            xMin: -1,
            yMin: -1,
            pixels: mowedMapPixels,
        });
        const mapRaster = extractMapRasterFromArchive(mapArchive({
            width: 8,
            height: 4,
            pixels: Array(32).fill(0),
            resolution: 0.5,
            xMin: -1,
            yMin: -1,
            mowedMap,
        }));

        const mapOnly = readRenderedPixels(renderMapImage(mapRaster));
        const maskImage = readRenderedPixels(renderMapImageWithRtkMask(mapRaster));
        const rendered = readRenderedPixels(
            renderMapImageWithMowedPath(mapRaster, [
                { x: 200, y: 0, flag: 5 },
                { x: 250, y: 0, flag: 5 },
            ]),
        );
        assert.deepEqual(mapOnly.pixels[2 * 8 + 1], [236, 236, 246, 255]);
        assert.deepEqual(maskImage.pixels[2 * 8 + 1], [108, 120, 232, 255]);
        assert.deepEqual(rendered.pixels[2 * 8 + 1], [236, 236, 246, 255]);
        assert.deepEqual(rendered.pixels[2 * 8 + 2], [236, 236, 246, 255]);
        assert.deepEqual(rendered.pixels[1 * 8 + 6], [108, 120, 232, 255]);

        const forbiddenAreas = [{ vertexs: [[-600, -600], [-400, -600], [-400, -400], [-600, -400]] }];
        const maskWithForbiddenArea = readRenderedPixels(renderMapImageWithRtkMask(mapRaster, forbiddenAreas));
        const pathWithForbiddenArea = readRenderedPixels(
            renderMapImageWithMowedPath(mapRaster, [], forbiddenAreas),
        );
        assert.deepEqual(maskWithForbiddenArea.pixels[2 * 8 + 1], [220, 38, 38, 255]);
        assert.deepEqual(pathWithForbiddenArea.pixels[2 * 8 + 1], [220, 38, 38, 255]);

    });

    it('returns no image for malformed or dimension-mismatched map data', () => {
        assert.equal(renderMapImage(null), '');
        assert.equal(renderMapImage({ width: 2, height: 2, pixels: Buffer.from([0]), metadata: {} }), '');
        assert.equal(extractMapRasterFromArchive(Buffer.from('not a gzip archive')), null);
    });

    it('reuses the image until the native map version or path changes', () => {
        const mapRaster = extractMapRasterFromArchive(mapArchive());
        const path = [{ x: 0, y: 0, flag: 5 }];
        const changedPath = [
            { x: 0, y: 0, flag: 5 },
            { x: 50, y: 0, flag: 5 },
        ];
        const context = { mapRaster };
        const first = updateMapImageCache(context, { mapVersion: '20260523221453', mowedPath: path });
        const same = updateMapImageCache(context, { mapVersion: '20260523221453', mowedPath: path });
        const changed = updateMapImageCache(context, { mapVersion: '20260523221453', mowedPath: changedPath });

        assert.strictEqual(same, first);
        assert.notStrictEqual(changed, first);
        assert.equal(changed.mowedPath, JSON.stringify(changedPath));
    });
});
