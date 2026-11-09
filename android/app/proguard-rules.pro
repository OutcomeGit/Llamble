# methods the web app calls through window.llambleAndroid
-keepclassmembers class com.llamble.app.Bridge {
    @android.webkit.JavascriptInterface <methods>;
}
