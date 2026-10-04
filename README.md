# Now Playing for Claude Code

A Claude Code mod that shows what Apple Music or Spotify is playing in a slim band above the prompt, with controls, cover art, an "Up next" pane, lyrics, a listening history, and tools that let Claude control the player and build playlists from your Music library by mood.

<img width="1794" height="147" alt="large_top_only" src="https://github.com/user-attachments/assets/8c35244b-f542-44ca-a88a-f4142b927b8f" />

The frame is red for Music and green for Spotify; the cover is the real picture in terminals that draw them (kitty, Ghostty, WezTerm) and a coloured half-block thumbnail elsewhere. The compact band, two rows with a small cover, is a setting away and is what a short or narrow terminal gets:

<img width="1794" height="233" alt="compact_bottom_and_band" src="https://github.com/user-attachments/assets/f2ba37be-c97e-484f-8b4b-1ba946252977" />

Footer placement puts the track among the prompt footer's bottom-right labels instead:

<img width="1797" height="221" alt="bottom_only" src="https://github.com/user-attachments/assets/dc56c1bc-c577-497f-b13f-345119acb114" />

### The Up next & playlist pane

`/np queue` opens a pane in three sections. Up next is what Music will play, read only; the playlist is the mod's own, where every add lands; the add section searches your library and Apple Music:

```
Up next · OK Computer                                           x: close
  Airbag — Radiohead
▶ Paranoid Android — Radiohead
  Subterranean Homesick Alien — Radiohead
  Exit Music (For a Film) — Radiohead

Claude Code playlist · 10 tracks                       l: play it  clear
  The Journey — Tom Misch                                         remove
  Wander With Me (feat. Carmody) — Tom Misch                      remove
  Falafel — Tom Misch                                             remove
  Beautiful Escape — Tom Misch                                    remove

Add to the Claude Code playlist
Added tracks go in the playlist, not Up next; "play it" makes it Up next.
Only songs already in your Music library can be added; others open in…
┌──────────────────────────────────────────────────────────────────────┐
│ Search your library and Apple Music                           search │
└──────────────────────────────────────────────────────────────────────┘
"so what"                                                          clear
In your library, press one to add it to the playlist:
+ So What — Miles Davis · Kind of Blue
On Apple Music but not in your library, so not addable here.
Press one to open it in Music and add it to your library there:
↗ So What (Live) — Miles Davis · Live in Europe
```

### The lyrics pane

`/np lyrics` follows the track on:

```
Lyrics · Everything In Its Right Place — Radiohead              x: close
Everything
Everything
Everything
In its right place
```

macOS only: it talks to the players through AppleScript.

## Features

- **Band above the prompt**, framed in the player's colour, with the title and artist on their own rows, a progress bar that moves in eighth-cell steps every second, the clock, volume, and shuffle/repeat glyphs. Collapses to one row while Claude is working.
- **Controls with hotkeys**: prev, play/pause, next, volume, mute (restores the old volume), shuffle, repeat (off, all, one), copy a share link, queue, hide, open the player. Transport is bright, the rest dim until the pointer is over the band, and a shuffle or repeat that is on shows bright with its state. The band keeps the most-used controls when it gets narrow.
- **Cover art** beside the band (10 by 5 cells) and beside each row of the queue (6 by 3). Terminals that draw pictures (kitty, Ghostty, WezTerm) get the real cover; every other terminal gets a pixel thumbnail drawn from coloured half-block cells.
- **Footer placement** as an alternative: the track as a dim label in the prompt footer's bottom-right corner, where `focus` and similar labels sit.
- **Up next & playlist pane** (`/np queue` or `/np upnext`), in three sections: *Up next*, Music's current playlist around the track on, each entry clickable to jump to it, preloaded in the background as tracks change; the mod's own *playlist* ("Claude Code" by default), with a play-it button and its last tracks; and *Add to the playlist*, a search box. See "How the pieces fit" below.
- **Search and add**: the search box finds tracks in your Music library and adds them to the mod's playlist, since Music's own Up Next cannot be scripted. With "Search Apple Music too" on (the default), the same search also asks Apple's public catalogue, and each track you don't own gets a row that opens it in Music, where it can be played or added to the library.
- **Ask Claude**: "add 10 great jazz tracks", "skip this", "what's this song", "play my 90s hip hop I haven't heard in a year" all work. Claude gets nine tools: `now_playing` (track, up next, lyrics), `control_player`, `search_library` (text search, or filters by genre, year, stars, favourite, play count and days since last play, sorted random, least played and so on), `add_tracks` (by name or by id), `remove_tracks`, `clear_playlist`, `listening_history`, `open_in_music` and `show_now_playing`. For a song you don't own it gives the Apple Music link, which `open_in_music` (or `/np open <link>`) opens in the Music app.
- **Lyrics pane** (`/np lyrics`): the lyrics stored with the library track that is on, following the track as it changes. Apple Music's own streamed lyrics are not exposed to scripts, so only tracks whose files carry lyrics show them.
- **Listening history** (`/np history [n]`): every track heard while Claude Code was open, kept across sessions, with the time and the player. Claude can read it to find "that song from earlier" or build a playlist from a day's listening.
- **Instant updates**: a small Swift helper listens for Music's and Spotify's own change notifications, so the band updates the moment a track changes and polls only every 15 seconds to keep the clock honest. It needs Xcode's command line tools; without them the band polls every 2 seconds as before. Off in `/config` if you prefer.
- **Optional**: tell Claude what's playing through a system-prompt section (off by default).

