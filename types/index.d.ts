/**
 * The now-playing mod's state contract: what the band, footer and queue pane
 * draw from.
 */

/** Which music player a snapshot came from. */
export type PlayerSource = 'music' | 'spotify'

/** Whether the player is playing or paused; a stopped player has no snapshot. */
export type PlaybackState = 'playing' | 'paused'

/** Repeat as both players spell it; Spotify has no `one`. */
export type RepeatMode = 'off' | 'one' | 'all'

/** One reading of a player: the track on, where it is, and the player's knobs. */
export type NowPlaying = {
  source: PlayerSource
  state: PlaybackState
  /** The player's own id for the track, so a change of track is detected. */
  trackId: string
  title: string
  artist: string
  album: string
  positionSeconds: number
  durationSeconds: number
  /** 0 to 100. */
  volume: number
  shuffle: boolean
  repeat: RepeatMode
  /** A link to share (Spotify), or null where the player gives none. */
  shareUrl: string | null
  /** Where the cover can be downloaded from (Spotify), or null. */
  artworkUrl: string | null
  /** `$.clock.now()` when the reading was taken, in milliseconds. */
  fetchedAt: number
}

/** The band's view of the world: the track to show, or why there is none. */
export type PlayerStatus = {
  current: NowPlaying | null
  /** A reason the player could not be read (a permission to grant), or null. */
  failure: string | null
}

/** A small picture as `0xRRGGBB` pixels, row-major from the top. */
export type Thumbnail = {
  width: number
  height: number
  pixels: number[]
}

/** A cover: a PNG on disk for terminals that draw pictures, and a small picture for the rest. */
export type Artwork = {
  trackId: string
  path: string
  /** Changes with each file written, so a redraw reads the new picture. */
  generation: number
  /**
   * The cover shrunk to a few pixels, folded into half-block cells at whatever
   * size a site draws it, where no picture can be drawn; null where one can.
   */
  thumbnail: Thumbnail | null
}

export type QueueEntry = {
  /** The track's position in the current playlist, from 1. */
  index: number
  title: string
  artist: string
  album: string
  /** Music's persistent ID, matched against the track on and the covers. */
  id: string
}

/** What the queue pane lists: Music's current playlist around the track on. */
export type Queue = {
  source: PlayerSource
  trackId: string
  /** The playlist position of the track on, so a song listed twice marks the right row. */
  currentIndex: number
  playlistName: string
  /** True when the playlist on is the one this mod adds tracks to. */
  isModPlaylist: boolean
  /** Why the list is empty when it is, in a line the pane shows; null with entries. */
  note: string | null
  entries: QueueEntry[]
}

/** One track found: in the Music library (addable) or in the Apple Music catalogue (openable). */
export type SearchResult = {
  /** Music's persistent ID for a library track; Apple's track id for a catalogue one. */
  id: string
  kind: 'library' | 'catalogue'
  title: string
  artist: string
  album: string
  /** A `music://` link that opens the track in Music; null for a library track. */
  url: string | null
}

/** The last search typed into the pane, and what it found in the library and the catalogue. */
export type LibrarySearch = {
  query: string
  /** Tracks in the library, ready to add. */
  results: SearchResult[]
  /** Tracks on Apple Music that the library lacks. */
  catalogue: SearchResult[]
  /** A line to show instead of results (nothing found, Music off), or null. */
  note: string | null
}

/** One listen, as the history keeps it across sessions. */
export type HistoryEntry = {
  id: string
  title: string
  artist: string
  album: string
  source: PlayerSource
  /** When the track started, in ms since the epoch. */
  at: number
}

/** The lyrics pane's content: the track on, its lyrics, or why there are none. */
export type LyricsView = {
  id: string
  title: string
  artist: string
  text: string
  note: string | null
}

/** The playlist this mod adds tracks to, as last counted. */
export type ModPlaylist = {
  name: string
  count: number
  /** The last tracks of the playlist, newest at the end; what the pane lists. */
  entries: QueueEntry[]
}

declare module 'claude-code' {
  /** The tools this mod registers for the model, so their calls are typed. */
  interface McpToolInputs {
    'mcp__now-playing__search_library': {
      query?: string
      limit?: number
      scope?: 'both' | 'library' | 'catalogue'
      genre?: string
      artist?: string
      album?: string
      title?: string
      yearFrom?: number
      yearTo?: number
      minStars?: number
      favourite?: boolean
      minPlays?: number
      maxPlays?: number
      notPlayedForDays?: number
      sort?: 'random' | 'leastPlayed' | 'mostPlayed' | 'newest' | 'oldest' | 'topRated' | 'title'
    }
    'mcp__now-playing__add_tracks': { tracks?: string[]; ids?: string[]; play?: boolean }
    'mcp__now-playing__remove_tracks': { ids: string[] }
    'mcp__now-playing__clear_playlist': Record<string, never>
    'mcp__now-playing__control_player': {
      action: 'play' | 'pause' | 'toggle' | 'next' | 'previous' | 'volume' | 'mute' | 'shuffle' | 'repeat' | 'playlist'
      volume?: number
      nudge?: 'up' | 'down'
    }
    'mcp__now-playing__now_playing': { upNext?: number; lyrics?: boolean }
    'mcp__now-playing__listening_history': { limit?: number }
    'mcp__now-playing__open_in_music': { url: string }
    'mcp__now-playing__show_now_playing': { shown?: boolean }
  }

  interface PluginState {
    'now-playing': {
      status: PlayerStatus
      isHidden: boolean | null
      /** Counts the seconds while a track plays, so the clocks move between polls. */
      tick: number
      artwork: Artwork | null
      queue: Queue | null
      /** Covers of the queue's tracks, by persistent ID, as they arrive. */
      queueCovers: Record<string, Artwork>
      search: LibrarySearch | null
      lyrics: LyricsView | null
      modPlaylist: ModPlaylist | null
      /** The volume before a mute, to restore on the next; null while not muted. */
      mutedVolume: number | null
    }
  }
}
