package app.freetv.radio

import android.net.Uri
import android.os.Bundle
import androidx.media3.common.Player
import androidx.media3.common.PlaybackException
import android.app.PendingIntent
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import com.google.common.util.concurrent.Futures

@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class RadioService : MediaSessionService() {
    private lateinit var session: MediaSession

    override fun onCreate() {
        super.onCreate()
        val player = ExoPlayer.Builder(this)
            .setAudioAttributes(AudioAttributes.DEFAULT, true)
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .build()
        player.addListener(object : Player.Listener {
            override fun onPlayerError(error: PlaybackException) {
                val item = player.currentMediaItem ?: return
                val request = item.requestMetadata
                val fallback = Uri.parse(request.extras?.getString("fallback") ?: return)
                if (fallback.scheme !in setOf("http", "https") || fallback == request.mediaUri) return
                val extras = Bundle(request.extras).apply { remove("fallback") }
                player.setMediaItem(item.buildUpon().setUri(fallback)
                    .setRequestMetadata(request.buildUpon().setMediaUri(fallback).setExtras(extras).build()).build())
                player.prepare()
                player.play()
            }
        })
        val builder = MediaSession.Builder(this, player).setCallback(object : MediaSession.Callback {
            override fun onAddMediaItems(
                mediaSession: MediaSession,
                controller: MediaSession.ControllerInfo,
                mediaItems: List<MediaItem>
            ) = Futures.immediateFuture(mediaItems.map { item ->
                val uri = requireNotNull(item.requestMetadata.mediaUri)
                require(uri.scheme in setOf("http", "https"))
                val resolved = item.buildUpon().setUri(uri)
                if (item.requestMetadata.extras?.getBoolean("hls") == true)
                    resolved.setMimeType(MimeTypes.APPLICATION_M3U8)
                resolved.build()
            })
        })
        packageManager.getLaunchIntentForPackage(packageName)?.let { intent ->
            builder.setSessionActivity(PendingIntent.getActivity(this, 0, intent,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
        }
        session = builder.build()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo) = session

    override fun onDestroy() {
        session.player.release()
        session.release()
        super.onDestroy()
    }
}
