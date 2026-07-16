'use strict';

const {
    activeManualZoneIds,
    autoZones,
    batteryLevel,
    compactZonePayload,
    consumableLifetimes,
    errorCode,
    errorDescription,
    generalMowerStatus,
    ipAddress,
    isCharging,
    isCustomDirectionEnabled,
    manualZones,
    mapArea,
    mappingTaskState,
    nearChargerMowingSettings,
    rawModeStatus,
    rawRobotStatus,
    rtkBaseStateLabel,
    rtkStateLabel,
    simCcid,
    simPresent,
    totalMowingArea,
    totalMowingTime,
    wifiSsid,
} = require('../anthbot/payload');
const { asInteger, asIsoTimestamp, coerceEnabledValue, isNonZero, safeGet } = require('../anthbot/utils');

/**
 * @param {unknown} value
 * @returns {string}
 */
function asText(value) {
    return value == null ? '' : String(value);
}

/**
 * @param {{
 * context: object,
 * data: object,
 * eventCodeCache: object|null,
 * errorDescriptionLanguage: string,
 * now: Date,
 * }} params
 * @returns {Record<string, ioBroker.StateValue>}
 */
function buildDeviceStateUpdates({ context, data, eventCodeCache, errorDescriptionLanguage, now }) {
    const manualZoneList = manualZones(data);
    const autoZoneList = autoZones(data);
    const cutterHeight =
        typeof data?.param_set?.cutter_height === 'number'
            ? data.param_set.cutter_height
            : typeof data?.mow_remote?.cutter_height === 'number'
              ? data.mow_remote.cutter_height
              : null;
    const mowingTime = typeof data?.mowing_time_new?.value === 'number' ? data.mowing_time_new.value : null;
    const mowingArea = typeof data?.mowing_area_new?.value === 'number' ? data.mowing_area_new.value : null;
    const customDirection = typeof data?.param_set?.mow_head === 'number' ? data.param_set.mow_head : null;
    const rainContinueTime = typeof data.rain_continue_time === 'number' ? data.rain_continue_time : null;
    const rainPerceptionEnabled = coerceEnabledValue(data.rain_switch);
    const nearChargerMowingEnabled = coerceEnabledValue(
        data?.nest_switch !== undefined ? data.nest_switch : safeGet(data, 'param_set', 'nest_switch'),
    );
    const nearChargerSettings = nearChargerMowingSettings(data);
    const pointMow = data?.mow_point && typeof data.mow_point === 'object' ? data.mow_point : {};
    const rtkAntennaMoved = coerceEnabledValue(data?.rtk_move_sta?.value);
    const serviceCommand = typeof data?._service_reported?.cmd === 'string' ? data._service_reported.cmd : '';
    const pose = data?.pose && typeof data.pose === 'object' ? data.pose : {};
    const consumables = consumableLifetimes(data);
    const mapImages = context.mapImageCache || {};

    return {
        'info.alias': context.device.alias,
        'info.model': context.device.model,
        'info.region': context.region.regionName,
        'info.endpoint': context.shadowClient.iotEndpoint,
        'info.online': coerceEnabledValue(data.online),
        'info.charging': isCharging(data),
        'info.lastServiceCommand': serviceCommand,
        'info.lastPoll': now.toISOString(),

        'map.image': asText(mapImages.image),
        'map.imageWithRtkMask': asText(mapImages.imageWithRtkMask),
        'map.imageWithMowedPath': asText(mapImages.imageWithMowedPath),

        'consumable.chargingPort.life': consumables.chargingPort,
        'consumable.cameras.life': consumables.cameras,
        'consumable.blades.life': consumables.blades,

        'metrics.batteryLevel': batteryLevel(data),
        'metrics.status.mower': generalMowerStatus(data),
        'metrics.status.robotRaw': rawRobotStatus(data) || '',
        'metrics.status.modeRaw': rawModeStatus(data) || '',
        'metrics.mowing.time': mowingTime,
        'metrics.mowing.area': mowingArea,
        'metrics.mowing.totalTime': totalMowingTime(data),
        'metrics.mowing.totalArea': totalMowingArea(data),
        'metrics.mowing.borderActive': isNonZero(safeGet(data, 'mow_border', 'value')),
        'metrics.mowing.nearChargerActive': isNonZero(safeGet(data, 'mow_nest', 'value')),
        'metrics.mowing.fullYardActive': coerceEnabledValue(data.mow_full),
        'metrics.pointMowing.active': coerceEnabledValue(pointMow.sta),
        'metrics.pointMowing.x': typeof pointMow.x === 'number' ? pointMow.x : null,
        'metrics.pointMowing.y': typeof pointMow.y === 'number' ? pointMow.y : null,
        'metrics.zones.manualCount': manualZoneList.length,
        'metrics.zones.autoCount': autoZoneList.length,
        'metrics.map.totalArea': mapArea(data),
        'metrics.map.status': asText(safeGet(data, 'map_sta', 'value')),
        'metrics.map.mappingTaskState': mappingTaskState(data) || '',
        'metrics.error.code': errorCode(data),
        'metrics.error.description': asText(
            errorDescription(data, eventCodeCache, errorDescriptionLanguage || 'English'),
        ),
        'metrics.error.active': isNonZero(errorCode(data)),

        'location.gps.latitude':
            typeof safeGet(data, 'anti_loss_pose', 'posegps', 'lat') === 'number'
                ? safeGet(data, 'anti_loss_pose', 'posegps', 'lat')
                : null,
        'location.gps.longitude':
            typeof safeGet(data, 'anti_loss_pose', 'posegps', 'lon') === 'number'
                ? safeGet(data, 'anti_loss_pose', 'posegps', 'lon')
                : null,
        'location.pose.x': typeof pose.x === 'number' ? pose.x : null,
        'location.pose.y': typeof pose.y === 'number' ? pose.y : null,
        'location.pose.yaw': typeof pose.yaw === 'number' ? pose.yaw : null,
        'location.pose.type': asText(safeGet(data, 'anti_loss_pose', 'pose_type')),

        'diagnostics.rtk.state': asText(rtkStateLabel(data)),
        'diagnostics.rtk.baseState': asText(rtkBaseStateLabel(data)),
        'diagnostics.rtk.antennaMoved': rtkAntennaMoved,
        'diagnostics.rtk.baseFirmware': asText(safeGet(data, 'fw_version', 'rtk_base')),
        'diagnostics.cameraError': isNonZero(safeGet(data, 'camera_error_sta', 'value')),
        'diagnostics.network.wifiConnected': coerceEnabledValue(data.wifi_state),
        'diagnostics.network.cellularConnected': coerceEnabledValue(data['4g_state']),
        'diagnostics.network.cellularHeartbeat': coerceEnabledValue(data.heart_4g),
        'diagnostics.network.bluetoothActive': coerceEnabledValue(data.bt_state),
        'diagnostics.network.simPresent': simPresent(data),
        'diagnostics.network.wifiSsid': asText(wifiSsid(data)),
        'diagnostics.network.ipAddress': asText(ipAddress(data)),
        'diagnostics.network.simCcid': asText(simCcid(data)),
        'diagnostics.mapAvailable': isNonZero(safeGet(data, 'has_map', 'value')),
        'diagnostics.accelerometerActive': coerceEnabledValue(safeGet(data, 'acc_sta', 'value')),
        'diagnostics.features.antiLossActive': coerceEnabledValue(data.anti_loss_switch),
        'diagnostics.features.edgeCutActive': coerceEnabledValue(data.edge_switch),
        'diagnostics.features.indoorModeActive': coerceEnabledValue(data.indoor_switch),
        'diagnostics.features.autoUpgradeActive': coerceEnabledValue(data.auto_upgrade),
        'diagnostics.features.obstacleAvoidanceActive': coerceEnabledValue(safeGet(data, 'pobctl', 'switch')),
        'diagnostics.features.obstacleAvoidanceLevel':
            typeof safeGet(data, 'pobctl', 'level') === 'number' ? safeGet(data, 'pobctl', 'level') : null,
        'diagnostics.features.drcActive': coerceEnabledValue(data.drc_switch),
        'diagnostics.features.logUploadActive': coerceEnabledValue(data.log_switch),
        'diagnostics.security.factoryResetPending': coerceEnabledValue(data.factory_reset),
        'diagnostics.security.unbindPending': coerceEnabledValue(data.user_unbind),
        'diagnostics.security.pinCode': asInteger(data.pin_code),
        'diagnostics.security.antiLossRadius': asInteger(data.anti_loss_radius),
        'diagnostics.system.eventCode': asInteger(data.event_code),
        'diagnostics.system.firmwareVersion': asText(safeGet(data, 'fw_version', 'system_version')),
        'diagnostics.system.mainBoardVersion': asText(safeGet(data, 'fw_version', 'main_board')),
        'diagnostics.system.extensionBoardVersion': asText(safeGet(data, 'fw_version', 'exten_board')),
        'diagnostics.system.protocolVersion': asText(data.protocol_version),
        'diagnostics.system.minimumAppVersion': asText(data.min_app_version),
        'diagnostics.system.voiceLanguage': asText(
            safeGet(data, 'voice_status', 'name') || safeGet(data, 'music_cfg', 'music_language'),
        ),
        'diagnostics.ota.progress':
            typeof safeGet(data, 'ota_status', 'ota_progress') === 'number'
                ? safeGet(data, 'ota_status', 'ota_progress')
                : null,
        'diagnostics.ota.state': asText(safeGet(data, 'ota_status', 'ota_state')),
        'diagnostics.ota.timeEstimate':
            typeof safeGet(data, 'ota_status', 'ota_time_estimate') === 'number'
                ? safeGet(data, 'ota_status', 'ota_time_estimate')
                : null,
        'diagnostics.time.shadowUpdated': asIsoTimestamp(data.timestamp) || '',
        'diagnostics.time.systemBoot': asIsoTimestamp(data.system_boot_time) || '',
        'diagnostics.time.mapUpdated': asIsoTimestamp(data.map_time) || '',
        'diagnostics.time.pathUpdated': asIsoTimestamp(data.path_time) || '',
        'diagnostics.time.areaUpdated': asIsoTimestamp(data.area_time) || '',
        'diagnostics.time.nextAppointment': asIsoTimestamp(data.appointment_time) || '',

        'controls.fullMapMowing.mowHeight': cutterHeight,
        'controls.fullMapMowing.includeEdgeTrimming': coerceEnabledValue(safeGet(data, 'param_set', 'rid_switch')),
        'controls.fullMapMowing.customMowingDirection': customDirection,
        'controls.fullMapMowing.customMowingDirectionEnabled': isCustomDirectionEnabled(data),
        'controls.zoneMowing.mowHeight': cutterHeight,
        'controls.zoneMowing.mowCount':
            typeof safeGet(data, 'param_set', 'mow_count') === 'number'
                ? safeGet(data, 'param_set', 'mow_count')
                : null,
        'controls.zoneMowing.customMowingDirection': customDirection,
        'controls.zoneMowing.customMowingDirectionEnabled': isCustomDirectionEnabled(data),
        'controls.zoneMowing.obstacleAvoidanceEnabled': coerceEnabledValue(safeGet(data, 'pobctl', 'switch')),
        'controls.zoneMowing.obstacleAvoidanceLevel':
            typeof safeGet(data, 'pobctl', 'level') === 'number' ? safeGet(data, 'pobctl', 'level') : null,
        'controls.voiceVolume': typeof data.volume === 'number' ? data.volume : null,
        'controls.rain.perceptionEnabled': rainPerceptionEnabled,
        'controls.rain.continueTimeHours':
            typeof rainContinueTime === 'number' ? Math.round(rainContinueTime / 3600) : null,
        'controls.nearChargerMowing.enabled': nearChargerMowingEnabled,
        'controls.nearChargerMowing.mowHeight': nearChargerSettings.cutter_height,
        'controls.nearChargerMowing.mowCount': nearChargerSettings.mow_count,
        'controls.nearChargerMowing.obstacleAvoidanceEnabled': coerceEnabledValue(nearChargerSettings.pobctl_switch),
        'controls.nearChargerMowing.obstacleAvoidanceLevel': nearChargerSettings.pobctl_level,
        'zones.manual.list': JSON.stringify(compactZonePayload(manualZoneList)),
        'zones.manual.activeIds': JSON.stringify(activeManualZoneIds(data)),
        'zones.autoList': JSON.stringify(compactZonePayload(autoZoneList)),

        'raw.shadow.property': JSON.stringify(context.lastReported || {}),
        'raw.shadow.service': JSON.stringify(context.lastService || {}),
        'raw.shadow.event-code': JSON.stringify(eventCodeCache || {}),
        'raw.areaDefinition': JSON.stringify(context.areaDefinition || {}),
    };
}