## Install

Load it for one session:

```sh
claude --plugin-dir /path/to/nowplaying
```

Or for every session, add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`.

The first time it talks to Music or Spotify, macOS asks whether your terminal may control that app. Allow it; otherwise the band shows a line pointing at System Settings → Privacy & Security → Automation.

## How the pieces fit

- **Now playing** is the band: the track your player is on.
- **Up next** is what Music will play after it: the rest of whatever playlist or album is playing. The pane shows it and lets you jump to a track, but nothing here can add to it, because Music does not let scripts edit Up Next.
- **The playlist** ("Claude Code" by default) is the mod's own, and the only place the pane's search and Claude's `add_tracks` put songs. Press "play it" (or `/np playlist`) to make it what's playing; from then on it *is* Up next, and every song added joins the end of the queue. The pane's add section says which of the two is true at the moment. `/np clear` empties it; the songs stay in your library.
- **Library only.** Music lets a script put only tracks you already own into a playlist, so that is all the search box, `/np add` and Claude can add. A song found on Apple Music that you don't own is shown with an open-in-Music row instead: open it there, add it to your library, and it becomes addable.
- **Spotify is show-and-control only.** Spotify's scripting reports the track and takes transport, volume, shuffle and repeat, and nothing else: no queue, no search, no playlists. With Spotify on, the pane's Up next is empty and its add section still adds to the Music playlist.

## Commands

`/np` on its own reports what's on. With an argument:

| Argument | Does |
| --- | --- |
| `play`, `pause`, `toggle`, `next`, `prev` | Transport |
| `play <name>` | Music plays the first library track whose name matches |
| `vol <0-100>`, `vol +`, `vol -` | Volume |
| `mute`, `shuffle`, `repeat` | Toggle mute, toggle shuffle, cycle repeat |
| `copy` | Copy the Spotify link, or the track name on Music |
| `open` | Bring the player to the front |
| `queue`, `upnext` | Open or close the Up next & playlist pane |
| `lyrics` | Open or close the lyrics pane |
| `history [n]` | The last n tracks heard (default 10) |
| `search <text>` | Search the library and Apple Music, results in the pane |
| `add <title — artist>` | Add the best library match to the playlist |
| `open <link>` | Open a music.apple.com link in the Music app |
| `playlist` | Play the mod's playlist |
| `clear` | Empty the mod's playlist (the tracks stay in your library; the pane has clear and per-track remove buttons too) |
| `hide`, `show` | Hide or show the band (remembered) |

`play <name>`, `search`, `add`, `playlist`, `clear`, `lyrics` and the contents of the pane need Apple Music running; see the table under Limits.

The band starts hidden. `/np show`, or asking Claude to show what's playing, reveals it, and that choice is remembered across sessions; `/np hide` or the `x` control hides it again.

## Settings

In `/config`, under the plugin: placement (band, footer, both), band size (large, compact), player (auto, music, spotify), refresh interval, volume step, cover art, covers in Up next, preload Up next, quiet while Claude works, search Apple Music too, instant updates, tell Claude what's playing, and the playlist name.

## Limits

- Only tracks already in your Music library can be added to the playlist: AppleScript cannot add from the catalogue. Catalogue tracks are found through Apple's public search API (no sign-in) and can only be opened in Music, where you add them to the library yourself.
- What each player's scripting allows:

| | Apple Music | Spotify |
| --- | --- | --- |
| Band: track, progress, cover art | yes | yes |
| Play, pause, skip, volume, mute, shuffle | yes | yes |
| Repeat | off, all, one | off, all |
| Copy | the track name | a share link |
| Up next pane | yes | no queue in its scripting |
| Play by name, search | library only | no |
| Add to the playlist, play the playlist, clear it | library tracks only | no |
| Open a link in the app | music.apple.com links | no |
| Lyrics | stored with library tracks only | no |
| Filter by genre, year, stars, favourite, play count | yes (favourite needs macOS 14 or later) | no |
| Listening history | yes | yes |
| Instant updates | yes | yes |
- Full-resolution cover art needs a terminal that speaks the kitty graphics protocol. iTerm2 and Terminal.app do not, so they get the 4×2 cell thumbnail instead.

## Development

Checks: `claude plugin validate .`, `tsc -p .` (after the plugin has loaded once, which lays the engine's types beside it) and `claude plugin test .`. The same three run in CI (`.github/workflows/ci.yml`, on macOS) and as pre-commit hooks alongside hygiene and secret scanning (`.pre-commit-config.yaml`; install with `uvx pre-commit install`).

The player-event helper is `hooks/player-events.swift`, run through `swift` as a script, so there is nothing to compile or ship.

```sh
claude plugin validate .   # what the engine will accept, and what it refuses
claude plugin test .       # the tests in tests/
tsc -p .                   # type-check, once Claude Code has laid .claude-plugin/types/ by loading the mod
```

The AppleScript is generated in `hooks/players.ts`. Quirks it works around: `offset`, `names`, `removed`, `matched`, `before` and `after` are reserved words; `loved` became `favorited` in macOS 14; properties must be fetched with `get` before being concatenated or written; and Music's `index` of a track matches `track k of playlist` but not a range or `every track`, so the queue reads tracks one by one.
