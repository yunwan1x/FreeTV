package app.freetv.radio

import android.app.Activity
import android.graphics.Insets
import android.view.View
import android.view.WindowInsets
import android.widget.FrameLayout
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class SystemBarInsetsTest {
    @Test
    fun viewportTracksSystemBarsCutoutAndFullscreenWithoutAccumulatingPadding() {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        // Robolectric has no Chromium layout delegate. Use a match-parent child
        // to measure the viewport that the Activity content frame gives to Wry.
        val viewport = View(activity)
        activity.setContentView(viewport)
        val host = activity.findViewById<FrameLayout>(android.R.id.content)
        fitSystemBars(host)
        var remainingKeyboardInset = 0
        viewport.setOnApplyWindowInsetsListener { _, insets ->
            remainingKeyboardInset = insets.getInsets(WindowInsets.Type.ime()).bottom
            insets
        }
        fun dispatch(top: Int, right: Int, bottom: Int) {
            val insets = WindowInsets.Builder()
                .setInsets(WindowInsets.Type.statusBars(), Insets.of(0, top, 0, 0))
                .setInsets(WindowInsets.Type.displayCutout(), Insets.of(0, 0, right, 0))
                .setInsets(WindowInsets.Type.navigationBars(), Insets.of(0, 0, 0, bottom))
                .setInsets(WindowInsets.Type.ime(), Insets.of(0, 0, 0, 300))
                .build()
            host.dispatchApplyWindowInsets(insets)
            val width = View.MeasureSpec.makeMeasureSpec(1080, View.MeasureSpec.EXACTLY)
            val height = View.MeasureSpec.makeMeasureSpec(2400, View.MeasureSpec.EXACTLY)
            host.measure(width, height)
            host.layout(0, 0, 1080, 2400)
            assertEquals(300 - bottom, remainingKeyboardInset)
            assertEquals(top, viewport.top)
            assertEquals(1080 - right, viewport.right)
            assertEquals(2400 - bottom, viewport.bottom)
        }
        dispatch(96, 0, 48)
        fitSystemBars(host)
        dispatch(96, 0, 48)
        dispatch(0, 0, 0)
        dispatch(64, 80, 24)
    }
}