/**
 * @param {object} data
 * @param {string} control
 * @returns {ioBroker.StateValue|undefined}
 */
function getControlFallbackValue(data, control) {
    if (control === 'fullMapMowing.mowHeight' || control === 'zoneMowing.mowHeight') {
        if (typeof data?.param_set?.cutter_height === 'number') {
            return data.param_set.cutter_height;
        }
        if (typeof data?.mow_remote?.cutter_height === 'number') {
            return data.mow_remote.cutter_height;
        }
        return null;
    }
    if (control === 'voiceVolume') {
        return typeof data.volume === 'number' ? data.volume : null;
    }
    if (control === 'fullMapMowing.customMowingDirection' || control === 'zoneMowing.customMowingDirection') {
        return typeof data?.param_set?.mow_head === 'number' ? data.param_set.mow_head : null;
    }
    if (control === 'fullMapMowing.includeEdgeTrimming') {
        return coerceEnabledValue(safeGet(data, 'param_set', 'rid_switch'));
    }
    if (
        control === 'fullMapMowing.customMowingDirectionEnabled' ||
        control === 'zoneMowing.customMowingDirectionEnabled'
    ) {
        return isCustomDirectionEnabled(data);
    }
    if (control === 'zoneMowing.mowCount') {
        return typeof data?.param_set?.mow_count === 'number' ? data.param_set.mow_count : null;
    }
    if (control === 'zoneMowing.obstacleAvoidanceEnabled') {
        return coerceEnabledValue(safeGet(data, 'pobctl', 'switch'));
    }
    if (control === 'zoneMowing.obstacleAvoidanceLevel') {
        return typeof safeGet(data, 'pobctl', 'level') === 'number' ? safeGet(data, 'pobctl', 'level') : null;
    }
    if (control === 'rain.perceptionEnabled') {
        return coerceEnabledValue(data.rain_switch);
    }
    if (control === 'rain.continueTimeHours') {
        return typeof data.rain_continue_time === 'number' ? Math.round(data.rain_continue_time / 3600) : null;
    }
    if (control === 'nearChargerMowing.enabled') {
        return coerceEnabledValue(
            data?.nest_switch !== undefined ? data.nest_switch : safeGet(data, 'param_set', 'nest_switch'),
        );
    }
    if (control === 'nearChargerMowing.mowHeight') {
        return nearChargerMowingSettings(data).cutter_height;
    }
    if (control === 'nearChargerMowing.mowCount') {
        return nearChargerMowingSettings(data).mow_count;
    }
    if (control === 'nearChargerMowing.obstacleAvoidanceEnabled') {
        return coerceEnabledValue(nearChargerMowingSettings(data).pobctl_switch);
    }
    if (control === 'nearChargerMowing.obstacleAvoidanceLevel') {
        return nearChargerMowingSettings(data).pobctl_level;
    }
    return undefined;
}

module.exports = {
    buildDeviceStateUpdates,
    getControlFallbackValue,
};
