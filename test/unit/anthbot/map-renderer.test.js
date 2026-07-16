'use strict';

const assert = require('node:assert/strict');
const zlib = require('node:zlib');

const {
    extractMapRasterFromArchive,
    parseHistoryPath,
    renderMapImage,
    renderMapImageWithRtkMask,
    renderMapImageWithMowedPath,
    getRobotIconAssetName,
    hasRobotIconAsset,
    robotIconRotation,
    rotateRgbaImage,
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
    chargerPoint = null,
} = {}) {
    const metadata = JSON.stringify({
        navi_map: {
            width,
            height,
            resolution,
            x_min: xMin,
            y_min: yMin,
        },
        ...(chargerPoint ? { charger_point: chargerPoint } : {}),
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

function nonBackgroundBounds(rendered) {
    const background = [236, 236, 246, 255];
    const points = [];
    rendered.pixels.forEach((pixel, index) => {
        if (!pixel.every((value, channel) => value === background[channel])) {
            points.push({ x: index % rendered.width, y: Math.floor(index / rendered.width) });
        }
    });
    assert.notEqual(points.length, 0);
    return {
        width: Math.max(...points.map(point => point.x)) - Math.min(...points.map(point => point.x)) + 1,
        height: Math.max(...points.map(point => point.y)) - Math.min(...points.map(point => point.y)) + 1,
    };
}

describe('lib/anthbot/map-renderer', () => {
    it('selects bundled app map icons by mower model and falls back for unknown models', () => {
        assert.equal(getRobotIconAssetName('Anthbot Genie 600'), 'pic_device_map_genie.png');
        assert.equal(getRobotIconAssetName('Anthbot M5'), 'icon_device_map_s2_rtk.png');
        assert.equal(getRobotIconAssetName('Anthbot M9'), 'icon_device_map_m9pro.png');
        assert.equal(getRobotIconAssetName('Anthbot S2'), 'icon_device_map_s2.png');
        assert.equal(getRobotIconAssetName('Anthbot S3'), 'icon_device_map_s3.png');
        assert.equal(getRobotIconAssetName('Anthbot S3 RTK'), 'icon_device_map_s3_rtk.png');
        assert.equal(getRobotIconAssetName('Unknown mower'), null);
        assert.equal(hasRobotIconAsset('Anthbot Genie 600'), true);
        assert.equal(hasRobotIconAsset('Unknown mower'), false);
    });

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

    it('renders a robot icon at the mower pose in the historical path image', () => {
        const mapRaster = extractMapRasterFromArchive(mapArchive({
            width: 4,
            height: 4,
            pixels: Array(16).fill(0),
            resolution: 0.5,
            xMin: -1,
            yMin: -1,
        }));

        const image = renderMapImageWithMowedPath(mapRaster, [], [], { x: 0, y: 0, yaw: 0 });
        const rendered = readRenderedPixels(image);

        assert.deepEqual(rendered.pixels[1 * 4 + 2], [250, 204, 21, 255]);
    });

    it('uses the bundled Genie map icon before the generated fallback icon', () => {
        const mapRaster = extractMapRasterFromArchive(mapArchive({
            width: 4,
            height: 4,
            pixels: Array(16).fill(0),
            resolution: 0.5,
            xMin: -1,
            yMin: -1,
        }));
        const pose = { x: 0, y: 0, yaw: 0 };
        const appImage = readRenderedPixels(renderMapImageWithMowedPath(mapRaster, [], [], pose, 'Anthbot Genie 600'));
        const fallbackImage = readRenderedPixels(renderMapImageWithMowedPath(mapRaster, [], [], pose, 'Unknown mower'));

        assert.notDeepEqual(appImage.pixels[1 * 4 + 2], [250, 204, 21, 255]);
        assert.notDeepEqual(appImage.pixels, fallbackImage.pixels);
    });

    it('rotates a front-down icon clockwise for a negative image rotation', () => {
        const pixels = Buffer.alloc(3 * 5 * 4);
        pixels.set([255, 0, 0, 255], (4 * 3 + 1) * 4);

        const rotated = rotateRgbaImage({ width: 3, height: 5, pixels }, -90);

        assert.equal(rotated.width, 5);
        assert.equal(rotated.height, 3);
        assert.deepEqual([...rotated.pixels.subarray((1 * 5 + 4) * 4, (1 * 5 + 4) * 4 + 4)], [255, 0, 0, 255]);
    });

    it('maps the mower yaw convention to the front-down asset convention', () => {
        assert.equal(robotIconRotation(-16), -106);
        assert.equal(robotIconRotation(90), 0);
        assert.equal(robotIconRotation(undefined), 0);
    });

    it('rotates the bundled map icon with the mower pose', () => {
        const mapRaster = extractMapRasterFromArchive(mapArchive({
            width: 120,
            height: 120,
            pixels: Array(120 * 120).fill(0),
            resolution: 0.1,
            xMin: -6,
            yMin: -6,
        }));

        const frontDown = nonBackgroundBounds(
            readRenderedPixels(renderMapImageWithMowedPath(mapRaster, [], [], { x: 0, y: 0, yaw: 90 }, 'Anthbot Genie 600')),
        );
        const frontRight = nonBackgroundBounds(
            readRenderedPixels(
                renderMapImageWithMowedPath(mapRaster, [], [], { x: 0, y: 0, yaw: -16 }, 'Anthbot Genie 600'),
            ),
        );

        assert.ok(frontDown.height > frontDown.width);
        assert.ok(frontDown.height <= 36);
        assert.ok(frontRight.width > frontRight.height);
    });

    it('keeps the generated fallback front aligned with the bundled icons', () => {
        const mapRaster = extractMapRasterFromArchive(mapArchive({
            width: 40,
            height: 40,
            pixels: Array(40 * 40).fill(0),
            resolution: 0.1,
            xMin: -2,
            yMin: -2,
        }));
        const centerX = 20;
        const centerY = 19;
        const detail = [59, 130, 246, 255];
        const frontDown = readRenderedPixels(
            renderMapImageWithMowedPath(mapRaster, [], [], { x: 0, y: 0, yaw: 90 }, 'Unknown mower'),
        );
        const frontRight = readRenderedPixels(
            renderMapImageWithMowedPath(mapRaster, [], [], { x: 0, y: 0, yaw: -16 }, 'Unknown mower'),
        );

        assert.deepEqual(frontDown.pixels[(centerY + 6) * 40 + centerX], detail);
        assert.deepEqual(frontRight.pixels[(centerY - 2) * 40 + centerX + 6], detail);
    });

    it('renders the charger marker from remote map metadata below the mower', () => {
        const mapRaster = extractMapRasterFromArchive(mapArchive({
            width: 40,
            height: 40,
            pixels: Array(40 * 40).fill(0),
            resolution: 0.1,
            xMin: -2,
            yMin: -2,
            chargerPoint: { x: 0, y: -1000, phi: 2, type: 83 },
        }));
        const withoutCharger = extractMapRasterFromArchive(mapArchive({
            width: 40,
            height: 40,
            pixels: Array(40 * 40).fill(0),
            resolution: 0.1,
            xMin: -2,
            yMin: -2,
        }));
        const pose = { x: 0, y: 0, yaw: 90 };
        const rendered = readRenderedPixels(renderMapImageWithMowedPath(mapRaster, [], [], pose, 'Unknown mower'));
        const baseline = readRenderedPixels(
            renderMapImageWithMowedPath(withoutCharger, [], [], pose, 'Unknown mower'),
        );

        assert.notDeepEqual(rendered.pixels[29 * 40 + 20], baseline.pixels[29 * 40 + 20]);
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

        const withPose = updateMapImageCache(context, {
            mapVersion: '20260523221453',
            mowedPath: changedPath,
            mowerPose: { x: 0, y: 0, yaw: 0 },
        });
        const movedPose = updateMapImageCache(context, {
            mapVersion: '20260523221453',
            mowedPath: changedPath,
            mowerPose: { x: 0.5, y: 0, yaw: 0 },
        });
        assert.notStrictEqual(movedPose, withPose);
        assert.equal(movedPose.mowerPose, JSON.stringify({ x: 0.5, y: 0, yaw: 0 }));

        const withoutPath = updateMapImageCache(context, {
            mapVersion: '20260523221453',
            mowedPath: changedPath,
            includeMowedPath: false,
        });
        assert.equal(withoutPath.imageWithMowedPath, '');
    });
});
