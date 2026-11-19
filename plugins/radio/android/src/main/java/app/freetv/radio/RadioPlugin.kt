package app.freetv.radio

import android.app.Activity
import android.content.ComponentName
import android.net.Uri
import android.os.Bundle
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
