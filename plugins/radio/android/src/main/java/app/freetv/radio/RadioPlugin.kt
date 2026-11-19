package app.freetv.radio

import android.app.Activity
import android.app.PictureInPictureParams
import android.content.pm.PackageManager
import android.os.Build
import android.util.Rational
import android.webkit.WebView
import android.content.ComponentName
import android.net.Uri
import android.os.Bundle
import android.view.ViewGroup
import androidx.activity.OnBackPressedCallback
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.common.util.concurrent.ListenableFuture

@TauriPlugin
class RadioPlugin(private val activity: Activity) : Plugin(activity) {
    private var connection: ListenableFuture<MediaController>? = null
    private val executor = ContextCompat.getMainExecutor(activity)

    private var view: WebView? = null

    private val fullscreenBack = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() {
            setFullscreen(false)
            view?.evaluateJavascript("window.dispatchEvent(new Event('freetv-fullscreen-exit'))", null)
        }
    }

    private fun setFullscreen(enabled: Boolean) {
        val controller = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
        if (enabled) {
            controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            controller.hide(WindowInsetsCompat.Type.systemBars())
        } else controller.show(WindowInsetsCompat.Type.systemBars())
        fullscreenBack.isEnabled = enabled
    }

    @Command
    fun fullscreen(invoke: Invoke) {
        activity.runOnUiThread {
            setFullscreen(invoke.getArgs().getBoolean("enabled"))
            invoke.resolve()
        }
    }

    override fun load(webView: WebView) {
        view = webView
        fitSystemBars(activity.findViewById<ViewGroup>(android.R.id.content))
        (activity as AppCompatActivity).onBackPressedDispatcher.addCallback(activity, fullscreenBack)
        (activity as AppCompatActivity).addOnPictureInPictureModeChangedListener { info ->
            val event = if (info.isInPictureInPictureMode) "freetv-pip-enter" else "freetv-pip-exit"
            if (info.isInPictureInPictureMode) webView.onResume()
            webView.evaluateJavascript("window.dispatchEvent(new Event('$event'))", null)
        }
    }

    override fun onPause(activity: AppCompatActivity) {
        if (Build.VERSION.SDK_INT >= 26 && activity.isInPictureInPictureMode) view?.onResume()
    }

    @Command
    fun pip(invoke: Invoke) {
        activity.runOnUiThread {
            try {
                if (Build.VERSION.SDK_INT < 26 ||
                    !activity.packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) {
                    invoke.reject("此设备不支持系统画中画")
                } else {
                    val params = PictureInPictureParams.Builder().setAspectRatio(Rational(16, 9)).build()
                    if (activity.enterPictureInPictureMode(params)) invoke.resolve()
                    else invoke.reject("请在系统设置中允许 FreeTV 使用画中画")
                }
            } catch (e: Exception) { invoke.reject("系统拒绝进入画中画", e) }
        }
    }

    private fun withPlayer(invoke: Invoke, action: (MediaController) -> Unit) {
        activity.runOnUiThread {
            val pending = connection
            val future = if (pending == null || (pending.isDone && runCatching { !pending.get().isConnected }.getOrDefault(true))) {
                pending?.let { MediaController.releaseFuture(it) }
                MediaController.Builder(activity, SessionToken(activity,
                    ComponentName(activity, RadioService::class.java))).buildAsync().also { connection = it }
            } else pending
            future.addListener({
                try { action(future.get()) }
                catch (e: Exception) { invoke.reject("电台服务不可用", e) }
            }, executor)
        }
    }

    @Command
    fun start(invoke: Invoke) = withPlayer(invoke) { player ->
        val args = invoke.getArgs()
        val uri = Uri.parse(args.getString("url"))
        require(uri.scheme in setOf("http", "https"))
        val metadata = MediaMetadata.Builder().setTitle(args.getString("name"))
            .setArtist(args.optString("region")).build()
        val request = MediaItem.RequestMetadata.Builder().setMediaUri(uri)
            .setExtras(Bundle().apply { putBoolean("hls", args.optBoolean("hls")); putString("fallback",args.optString("fallback")) }).build()
        player.setMediaItem(MediaItem.Builder().setMediaId(args.getString("id"))
            .setMediaMetadata(metadata).setRequestMetadata(request).build())
        player.prepare()
        player.play()
        invoke.resolve()
    }

    @Command
    fun control(invoke: Invoke) = withPlayer(invoke) { player ->
        when (invoke.getArgs().getString("action")) {
            "pause" -> player.pause()
            "resume" -> { if (player.playbackState == Player.STATE_IDLE) player.prepare(); player.play() }
            "stop" -> { player.stop(); player.clearMediaItems() }
            else -> error("未知播放操作")
        }
        invoke.resolve()
    }

    @Command
    fun status(invoke: Invoke) = withPlayer(invoke) { player ->
        val state = when {
            player.playerError != null -> "error"
            player.currentMediaItem == null -> "idle"
            player.isPlaying -> "playing"
            !player.playWhenReady -> "paused"
            player.playbackState == Player.STATE_ENDED -> "ended"
            else -> "buffering"
        }
        invoke.resolve(JSObject().apply {
            put("state", state)
            put("id", player.currentMediaItem?.mediaId ?: "")
            put("name", player.mediaMetadata.title?.toString() ?: "")
        })
    }

    override fun onDestroy(activity: AppCompatActivity) {
        connection?.let { MediaController.releaseFuture(it) }
        connection = null
        super.onDestroy(activity)
    }
}
