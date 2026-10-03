// Prints one line each time Music or Spotify announces a change (track, play,
// pause), after a first line saying it is ready. The Now Playing mod runs it
// with `swift` and reads the players on each line, instead of polling them.
// It needs no compilation step: `swift player-events.swift` interprets it.
import Foundation

let centre = DistributedNotificationCenter.default()
let names = ["com.apple.Music.playerInfo", "com.spotify.client.PlaybackStateChanged"]
for name in names {
    centre.addObserver(forName: Notification.Name(name), object: nil, queue: nil) { _ in
        print(name)
        fflush(stdout)
    }
}
print("ready")
fflush(stdout)
RunLoop.main.run()
