const { withAndroidManifest } = require("expo/config-plugins");

module.exports = (config) =>
  withAndroidManifest(config, (next) => {
    const application = next.modResults.manifest.application?.[0];
    if (!application) {
      throw new Error("Expo Turbo demo Android application manifest is missing");
    }
    application.$["android:usesCleartextTraffic"] = "true";
    return next;
  });
