#!/usr/bin/env bash
# Boots the Llamble APK in an Android emulator (CI only: needs KVM) and checks it opens
# the app's login screen with no crash. Leaves a screenshot in /tmp/android.png.
set -euo pipefail
APK=${1:?apk}
SDK=${ANDROID_HOME:-$ANDROID_SDK_ROOT}
IMG="system-images;android-35;google_apis;x86_64"
yes | "$SDK/cmdline-tools/latest/bin/sdkmanager" --licenses >/dev/null || true
"$SDK/cmdline-tools/latest/bin/sdkmanager" "emulator" "platform-tools" "$IMG" >/dev/null
echo no | "$SDK/cmdline-tools/latest/bin/avdmanager" create avd -n llamble -k "$IMG" -d pixel_6 --force >/dev/null
"$SDK/emulator/emulator" -avd llamble -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader_indirect -memory 3072 >/tmp/emulator.log 2>&1 &
ADB="$SDK/platform-tools/adb"
"$ADB" wait-for-device
for i in $(seq 1 120); do
  [ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && break
  sleep 3
done
echo "emulator booted: Android $("$ADB" shell getprop ro.build.version.release | tr -d '\r')"
"$ADB" shell settings put global window_animation_scale 0 || true
"$ADB" install -r -g "$APK"
"$ADB" logcat -c
"$ADB" shell am start -W -n com.llamble.app/.MainActivity
# the web app loads and shows its login screen (the WebView's text is visible to uiautomator)
ok=""
for i in $(seq 1 40); do
  sleep 3
  "$ADB" shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 || continue
  "$ADB" shell cat /sdcard/ui.xml > /tmp/android-ui.xml 2>/dev/null || continue
  if grep -q "Welcome back" /tmp/android-ui.xml; then ok=1; break; fi
done
"$ADB" exec-out screencap -p > /tmp/android.png || true
"$ADB" logcat -d > /tmp/android-logcat.txt || true
if grep -q "FATAL EXCEPTION" /tmp/android-logcat.txt; then
  grep -A20 "FATAL EXCEPTION" /tmp/android-logcat.txt | head -40
  echo "ANDROID: the app crashed"; exit 1
fi
grep -iE "chromium.*(Uncaught|Error)" /tmp/android-logcat.txt | head -10 || true
[ -n "$ok" ] || { echo "ANDROID: the login screen never showed"; grep -o 'text="[^"]*"' /tmp/android-ui.xml | head -30 || true; exit 1; }
"$ADB" shell pidof com.llamble.app >/dev/null || { echo "ANDROID: app isn't running"; exit 1; }
echo "ANDROID OK: the app opened Llamble's login screen, no crash"
