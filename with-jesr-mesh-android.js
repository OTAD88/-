const { createRunOncePlugin, withAndroidManifest } = require("expo/config-plugins");

const PERMISSION = "android.permission.";

function addPermission(manifest, name, attributes = {}) {
  manifest["uses-permission"] ??= [];
  const existing = manifest["uses-permission"].find((item) => item.$?.["android:name"] === name);
  if (existing) {
    Object.assign(existing.$, attributes);
    return;
  }
  manifest["uses-permission"].push({ $: { "android:name": name, ...attributes } });
}

function withJesrMeshAndroid(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    addPermission(manifest, `${PERMISSION}INTERNET`);
    addPermission(manifest, `${PERMISSION}ACCESS_WIFI_STATE`);
    addPermission(manifest, `${PERMISSION}CHANGE_WIFI_STATE`);
    addPermission(manifest, `${PERMISSION}BLUETOOTH`, { "android:maxSdkVersion": "30" });
    addPermission(manifest, `${PERMISSION}BLUETOOTH_ADMIN`, { "android:maxSdkVersion": "30" });
    addPermission(manifest, `${PERMISSION}BLUETOOTH_SCAN`, {
      "android:usesPermissionFlags": "neverForLocation",
    });
    addPermission(manifest, `${PERMISSION}BLUETOOTH_ADVERTISE`);
    addPermission(manifest, `${PERMISSION}BLUETOOTH_CONNECT`);
    addPermission(manifest, `${PERMISSION}NEARBY_WIFI_DEVICES`, {
      "android:usesPermissionFlags": "neverForLocation",
    });
    addPermission(manifest, `${PERMISSION}ACCESS_FINE_LOCATION`, {
      "android:maxSdkVersion": "32",
    });
    addPermission(manifest, `${PERMISSION}FOREGROUND_SERVICE`);
    addPermission(manifest, `${PERMISSION}FOREGROUND_SERVICE_CONNECTED_DEVICE`);
    addPermission(manifest, `${PERMISSION}POST_NOTIFICATIONS`);

    manifest["uses-feature"] ??= [];
    for (const feature of ["android.hardware.bluetooth_le", "android.hardware.wifi.direct"]) {
      if (!manifest["uses-feature"].some((item) => item.$?.["android:name"] === feature)) {
        manifest["uses-feature"].push({
          $: { "android:name": feature, "android:required": "false" },
        });
      }
    }

    const application = manifest.application?.[0];
    if (application) {
      application.$["android:allowBackup"] = "false";
      application.service ??= [];
      const serviceName = "com.jesr.network.MeshForegroundService";
      if (!application.service.some((item) => item.$?.["android:name"] === serviceName)) {
        application.service.push({
          $: {
            "android:name": serviceName,
            "android:exported": "false",
            "android:foregroundServiceType": "connectedDevice",
          },
        });
      }
    }
    return config;
  });
}

module.exports = createRunOncePlugin(withJesrMeshAndroid, "with-jesr-mesh-android", "1.0.0");
