package org.onemindlabs.airhop

import android.os.Build
import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultReactActivityDelegate
import expo.modules.ReactActivityDelegateWrapper

class MainActivity : ReactActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        // Before onCreate, as expo-splash-screen requires: the theme colors the
        // background, status bar and navigation bar.
        setTheme(R.style.AppTheme)
        super.onCreate(null)

        // Keep the open conversation out of the recents list, which otherwise
        // holds a screenshot of the last frame. Android draws the icon instead.
        //
        // Declarative rather than an overlay on onPause: a permission dialog pauses
        // the activity without the user having left, and an overlay there dimmed
        // the screen behind every onboarding prompt. Not FLAG_SECURE either, which
        // would also block the ordinary screenshots Airhop answers with a notice.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            setRecentsScreenshotEnabled(false)
        }
    }

    override fun getMainComponentName(): String = "main"

    override fun createReactActivityDelegate(): ReactActivityDelegate =
        ReactActivityDelegateWrapper(
            this,
            object : DefaultReactActivityDelegate(this, mainComponentName) {},
        )

    // Below Android S, back on a root activity would finish it. Match S and later,
    // which move it to the background, and whose default does more than
    // moveTaskToBack, so it is left to run there.
    override fun invokeDefaultOnBackPressed() {
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.R) {
            if (!moveTaskToBack(false)) {
                super.invokeDefaultOnBackPressed()
            }
            return
        }

        super.invokeDefaultOnBackPressed()
    }
}
