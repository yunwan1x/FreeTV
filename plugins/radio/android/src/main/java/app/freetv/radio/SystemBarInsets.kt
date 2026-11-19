package app.freetv.radio

import android.view.ViewGroup
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

// Wry places its WebView inside the Activity content frame. Padding that frame
// resizes the entire viewport, including dialogs and fixed-position controls.
internal fun fitSystemBars(content: ViewGroup) {
    val safeArea = WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()

    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
        val bars = insets.getInsets(safeArea)
        view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
        // Keep the remaining IME inset available to the WebView.
        insets.inset(bars.left, bars.top, bars.right, bars.bottom)
    }
    ViewCompat.requestApplyInsets(content)
}
