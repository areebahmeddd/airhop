# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# react-native-reanimated
-keep class com.swmansion.reanimated.** { *; }
-keep class com.facebook.react.turbomodule.** { *; }

# The JNI bridge to the embedded Tor client.
#
# A native method is resolved by name at call time: the runtime looks for the
# symbol `Java_org_onemindlabs_airhop_tor_ArtiNative_nativeStart` and so on. R8
# does not know that, so left to itself it renames the class and the methods,
# every lookup misses, and the first attempt to switch Tor on throws
# UnsatisfiedLinkError.
#
# Debug builds are not minified, so this fails only in release, and only for the
# one feature. Named explicitly rather than through the usual blanket
# `-keepclasseswithmembernames class * { native <methods>; }`, because this is
# the only JNI in the app and a rule that says which class and why is worth more
# than one that quietly covers whatever appears later.
-keep class org.onemindlabs.airhop.tor.ArtiNative {
    native <methods>;
}

# The gomobile bindings for the pluggable transports.
#
# Go calls back into these generated classes by name, the same way the Arti JNI
# above is resolved, so R8 renaming them would break the transports only in
# release and only once a user turns bridges on.
-keep class IPtProxy.** { *; }
-keep class go.** { *; }

# Drop debug logging from release builds.
#
# Airhop modules log only at i/w/e; d/v logs come from bundled libraries like RN, Expo, Fresco.
# This rule prevents their d/v logs from filling the shared buffer on release devices.
# Minification alone doesn't remove Log calls; this applies only to the optimizing ProGuard config.
# Calls are removed, though some string-building/concatenation may remain and cost CPU.
-assumenosideeffects class android.util.Log {
    public static int d(...);
    public static int v(...);
}

# Add any project specific keep options here:
