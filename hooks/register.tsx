/**
 * Now Playing: the track on in Apple Music or Spotify, shown above the prompt
 * (a band with cover art and controls) or in the prompt footer, with a `/np`
 * command, an "Up next" pane that searches the library and adds to a playlist
 * of the mod's own, and tools Claude calls to add songs.
 */
import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, PluginOptions, Register, RenderSurface, Timer } from 'claude-code'

import type { Artwork, HistoryEntry, LibrarySearch, LyricsView, ModPlaylist, NowPlaying, PlayerSource, PlayerStatus, Queue, QueueEntry, SearchResult, Thumbnail } from '../types'
import { BUTTON_GAP, MS_PER_SECOND, cellWidth, fitControls, formatClock, layoutFor, plainButtonWidth, positionNow, progressBar, truncateText } from './format'
import { bytesFromBase64, decodeBmp, encodeCells, thumbnailCells } from './pixels'
import {
  MAX_SEARCH_RESULTS,
  addTracksScript,
  clearPlaylistScript,
  filterLibraryScript,
  lyricsScript,
  normalise,
  parseCount,
  parseLibraryTracks,
  parseLyrics,
  pickTracks,
  removeFromPlaylistScript,
  artworkByIdScript,
  artworkExportScript,
  clampVolume,
  classifyFailure,
  controlScript,
  describeFailure,
  displayName,
  downloadArgv,
  ensurePlaylistScript,
  nextRepeatMode,
  openAppArgv,
  osascriptArgv,
  parseAdded,
  parseCleared,
  parsePlayed,
  parseQueue,
  parseRunningPlayers,
  parseSearch,
  parseSearchMany,
  parsePlaylist,
  playPlaylistTrackScript,
  catalogueSearchUrl,
  musicAppUrl,
  parseCatalogue,
  storefrontFrom,
  withoutLibraryDuplicates,
  parseStatus,
  pickBestMatch,
  pickCurrent,
  playByNameScript,
  playPlaylistScript,
  queueScript,
  runningPlayersArgv,
  searchLibraryManyScript,
  searchLibraryScript,
  splitTrackQuery,
  statusScript,
  toPngArgv,
  toThumbnailArgv,
  type AddOutcome,
  type LibraryFilter,
  type LibrarySort,
  type LibraryTrack,
  type PlayerCommand,
} from './players'

const COMMAND = 'np'
const QUEUE_PANE = 'now-playing-queue'
/** Set once the person (or Claude) shows the band; unset, the band stays hidden. */
const STORE_SHOWN = 'isShown'
const TOOL_SEARCH = 'mcp__now-playing__search_library'
const TOOL_ADD = 'mcp__now-playing__add_tracks'
const TOOL_OPEN = 'mcp__now-playing__open_in_music'
const TOOL_SHOW = 'mcp__now-playing__show_now_playing'
const TOOL_CONTROL = 'mcp__now-playing__control_player'
const TOOL_STATUS = 'mcp__now-playing__now_playing'
const TOOL_HISTORY = 'mcp__now-playing__listening_history'
const TOOL_REMOVE = 'mcp__now-playing__remove_tracks'
const TOOL_CLEAR = 'mcp__now-playing__clear_playlist'
const LYRICS_PANE = 'now-playing-lyrics'
/** Set once the first session has been told the band exists and how to show it. */
const STORE_INTRODUCED = 'isIntroduced'
/** The tracks heard, oldest first, kept across sessions. */
const STORE_HISTORY = 'history'
const HISTORY_KEEP = 500
const HISTORY_DEFAULT_SHOWN = 10
const HISTORY_MAX_SHOWN = 100
/** The same track starting again within this long is one listen, not two. */
const HISTORY_REPEAT_WINDOW_MS = 30 * 60 * 1000
const DEFAULT_UP_NEXT_SHOWN = 5
const MAX_FILTER_RESULTS = 100
/** While the player-event listener runs, polling only re-syncs the clock. */
const LISTENER_PLAYING_POLL_MS = 15_000
const LISTENER_PAUSED_POLL_MS = 60_000

const IDLE_STATUS: PlayerStatus = { current: null, failure: null }
const status = atom({ plugin: 'now-playing', key: 'status' } as const, IDLE_STATUS)
const lyrics = atom({ plugin: 'now-playing', key: 'lyrics' } as const, null)
/**
 * Whether the band is hidden: the choice made this session, or null before
 * one, when `readHidden` asks the store what the last session chose. The band
 * starts hidden; /np show, the x control's opposite, or Claude's tool reveals it.
 */
const isHidden = atom({ plugin: 'now-playing', key: 'isHidden' } as const, null)
const tick = atom({ plugin: 'now-playing', key: 'tick' } as const, 0)
const artwork = atom({ plugin: 'now-playing', key: 'artwork' } as const, null)
const queue = atom({ plugin: 'now-playing', key: 'queue' } as const, null)
const queueCovers = atom({ plugin: 'now-playing', key: 'queueCovers' } as const, {})
const search = atom({ plugin: 'now-playing', key: 'search' } as const, null)
const modPlaylist = atom({ plugin: 'now-playing', key: 'modPlaylist' } as const, null)
const mutedVolume = atom({ plugin: 'now-playing', key: 'mutedVolume' } as const, null)

const SCRIPT_TIMEOUT_MS = 8000
const SEARCH_TIMEOUT_MS = 15_000
/** A batch of searches runs in one osascript, so the whole batch gets one longer bound. */
const BATCH_SEARCH_TIMEOUT_MS = 90_000
/** How long a player that refused or garbled a read is left alone. */
const FAILURE_BACKOFF_MS = 30_000
/** How long a player that was merely slow to answer is left alone. */
const TIMEOUT_BACKOFF_MS = 5000
const PAUSED_POLL_MS = 10_000
const IDLE_POLL_MS = 5000
const HIDDEN_POLL_MS = 15_000
const TICK_MS = 1000
const REFRESH_AFTER_CONTROL_MS = 400
const MIN_POLL_SECONDS = 1
const MAX_POLL_SECONDS = 30
const DEFAULT_POLL_SECONDS = 2
const DEFAULT_VOLUME_STEP = 10
const MAX_VOLUME_STEP = 50
const UNMUTE_FALLBACK_VOLUME = 50
const MIN_TITLE_WIDTH = 8
const DEFAULT_PLAYLIST_NAME = 'Claude Code'
const MAX_TRACKS_PER_ADD = 50
/** How many catalogue matches are weighed for a request the library lacks. */
const CATALOGUE_FALLBACK_LIMIT = 5
/** How many catalogue lookups run at once: Apple's public search throttles a burst. */
const CATALOGUE_CONCURRENCY = 4

/** A cover's size in cells at one site. */
type CoverSize = { columns: number; rows: number }
/** The small cover beside the compact band. */
const COMPACT_COVER: CoverSize = { columns: 4, rows: 2 }
/** The cover inside the large band: tall enough for the title, artist, bar and controls beside it. */
const LARGE_COVER: CoverSize = { columns: 10, rows: 5 }
/** A cover beside each row of the Up next pane, with the title and artist on two lines. */
const QUEUE_COVER: CoverSize = { columns: 6, rows: 3 }
/** The cells a row's `gap={1}` leaves between a cover and the text beside it. */
const COVER_GAP_COLUMNS = 1
/** The large band's frame: a border cell and a padding cell at each side. */
const FRAME_COLUMNS = 4
const FRAME_ROWS = 2
/** The rows a large band takes: its cover and the frame; a terminal with fewer gets the compact band. */
const LARGE_BAND_ROWS = LARGE_COVER.rows + FRAME_ROWS
/** Narrower than this, the large band's rows would wrap, so the compact one is drawn. */
const LARGE_BAND_MIN_COLUMNS = 60
/** A progress bar shorter than this says nothing, so it is dropped. */
const MIN_BAR_WIDTH = 8
const BORDER_STYLE = 'round'
/** The cover of the track on, as `.src` (downloaded or exported), `.png` and `.bmp` files, named per track. */
const ARTWORK_FILE_STEM = 'claude-now-playing-cover'
/** A track without a player ID is named by title, artist and album, cut to keep the file name sane. */
const MAX_COVER_ID_LENGTH = 80
const COVERS_DIRECTORY = 'claude-now-playing-covers'
/** The side of the small square the cover is shrunk to for cell drawing: room for the largest cover's 10 by 10 pixels. */
const THUMBNAIL_PIXELS = 24
/** The dim rule drawn between the pane's search results and its queue. */

/** The footer label never grows past this many cells, whatever the width. */
const MAX_FOOTER_LABEL = 60
/** Nor past this share of the terminal, so the engine's own labels keep room. */
const FOOTER_LABEL_SHARE = 0.4
const DEFAULT_FOOTER_WIDTH = 40

/** How tall the Up next pane opens. */
const QUEUE_PANE_ROWS = 16
/** Cells the pane keeps clear at its right edge, so a row never touches the border. */
const PANE_MARGIN_COLUMNS = 4
const CLOSE_LABEL = 'close'
/** The limit behind the whole add section, said where someone might expect to add a song they do not own. */
const LIBRARY_ONLY_HINT = 'Only songs already in your Music library can be added; others open in Music, where you add them to your library first.'
/** The header's room for the playlist name: the width less the close button and the gap before it. */
const PANE_HEADER_RESERVED = plainButtonWidth(CLOSE_LABEL) + BUTTON_GAP
const REMOVE_LABEL = 'remove'
const PANE_REMOVE_RESERVED = plainButtonWidth(REMOVE_LABEL) + BUTTON_GAP

const SOURCE_COLOURS: Readonly<Record<PlayerSource, string>> = {
  spotify: '#1DB954',
  music: '#FC3C44',
}
const PLAYING_GLYPH = '▶'
const PAUSED_GLYPH = '❚❚'
const NOTE_GLYPH = '♪'
const SHUFFLE_GLYPH = '⇄'
const REPEAT_GLYPH = '↻'

type Placement = 'footer' | 'band' | 'both'
/** The framed band with a big cover, or the two-row one. */
type BandSize = 'large' | 'compact'

type Settings = {
  placement: Placement
  size: BandSize
  source: PlayerSource | 'auto'
  pollMs: number
  volumeStep: number
  showArtwork: boolean
  queueArtwork: boolean
  quietWhileWorking: boolean
  tellClaude: boolean
  /** Whether searches also ask Apple's catalogue, for tracks the library lacks. */
  catalogue: boolean
  playlistName: string
  preloadQueue: boolean
  /** Whether a helper listens for the players' own change notifications, so the band updates at once. */
  pushUpdates: boolean
}

/** What one load of the module carries between its hooks and timers. */
type Session = {
  settings: Settings
  /** True while a refresh is in flight, so timers never stack osascript runs. */
  isRefreshing: boolean
  /** Players that failed: why, when each may be asked again, and how long it was held for. */
  retryAfter: Map<PlayerSource, { until: number; failure: string; backoffMs: number }>
  pollTimer: Timer | null
  /** True on the terminal surface, where covers are drawn (as pictures or as cells). */
  isTerminal: boolean
  /** True when the terminal draws pictures (kitty graphics: kitty, Ghostty, WezTerm). */
  canDrawArtwork: boolean
  artworkDirectory: string
  /** Covers already exported, by persistent ID; null for a track without one. */
  coverCache: Map<string, Artwork | null>
  /** Bumped per queue so a cover run for an old queue stops. */
  coverRun: number
  /** Bumped per track change, so the cover of a track no longer on never lands. */
  artworkRun: number
  /** True while the queue is being read, so track changes never stack reads. */
  isReadingQueue: boolean
  /** True while the player-event helper runs and reports changes, so polling can relax. */
  hasListener: boolean
  /** A queue owed once the current read ends, for the track on then (null: the player stopped); null with none owed. */
  pendingQueue: { current: NowPlaying | null } | null
  /** The Apple Music storefront catalogue searches use (GB, US), from the Mac's locale. */
  storefront: string
  /** `$.clock.now()` when this load of the module started, so `/np version` can say how fresh it is. */
  loadedAt: number
}

function readSettings(options: PluginOptions): Settings {
  const placement = options.placement === 'footer' || options.placement === 'both' ? options.placement : 'band'
  const size: BandSize = options.size === 'compact' ? 'compact' : 'large'
  const source = options.source === 'music' || options.source === 'spotify' ? options.source : 'auto'
  const pollSeconds = clamp(Number(options.pollSeconds) || DEFAULT_POLL_SECONDS, MIN_POLL_SECONDS, MAX_POLL_SECONDS)
  const volumeStep = clamp(Number(options.volumeStep) || DEFAULT_VOLUME_STEP, 1, MAX_VOLUME_STEP)
  const playlistName = typeof options.playlistName === 'string' && options.playlistName.trim() !== '' ? options.playlistName.trim() : DEFAULT_PLAYLIST_NAME
  return {
    placement,
    size,
    source,
    pollMs: pollSeconds * MS_PER_SECOND,
    volumeStep,
    showArtwork: options.artwork !== false,
    queueArtwork: options.queueArtwork !== false,
    quietWhileWorking: options.quietWhileWorking !== false,
    tellClaude: options.tellClaude === true,
    catalogue: options.catalogue !== false,
    playlistName,
    preloadQueue: options.preloadQueue !== false,
    pushUpdates: options.pushUpdates !== false,
  }
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The fields a redraw cares about, as one string: equal keys mean nothing visible changed. */
function statusKey({ current, failure }: PlayerStatus): string {
  if (current === null) return JSON.stringify({ failure })
  const { source, state, trackId, title, artist, album, volume, shuffle, repeat } = current
  return JSON.stringify({
    failure,
    source,
    state,
    trackId,
    title,
    artist,
    album,
    volume,
    shuffle,
    repeat,
    position: Math.floor(current.positionSeconds),
    duration: Math.floor(current.durationSeconds),
  })
}

function isSameTrack(a: NowPlaying | null, b: NowPlaying | null): boolean {
  if (a === null || b === null) return a === b
  return a.source === b.source && a.trackId === b.trackId
}

/** The one dim label the footer shows: glyphs, track, and the clock when it fits. */
function footerLabel(current: NowPlaying, nowMs: number, columns: number | undefined): string {
  const width = columns === undefined ? DEFAULT_FOOTER_WIDTH : Math.min(MAX_FOOTER_LABEL, Math.floor(columns * FOOTER_LABEL_SHARE))
  const stateGlyph = current.state === 'playing' ? PLAYING_GLYPH : PAUSED_GLYPH
  const clock = ` ${formatClock(positionNow(current, nowMs))}/${formatClock(current.durationSeconds)}`
  const lead = `${NOTE_GLYPH} ${stateGlyph} `
  const track = trackLine(current)

  const roomWithClock = width - lead.length - clock.length
  if (roomWithClock >= MIN_TITLE_WIDTH) {
    return lead + truncateText(track, roomWithClock) + clock
  }
  return lead + truncateText(track, Math.max(MIN_TITLE_WIDTH, width - lead.length))
}

/** `⇄` while shuffling, `↻` or `↻1` while repeating; empty with neither. */
function modeGlyphs(current: NowPlaying): string {
  const parts: string[] = []
  if (current.shuffle) parts.push(SHUFFLE_GLYPH)
  if (current.repeat === 'all') parts.push(REPEAT_GLYPH)
  if (current.repeat === 'one') parts.push(`${REPEAT_GLYPH}1`)
  return parts.join(' ')
}

function describeTrack(current: NowPlaying, nowMs: number): string {
  return (
    `${displayName(current.source)} ${current.state}: ${trackLine(current)}` +
    ` (${formatClock(positionNow(current, nowMs))} / ${formatClock(current.durationSeconds)}, volume ${current.volume}%)`
  )
}

/** The text a copy puts on the clipboard: the share link, or the track's name. */
function shareText(current: NowPlaying): string {
  return current.shareUrl ?? trackLine(current)
}

/** `Title — Artist`, the line every list, toast and label names a track by. */
function trackLine(track: { title: string; artist: string }): string {
  return `${track.title} — ${track.artist}`
}

/** `Title — Artist · Album`, or just `Title — Artist` for a track without an album. */
function trackLineWithAlbum(track: { title: string; artist: string; album: string }): string {
  return track.album ? `${trackLine(track)} · ${track.album}` : trackLine(track)
}

/** A player that could not be read, and the one line saying why. */
type ReadFailure = { failure: string }

function isReadFailure(reading: NowPlaying | null | ReadFailure): reading is ReadFailure {
  return reading !== null && 'failure' in reading
}

/** Runs an AppleScript through osascript, bounded by `timeoutMs`. */
async function runScript($: EngineInterface, script: string, timeoutMs: number = SCRIPT_TIMEOUT_MS) {
  return $.process.run(osascriptArgv(script), { timeoutMs })
}

/** Runs a script and reads its reply with `parse`; null when the script failed. */
async function readScript<T>(
  $: EngineInterface,
  script: string,
  parse: (stdout: string) => T | null,
  timeoutMs: number = SCRIPT_TIMEOUT_MS,
): Promise<T | null> {
  const ran = await runScript($, script, timeoutMs)
  return ran.exitCode === 0 ? parse(ran.stdout) : null
}

async function readPlayer(
  $: EngineInterface,
  session: Session,
  source: PlayerSource,
  now: number,
): Promise<NowPlaying | null | ReadFailure> {
  const held = session.retryAfter.get(source)
  if (held !== undefined && held.until > now) return { failure: held.failure }
  try {
    const ran = await runScript($, statusScript(source))
    if (ran.exitCode !== 0) {
      return holdPlayer($, session, source, now, ran.stderr)
    }
    session.retryAfter.delete(source)
    return parseStatus(source, ran.stdout, now)
  } catch (error) {
    return holdPlayer($, session, source, now, errorText(error))
  }
}

/** Remembers a failed player so it is not asked again for a while: briefly when it was only slow. */
function holdPlayer($: EngineInterface, session: Session, source: PlayerSource, now: number, reason: string): ReadFailure {
  const failure = describeFailure(source, reason)
  const backoffMs = classifyFailure(reason) === 'timeout' ? TIMEOUT_BACKOFF_MS : FAILURE_BACKOFF_MS
  session.retryAfter.set(source, { until: now + backoffMs, failure, backoffMs })
  $.ui.log(`${displayName(source)} status failed: ${reason.trim()}`)
  return { failure }
}

/** The players open right now, as pgrep lists them. */
async function listRunningPlayers($: EngineInterface): Promise<PlayerSource[]> {
  const ran = await $.process.run(runningPlayersArgv(), { timeoutMs: SCRIPT_TIMEOUT_MS })
  return parseRunningPlayers(ran.stdout)
}

/** The running players the band follows, per the `source` setting. */
async function runningPlayers($: EngineInterface, session: Session): Promise<PlayerSource[]> {
  const running = await listRunningPlayers($)
  const wanted = session.settings.source
  return wanted === 'auto' ? running : running.filter(source => source === wanted)
}

async function isMusicRunning($: EngineInterface): Promise<boolean> {
  return (await listRunningPlayers($)).includes('music')
}

/** Asks the running players what is on and writes the band's status once it changed. */
async function refresh($: EngineInterface, session: Session): Promise<PlayerStatus> {
  const previous = await read($, status)
  if (session.isRefreshing) return previous
  session.isRefreshing = true
  try {
    const now = await $.clock.now()
    const sources = await runningPlayers($, session)
    const readings = await Promise.all(sources.map(source => readPlayer($, session, source, now)))

    const found = readings.filter((reading): reading is NowPlaying | null => !isReadFailure(reading))
    const firstFailure = readings.find(isReadFailure)
    const current = pickCurrent(found, previous.current?.source ?? null)
    const failure = current === null && firstFailure !== undefined ? firstFailure.failure : null
    const next: PlayerStatus = { current, failure }

    if (statusKey(previous) !== statusKey(next)) {
      await update($, status, () => next)
    }
    if (!isSameTrack(previous.current, current)) {
      void refreshArtwork($, session, current)
      void preloadQueue($, session, current)
      void refreshLyricsIfOpen($, session, current)
      if (current !== null) void recordListen($, current)
    }
    return next
  } catch (error) {
    $.ui.log(`refresh failed: ${errorText(error)}`)
    return previous
  } finally {
    session.isRefreshing = false
  }
}

/** How long to wait before the next poll: quick while playing, lazy otherwise. */
function nextPollDelay(session: Session, result: PlayerStatus, hidden: boolean): number {
  if (hidden) return HIDDEN_POLL_MS
  if (session.hasListener) {
    if (result.current?.state === 'playing') return Math.max(session.settings.pollMs, LISTENER_PLAYING_POLL_MS)
    if (result.current?.state === 'paused') return LISTENER_PAUSED_POLL_MS
  }
  if (result.current?.state === 'playing') return session.settings.pollMs
  if (result.current?.state === 'paused') return Math.max(session.settings.pollMs, PAUSED_POLL_MS)
  if (result.failure !== null) return shortestHold(session)
  return IDLE_POLL_MS
}

/** How soon a held player is worth asking again: the shortest hold in force. */
function shortestHold(session: Session): number {
  const holds = [...session.retryAfter.values()].map(held => held.backoffMs)
  return holds.length === 0 ? FAILURE_BACKOFF_MS : Math.min(...holds)
}

function schedulePoll($: EngineInterface, session: Session, delayMs: number): void {
  session.pollTimer?.cancel()
  session.pollTimer = $.clock.after(delayMs, () => void pollAndReschedule($, session))
}

/** Reads the players again shortly, once a command they were sent has taken effect. */
function refreshSoon($: EngineInterface, session: Session): void {
  $.clock.after(REFRESH_AFTER_CONTROL_MS, () => void refresh($, session))
}

async function pollAndReschedule($: EngineInterface, session: Session): Promise<void> {
  const hidden = await readHidden($)
  const result = hidden ? await read($, status) : await refresh($, session)
  schedulePoll($, session, nextPollDelay(session, result, hidden))
}

/** Once a second while a track plays and shows, so its clock and bar move between polls. */
async function tickProgress($: EngineInterface): Promise<void> {
  const [hidden, playerStatus] = await Promise.all([readHidden($), read($, status)])
  if (hidden || playerStatus.current?.state !== 'playing') return
  await update($, tick, count => count + 1)
}

/** Where a cover's fetched bytes, its PNG and its thumbnail BMP live. */
type CoverPaths = { source: string; png: string; bmp: string }

function coverPaths(directory: string, stem: string): CoverPaths {
  return { source: `${directory}/${stem}.src`, png: `${directory}/${stem}.png`, bmp: `${directory}/${stem}.bmp` }
}

/** Shrinks the PNG to a few pixels, for terminals without pictures; each site folds them into its own cells. */
async function readCoverThumbnail($: EngineInterface, paths: CoverPaths): Promise<Thumbnail | null> {
  try {
    const shrunk = await $.process.run(toThumbnailArgv(paths.png, paths.bmp, THUMBNAIL_PIXELS), { timeoutMs: SCRIPT_TIMEOUT_MS })
    if (shrunk.exitCode !== 0) return null
    const { base64 } = await $.fs.read(paths.bmp, { as: 'bytes' })
    return decodeBmp(bytesFromBase64(base64))
  } catch (error) {
    $.ui.log(`thumbnail failed: ${errorText(error)}`)
    return null
  }
}

/** The `Artwork` for the PNG at `paths`, with a small picture where the terminal cannot draw the PNG. */
async function artworkFrom($: EngineInterface, session: Session, trackId: string, paths: CoverPaths): Promise<Artwork> {
  const thumbnail = session.canDrawArtwork ? null : await readCoverThumbnail($, paths)
  const generation = Math.floor(await $.clock.now())
  return { trackId, path: paths.png, generation, thumbnail }
}

/**
 * Fetches the cover of the track on into a PNG and a thumbnail, or clears it.
 * Two quick track changes start two fetches; only the latest may publish.
 */
async function refreshArtwork($: EngineInterface, session: Session, current: NowPlaying | null): Promise<void> {
  const run = ++session.artworkRun
  const cover = await fetchCurrentCover($, session, current)
  if (run !== session.artworkRun) return
  await update($, artwork, () => cover)
}

/** A file name for a track's cover: the stem and its ID, with anything a path cannot hold replaced. */
function coverFileStem(trackId: string): string {
  const safeId = trackId.replace(/[^A-Za-z0-9]+/g, '-').slice(0, MAX_COVER_ID_LENGTH)
  return `${ARTWORK_FILE_STEM}-${safeId}`
}

/**
 * Makes sure the PNG at `paths` exists: one already there, from earlier in the
 * session or before a reload, is kept; otherwise `fetchSource` writes the
 * `.src` file and says whether it did, and sips converts it.
 */
async function ensureCoverPng($: EngineInterface, paths: CoverPaths, fetchSource: () => Promise<boolean>): Promise<boolean> {
  if (await $.fs.exists(paths.png)) return true
  if (!(await fetchSource())) return false
  const converted = await $.process.run(toPngArgv(paths.source, paths.png), { timeoutMs: SCRIPT_TIMEOUT_MS })
  return converted.exitCode === 0
}

/** Music exports the current track's cover to `path`; true when it wrote one. */
async function exportCurrentCover($: EngineInterface, path: string): Promise<boolean> {
  const exported = await runScript($, artworkExportScript(path))
  return exported.exitCode === 0 && exported.stdout.trim() !== ''
}

/** Downloads the cover at `url` to `path`; true when curl did. */
async function downloadCover($: EngineInterface, url: string, path: string): Promise<boolean> {
  const downloaded = await $.process.run(downloadArgv(url, path), { timeoutMs: SCRIPT_TIMEOUT_MS })
  return downloaded.exitCode === 0
}

/** The cover of the track on: Music exports it, Spotify names a URL to download; null without one. */
async function fetchCurrentCover($: EngineInterface, session: Session, current: NowPlaying | null): Promise<Artwork | null> {
  const wantsArtwork = session.settings.showArtwork && session.isTerminal && session.settings.placement !== 'footer'
  if (current === null || !wantsArtwork) return null
  const paths = coverPaths(session.artworkDirectory, coverFileStem(current.trackId))
  const { artworkUrl } = current
  const fetchSource =
    current.source === 'music'
      ? () => exportCurrentCover($, paths.source)
      : artworkUrl === null
        ? () => Promise.resolve(false)
        : () => downloadCover($, artworkUrl, paths.source)
  try {
    if (!(await ensureCoverPng($, paths, fetchSource))) return null
    return await artworkFrom($, session, current.trackId, paths)
  } catch (error) {
    $.ui.log(`artwork failed: ${errorText(error)}`)
    return null
  }
}

/** Reads Music's current playlist around the track on, for the queue pane. */
async function refreshQueue($: EngineInterface, session: Session, current: NowPlaying | null): Promise<Queue | null> {
  if (current === null) {
    await update($, queue, () => null)
    return null
  }
  if (current.source !== 'music') {
    const empty = emptyQueue(session, current, "Spotify's scripting has no queue, so Up next shows nothing. Controls still work; Up next, search and the playlist need Apple Music.")
    await update($, queue, () => empty)
    return empty
  }
  try {
    const next = await readMusicQueue($, session, current)
    await update($, queue, () => next)
    void fetchQueueCovers($, session, next.entries)
    return next
  } catch (error) {
    $.ui.log(`queue failed: ${errorText(error)}`)
    return null
  }
}

/** A queue with nothing to list and a line saying why. */
function emptyQueue(session: Session, current: NowPlaying, note: string, playlistName = ''): Queue {
  return {
    source: current.source,
    trackId: current.trackId,
    currentIndex: 0,
    playlistName,
    isModPlaylist: playlistName === session.settings.playlistName,
    note,
    entries: [],
  }
}

async function readMusicQueue($: EngineInterface, session: Session, current: NowPlaying): Promise<Queue> {
  const parsed = await readScript($, queueScript(), parseQueue)
  if (parsed === null) return emptyQueue(session, current, 'Music gave no playlist for this track.')
  if (parsed.entries.length === 0) return emptyQueue(session, current, 'Music gave no tracks around this one.', parsed.playlistName)
  // Music's index names the row on, which a song twice in one playlist needs;
  // the ID is the fallback when the index names no listed row.
  const byIndex = parsed.entries.find(entry => entry.index === parsed.currentIndex)
  const byId = parsed.entries.find(entry => entry.id === current.trackId)
  const currentEntry = byIndex ?? byId
  return {
    source: 'music',
    trackId: currentEntry?.id ?? current.trackId,
    currentIndex: currentEntry?.index ?? parsed.currentIndex,
    playlistName: parsed.playlistName,
    isModPlaylist: parsed.playlistName === session.settings.playlistName,
    note: null,
    entries: parsed.entries,
  }
}

/** Exports each queue track's cover in turn, publishing them as they land. */
async function fetchQueueCovers($: EngineInterface, session: Session, entries: readonly QueueEntry[]): Promise<void> {
  if (!session.isTerminal || !session.settings.queueArtwork) return
  const run = ++session.coverRun
  const directory = `${session.artworkDirectory}/${COVERS_DIRECTORY}`
  try {
    await $.process.run(['mkdir', '-p', directory], { timeoutMs: SCRIPT_TIMEOUT_MS })
    for (const entry of entries) {
      if (run !== session.coverRun) return
      if (entry.id === '') continue
      let cover = session.coverCache.get(entry.id)
      if (cover === undefined) {
        cover = await exportCoverById($, session, entry.id, directory)
        session.coverCache.set(entry.id, cover)
      }
      if (cover !== null) {
        const found = cover
        await update($, queueCovers, covers => (covers[entry.id] === undefined ? { ...covers, [entry.id]: found } : covers))
      }
    }
  } catch (error) {
    $.ui.log(`queue covers failed: ${errorText(error)}`)
  }
}

/** The cover of the library track with this persistent ID, exported by Music; null without one. */
async function exportCoverById($: EngineInterface, session: Session, id: string, directory: string): Promise<Artwork | null> {
  const paths = coverPaths(directory, id)
  const fetchSource = async () => {
    const exported = await runScript($, artworkByIdScript(id, paths.source))
    return exported.exitCode === 0 && exported.stdout.trim() === 'ok'
  }
  if (!(await ensureCoverPng($, paths, fetchSource))) return null
  return artworkFrom($, session, id, paths)
}

async function isQueueOpen($: EngineInterface): Promise<boolean> {
  const panes = await $.ui.panes()
  return panes.some(pane => pane.id === QUEUE_PANE)
}

async function refreshQueueIfOpen($: EngineInterface, session: Session, current: NowPlaying | null): Promise<void> {
  try {
    if (await isQueueOpen($)) await refreshQueue($, session, current)
  } catch (error) {
    $.ui.log(`queue check failed: ${errorText(error)}`)
  }
}

/**
 * Keeps the queue and its covers warm as tracks change, so the pane opens
 * with everything already fetched. One read runs at a time; a track that
 * changed meanwhile is read once the current read ends.
 */
async function preloadQueue($: EngineInterface, session: Session, current: NowPlaying | null): Promise<void> {
  if (!session.settings.preloadQueue) {
    await refreshQueueIfOpen($, session, current)
    return
  }
  if (session.isReadingQueue) {
    session.pendingQueue = { current }
    return
  }
  session.isReadingQueue = true
  try {
    let wanted = current
    while (true) {
      await refreshQueue($, session, wanted)
      const pending = session.pendingQueue
      session.pendingQueue = null
      if (pending === null || isSameTrack(pending.current, wanted)) break
      wanted = pending.current
    }
  } finally {
    session.isReadingQueue = false
  }
}

/** True when the queue in state already describes the track on. */
function isQueueFresh(list: Queue | null, current: NowPlaying | null): boolean {
  return list !== null && current !== null && list.source === current.source && list.trackId === current.trackId
}

/** Opens the queue pane, or closes it when it is already open. */
async function toggleQueue($: EngineInterface, session: Session, current: NowPlaying | null): Promise<string> {
  if (await isQueueOpen($)) {
    await closeQueue($)
    return 'Up next & playlist closed.'
  }
  return openQueue($, session, current)
}

async function openQueue($: EngineInterface, session: Session, current: NowPlaying | null): Promise<string> {
  // Preloaded data opens at once; anything stale is fetched first, the playlist count in the background.
  if (!isQueueFresh(await read($, queue), current)) {
    await refreshQueue($, session, current)
  }
  void refreshModPlaylist($, session)
  const opened = await $.ui.open({ id: QUEUE_PANE, title: 'Up next & playlist', rows: QUEUE_PANE_ROWS })
  if (!opened.isPlaced) {
    return 'Up next: widen the terminal to see the queue pane.'
  }
  return 'Up next & playlist opened. /np queue, the q control or ctrl+x x closes it.'
}

async function closeQueue($: EngineInterface): Promise<void> {
  try {
    await $.ui.close({ id: QUEUE_PANE })
  } catch (error) {
    $.ui.log(`queue close refused: ${errorText(error)}`)
  }
}

/** Makes sure the mod's playlist exists and records how many tracks it holds; null with Music off. */
async function refreshModPlaylist($: EngineInterface, session: Session): Promise<ModPlaylist | null> {
  try {
    const parsed = await readScript($, ensurePlaylistScript(session.settings.playlistName), parsePlaylist, SEARCH_TIMEOUT_MS)
    if (parsed === null) return null
    const playlist: ModPlaylist = { name: session.settings.playlistName, count: parsed.count, entries: parsed.entries }
    await update($, modPlaylist, () => playlist)
    return playlist
  } catch (error) {
    $.ui.log(`playlist check failed: ${errorText(error)}`)
    return null
  }
}

type LibraryMatches = { results: SearchResult[]; note: string | null }

/** Music's own ranked search of the library; the caller has seen that Music is running. */
async function runLibrarySearch($: EngineInterface, query: string, limit: number): Promise<LibraryMatches> {
  try {
    const ran = await runScript($, searchLibraryScript(query, limit), SEARCH_TIMEOUT_MS)
    if (ran.exitCode !== 0) return { results: [], note: describeFailure('music', ran.stderr) }
    return { results: parseSearch(ran.stdout), note: null }
  } catch (error) {
    return { results: [], note: `Music could not search: ${errorText(error)}` }
  }
}

/** Searches the Music library alone, saying so when Music is not running. */
async function searchLibraryOnly($: EngineInterface, query: string, limit: number): Promise<LibraryMatches> {
  if (!(await isMusicRunning($))) return { results: [], note: 'Music is not running, so the library cannot be searched.' }
  return runLibrarySearch($, query, limit)
}

/** Searches the Apple Music catalogue through Apple's public search API. */
async function searchCatalogue($: EngineInterface, session: Session, query: string, limit: number): Promise<SearchResult[]> {
  if (!session.settings.catalogue) return []
  try {
    const response = await $.http.fetch(catalogueSearchUrl(query, session.storefront, limit))
    if (!response.ok) {
      $.ui.log(`catalogue search answered ${response.status}`)
      return []
    }
    return parseCatalogue(response.text)
  } catch (error) {
    $.ui.log(`catalogue search failed: ${errorText(error)}`)
    return []
  }
}

type SearchOptions = { limit?: number; withLibrary?: boolean; withCatalogue?: boolean }

/** The line for a search that found nothing, naming where it looked. */
function nothingFoundNote(query: string, inLibrary: boolean, inCatalogue: boolean): string {
  if (inLibrary && inCatalogue) return `Nothing matches "${query}" in the library or on Apple Music.`
  if (inCatalogue) return `Nothing on Apple Music matches "${query}".`
  return `Nothing in the library matches "${query}".`
}

/**
 * Searches the library and the catalogue, either unless told not to, and
 * keeps the answer for the pane: library tracks to add, and catalogue tracks
 * the library lacks. A library that could not be searched says so in the
 * note whatever the catalogue found, so an empty library section is explained.
 */
async function searchMusic(
  $: EngineInterface,
  session: Session,
  query: string,
  { limit = MAX_SEARCH_RESULTS, withLibrary = true, withCatalogue = true }: SearchOptions = {},
): Promise<LibrarySearch> {
  const trimmed = query.trim()
  const finish = async (found: LibrarySearch): Promise<LibrarySearch> => {
    await update($, search, () => found)
    return found
  }
  if (trimmed === '') return finish({ query: trimmed, results: [], catalogue: [], note: null })

  const asksCatalogue = withCatalogue && session.settings.catalogue
  const [library, catalogue] = await Promise.all([
    withLibrary ? searchLibraryOnly($, trimmed, limit) : Promise.resolve<LibraryMatches>({ results: [], note: null }),
    asksCatalogue ? searchCatalogue($, session, trimmed, limit) : Promise.resolve([]),
  ])
  const unowned = withoutLibraryDuplicates(catalogue, library.results)
  const isEmpty = library.results.length === 0 && unowned.length === 0
  const note = library.note ?? (isEmpty ? nothingFoundNote(trimmed, withLibrary, asksCatalogue) : null)
  return finish({ query: trimmed, results: library.results, catalogue: unowned, note })
}

/** Opens a catalogue track's page in the Music app, where it can be played or added to the library. */
async function openInMusic($: EngineInterface, url: string): Promise<string> {
  if (!/^(music|https?):\/\/music\.apple\.com\//.test(url)) return `Not an Apple Music link: ${url}`
  try {
    await $.process.run(['open', musicAppUrl(url)], { timeoutMs: SCRIPT_TIMEOUT_MS })
    return 'Opened in Music. Press play there, or add it to your library and it becomes addable here.'
  } catch (error) {
    return `Could not open Music: ${errorText(error)}`
  }
}

/** Adds library tracks by ID to the mod's playlist, skipping ones already in it. */
async function addTracks($: EngineInterface, session: Session, ids: readonly string[]): Promise<AddOutcome | null> {
  const unique = [...new Set(ids.filter(id => id !== ''))].slice(0, MAX_TRACKS_PER_ADD)
  if (unique.length === 0) return { added: 0, skipped: 0, count: 0 }
  try {
    const outcome = await readScript($, addTracksScript(session.settings.playlistName, unique), parseAdded, SEARCH_TIMEOUT_MS)
    if (outcome !== null) {
      // The pane lists the playlist, so it learns of the new tracks at once.
      await refreshModPlaylist($, session)
    }
    return outcome
  } catch (error) {
    $.ui.log(`add failed: ${errorText(error)}`)
    return null
  }
}

/** Starts the mod's playlist from one of its tracks, pressed in the pane. */
async function playPlaylistTrack($: EngineInterface, session: Session, index: number): Promise<void> {
  try {
    await runScript($, playPlaylistTrackScript(session.settings.playlistName, index))
  } catch (error) {
    $.ui.toast(`Music did not start the track: ${errorText(error)}`)
  }
  refreshSoon($, session)
}

/** Whether the mod's playlist was started, and why not when it was not. */
type PlaylistStart = { started: true } | { started: false; failure: string | null }

/** Tells Music to play the mod's playlist from its first track; a refusal or error is the failure. */
async function startPlaylist($: EngineInterface, session: Session): Promise<string | null> {
  try {
    const ran = await runScript($, playPlaylistScript(session.settings.playlistName))
    if (ran.exitCode !== 0) return describeFailure('music', ran.stderr)
    return null
  } catch (error) {
    return `Music did not start the playlist: ${errorText(error)}`
  } finally {
    refreshSoon($, session)
  }
}

/** Starts the mod's playlist when nothing is playing, so added tracks are heard. */
async function startPlaylistIfIdle($: EngineInterface, session: Session): Promise<PlaylistStart> {
  const { current } = await refresh($, session)
  if (current !== null && current.state === 'playing') return { started: false, failure: null }
  const failure = await startPlaylist($, session)
  return failure === null ? { started: true } : { started: false, failure }
}

async function playModPlaylist($: EngineInterface, session: Session): Promise<string> {
  if (!(await isMusicRunning($))) return 'Music is not running.'
  const playlist = await refreshModPlaylist($, session)
  if (playlist === null) return `Could not read the "${session.settings.playlistName}" playlist.`
  if (playlist.count === 0) return `The "${playlist.name}" playlist is empty. Search in the Up next pane, or ask Claude to add songs.`
  const failure = await startPlaylist($, session)
  if (failure !== null) return failure
  return `Playing "${playlist.name}" (${playlist.count} tracks).`
}

/** Empties the mod's playlist and tells the pane, which lists it. */
async function clearModPlaylist($: EngineInterface, session: Session): Promise<string> {
  if (!(await isMusicRunning($))) return 'Music is not running.'
  const name = session.settings.playlistName
  let removed: number | null
  try {
    removed = await readScript($, clearPlaylistScript(name), parseCleared, SEARCH_TIMEOUT_MS)
  } catch (error) {
    return `Music could not clear "${name}": ${errorText(error)}`
  }
  if (removed === null) return `Could not clear the "${name}" playlist.`
  // Music keeps the track on but lists the library as its playlist from here,
  // and the band's refresh sees the same track, so the queue is read on purpose.
  const { current } = await refresh($, session)
  await Promise.all([refreshModPlaylist($, session), refreshQueue($, session, current)])
  if (removed === 0) return `"${name}" was already empty.`
  return `Removed ${removed} ${removed === 1 ? 'track' : 'tracks'} from "${name}". The tracks stay in your library.`
}

/** The mod's playlist as the pane, toasts and replies name it: "Claude Code playlist", unless its name says so already. */
function playlistLabel(session: Session): string {
  const name = session.settings.playlistName
  return /playlist$/i.test(name) ? name : `${name} playlist`
}

/** True while Music plays the mod's playlist, so a track added to it is also up next. */
async function isModPlaylistPlaying($: EngineInterface): Promise<boolean> {
  const list = await read($, queue)
  return list !== null && list.note === null && list.isModPlaylist
}

/** Adds one found track from the pane, and tells the person in a toast where it went. */
async function addResult($: EngineInterface, session: Session, result: SearchResult): Promise<void> {
  const label = playlistLabel(session)
  const outcome = await addTracks($, session, [result.id])
  if (outcome === null) {
    $.ui.toast(`Could not add ${result.title} to the ${label}.`)
    return
  }
  if (outcome.added === 0) {
    $.ui.toast(`Already in the ${label}: ${trackLine(result)}`)
    return
  }
  const start = await startPlaylistIfIdle($, session)
  const where = start.started ? ' · playing it now' : (await isModPlaylistPlaying($)) ? ' · up next' : ''
  $.ui.toast(`Added to the ${label}: ${trackLine(result)}${where}`)
  if (!start.started && start.failure !== null) $.ui.toast(start.failure)
  // A start is followed by a refresh that reads the queue anew; otherwise the pane is told now.
  if (!start.started) {
    const { current } = await read($, status)
    await refreshQueue($, session, current)
  }
}

/** Each request's best library match, or the catalogue's nearest offer for one the library lacks. */
type FoundRequests = {
  matched: { request: string; result: SearchResult }[]
  missing: { request: string; onAppleMusic: SearchResult | null }[]
}

/** Runs `task` over `items` a few at a time, keeping the results in order. */
async function inBatches<T, R>(items: readonly T[], size: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  for (let start = 0; start < items.length; start += size) {
    results.push(...(await Promise.all(items.slice(start, start + size).map(task))))
  }
  return results
}

/**
 * Looks every request up in one library script, then asks the catalogue
 * about the misses a few at a time, so a batch of fifty costs one osascript
 * launch and a short run of fetches rather than a hundred turns. A library
 * that could not be searched is a failure, not fifty tracks nobody owns.
 */
async function findRequests($: EngineInterface, session: Session, requests: readonly string[]): Promise<FoundRequests | { failure: string }> {
  const parts = requests.map(request => ({ request, ...splitTrackQuery(request) }))
  // Music's search ranks across fields, so the artist helps it find the track.
  const queries = parts.map(({ title, artist }) => (artist === null ? title : `${title} ${artist}`))
  const ran = await runScript($, searchLibraryManyScript(queries), BATCH_SEARCH_TIMEOUT_MS)
  if (ran.exitCode !== 0) return { failure: describeFailure('music', ran.stderr) }
  const results = parseSearchMany(ran.stdout, queries.length)

  const matched: FoundRequests['matched'] = []
  const unmatched: typeof parts = []
  parts.forEach((part, index) => {
    const best = pickBestMatch(results[index] ?? [], part.title, part.artist)
    if (best === null) unmatched.push(part)
    else matched.push({ request: part.request, result: best })
  })

  const missing = await inBatches(unmatched, CATALOGUE_CONCURRENCY, async ({ request, title, artist }) => {
    const offers = await searchCatalogue($, session, request, CATALOGUE_FALLBACK_LIMIT)
    return { request, onAppleMusic: pickBestMatch(offers, title, artist) }
  })
  return { matched, missing }
}

/**
 * What Claude's add_tracks tool does: each request (`Title — Artist` or just
 * a title) is searched in the library and its best match added; the summary
 * names what landed and what the library lacks.
 */
async function addByQueries($: EngineInterface, session: Session, queries: readonly string[], play: boolean): Promise<string> {
  const requests = queries.map(query => query.trim()).filter(query => query !== '').slice(0, MAX_TRACKS_PER_ADD)
  if (requests.length === 0) return 'No tracks were named.'
  if (!(await isMusicRunning($))) return 'Music is not running, so nothing could be added. Open Music and try again.'

  const found = await findRequests($, session, requests)
  if ('failure' in found) return `The library could not be searched, so nothing was added. ${found.failure}`
  const { matched, missing } = found

  // With no library match there is nothing to add, and no count to misreport.
  const outcome = matched.length === 0 ? null : await addTracks($, session, matched.map(match => match.result.id))
  const label = playlistLabel(session)
  const lines: string[] = []
  if (matched.length === 0) {
    lines.push(`None of the ${requests.length === 1 ? 'request' : 'requests'} matched a library track, so the ${label} is unchanged.`)
  } else if (outcome === null) {
    lines.push(`Music refused the additions to the ${label}.`)
  } else {
    lines.push(`Added ${outcome.added} track${outcome.added === 1 ? '' : 's'} to the ${label} (${outcome.skipped} already there; ${outcome.count} in it now).`)
    for (const match of matched) lines.push(`  + ${trackLineWithAlbum(match.result)}`)
    const start: PlaylistStart = play && outcome.added > 0 ? await startPlaylistIfIdle($, session) : { started: false, failure: null }
    if (start.started) lines.push(`Started playing the ${label}.`)
    else if (start.failure !== null) lines.push(`The playlist did not start: ${start.failure}`)
    else if (await isModPlaylistPlaying($)) lines.push(`The ${label} is what's playing, so they are up next.`)
    else lines.push(`They are in the playlist, not in Up next: /np playlist (or the pane's "play it") plays it.`)
  }
  if (missing.length > 0) {
    lines.push(`Not in the library (${missing.length}); only library tracks can go in a playlist. On Apple Music, each can be opened in Music with open_in_music or /np open <link>, and added to the library there, after which add_tracks or /np add can add it:`)
    for (const miss of missing) {
      lines.push(
        miss.onAppleMusic === null
          ? `  - ${miss.request}: not found on Apple Music either`
          : `  - ${miss.request}: ${trackLineWithAlbum(miss.onAppleMusic)} → ${miss.onAppleMusic.url ?? ''}`,
      )
    }
  }
  const { current } = await read($, status)
  void refreshQueueIfOpen($, session, current)
  return lines.join('\n')
}

async function control($: EngineInterface, session: Session, source: PlayerSource, command: PlayerCommand): Promise<void> {
  try {
    const ran = await runScript($, controlScript(source, command))
    if (ran.exitCode !== 0) {
      $.ui.toast(describeFailure(source, ran.stderr))
    }
  } catch (error) {
    $.ui.toast(`${displayName(source)} did not take the command: ${errorText(error)}`)
  }
  refreshSoon($, session)
}

/** Silences the player, or restores the volume it had before the last mute. */
async function toggleMute($: EngineInterface, session: Session, current: NowPlaying): Promise<string> {
  const remembered = await read($, mutedVolume)
  if (current.volume > 0) {
    await update($, mutedVolume, () => current.volume)
    await control($, session, current.source, { volume: 0 })
    return `${displayName(current.source)}: muted.`
  }
  const restored = remembered ?? UNMUTE_FALLBACK_VOLUME
  await update($, mutedVolume, () => null)
  await control($, session, current.source, { volume: restored })
  return `${displayName(current.source)}: volume ${restored}%.`
}

async function cycleRepeat($: EngineInterface, session: Session, current: NowPlaying): Promise<string> {
  const mode = nextRepeatMode(current.source, current.repeat)
  await control($, session, current.source, { repeat: mode })
  return `${displayName(current.source)}: repeat ${mode}.`
}

async function copyShare($: EngineInterface, current: NowPlaying, surface: RenderSurface | undefined): Promise<string> {
  const text = shareText(current)
  const copied = await $.ui.copy(surface === undefined ? { text } : { text, surface })
  const what = current.shareUrl === null ? 'track name' : 'link'
  const message = copied.isCopied ? `Copied the ${what}: ${text}` : `Could not copy (${copied.reason}): ${text}`
  $.ui.toast(message)
  return message
}

async function openPlayer($: EngineInterface, source: PlayerSource): Promise<string> {
  try {
    await $.process.run(openAppArgv(source), { timeoutMs: SCRIPT_TIMEOUT_MS })
    return `Opened ${displayName(source)}.`
  } catch (error) {
    return `Could not open ${displayName(source)}: ${errorText(error)}`
  }
}

/** Music searches its library by name and plays the first match. */
async function playByName($: EngineInterface, session: Session, query: string): Promise<string> {
  if (!(await isMusicRunning($))) {
    return "Playing by name needs Music running; Spotify's scripting cannot search."
  }
  try {
    const played = await readScript($, playByNameScript(query), parsePlayed, SEARCH_TIMEOUT_MS)
    refreshSoon($, session)
    if (played === null) return `Music has no track named like "${query}".`
    return `Music: playing ${trackLine(played)}.`
  } catch (error) {
    return `Music could not search: ${errorText(error)}`
  }
}

/** Keeps the track that just started in the listening history, once per listen. */
async function recordListen($: EngineInterface, current: NowPlaying): Promise<void> {
  try {
    const history = await readHistory($)
    const last = history[history.length - 1]
    const now = await $.clock.now()
    const isRepeat = last !== undefined && last.id === current.trackId && last.source === current.source && now - last.at < HISTORY_REPEAT_WINDOW_MS
    if (isRepeat) return
    const entry: HistoryEntry = { id: current.trackId, title: current.title, artist: current.artist, album: current.album, source: current.source, at: now }
    await $.store.set(STORE_HISTORY, [...history, entry].slice(-HISTORY_KEEP))
  } catch (error) {
    $.ui.log(`history write failed: ${errorText(error)}`)
  }
}

async function readHistory($: EngineInterface): Promise<HistoryEntry[]> {
  const stored = await $.store.get(STORE_HISTORY)
  return Array.isArray(stored) ? (stored as HistoryEntry[]) : []
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0')
}

/** `14:05` today, `03-10 14:05` on another day; local time. */
function formatListenTime(atMs: number, nowMs: number): string {
  const at = new Date(atMs)
  const now = new Date(nowMs)
  const clock = `${twoDigits(at.getHours())}:${twoDigits(at.getMinutes())}`
  const sameDay = at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate()
  return sameDay ? clock : `${twoDigits(at.getMonth() + 1)}-${twoDigits(at.getDate())} ${clock}`
}

/** The last `limit` listens, newest first, one per line. */
async function describeHistory($: EngineInterface, limit: number): Promise<string> {
  const history = await readHistory($)
  if (history.length === 0) return 'No listening history yet: it fills as tracks play while Claude Code is open.'
  const now = await $.clock.now()
  const shown = history.slice(-Math.max(1, Math.min(HISTORY_MAX_SHOWN, Math.floor(limit)))).reverse()
  const lines = shown.map(entry => `${formatListenTime(entry.at, now)}  ${trackLine(entry)}${entry.album ? ` · ${entry.album}` : ''} (${displayName(entry.source)}, id ${entry.id})`)
  return [`Last ${shown.length} of ${history.length} listens, newest first:`, ...lines].join('\n')
}

/** Reads the lyrics of the track on into state, with a line saying why when there are none. */
async function refreshLyrics($: EngineInterface, session: Session, current: NowPlaying | null): Promise<LyricsView | null> {
  const view = await (async (): Promise<LyricsView | null> => {
    if (current === null) return null
    if (current.source !== 'music') {
      return { id: current.trackId, title: current.title, artist: current.artist, text: '', note: "Spotify's scripting has no lyrics; this works with Apple Music." }
    }
    try {
      const read = await readScript($, lyricsScript(), parseLyrics, SEARCH_TIMEOUT_MS)
      if (read === null) return { id: current.trackId, title: current.title, artist: current.artist, text: '', note: 'Music gave no lyrics for this track.' }
      const note = read.text === '' ? "Music holds no lyrics for this track. Apple Music's own lyrics are not exposed to scripts; only lyrics stored with a library track show here." : null
      return { ...read, note }
    } catch (error) {
      return { id: current.trackId, title: current.title, artist: current.artist, text: '', note: `Music could not read the lyrics: ${errorText(error)}` }
    }
  })()
  await update($, lyrics, () => view)
  return view
}

async function isLyricsOpen($: EngineInterface): Promise<boolean> {
  const panes = await $.ui.panes()
  return panes.some(pane => pane.id === LYRICS_PANE)
}

async function refreshLyricsIfOpen($: EngineInterface, session: Session, current: NowPlaying | null): Promise<void> {
  try {
    if (await isLyricsOpen($)) await refreshLyrics($, session, current)
  } catch (error) {
    $.ui.log(`lyrics check failed: ${errorText(error)}`)
  }
}

/** Opens the lyrics pane for the track on, or closes it when open. */
async function toggleLyrics($: EngineInterface, session: Session, current: NowPlaying | null): Promise<string> {
  if (await isLyricsOpen($)) {
    await $.ui.close({ id: LYRICS_PANE })
    return 'Lyrics closed.'
  }
  const view = await refreshLyrics($, session, current)
  const opened = await $.ui.open({ id: LYRICS_PANE, title: 'Lyrics', rows: QUEUE_PANE_ROWS })
  if (!opened.isPlaced) return 'Lyrics: widen the terminal to see the pane.'
  if (view === null) return 'Lyrics opened; nothing is playing yet.'
  return view.note ?? `Lyrics opened for ${trackLine(view)}.`
}

/** The lyrics as text for Claude: the lines, or the reason there are none. */
async function lyricsText($: EngineInterface, session: Session, current: NowPlaying | null): Promise<string> {
  const view = await refreshLyrics($, session, current)
  if (view === null) return 'Nothing is playing, so there are no lyrics to read.'
  if (view.note !== null) return view.note
  return `Lyrics of ${trackLine(view)}:\n${view.text}`
}

/**
 * Runs the Swift helper that hears Music's and Spotify's own change
 * notifications and prints a line per change, so the band updates at once
 * instead of on the next poll. Needs Xcode's Swift; without it, polling
 * carries on as before. The child dies with the module.
 */
async function listenForPlayerEvents($: EngineInterface, session: Session, pluginRoot: string): Promise<void> {
  try {
    const swift = await $.process.run(['xcrun', '--find', 'swift'], { timeoutMs: SCRIPT_TIMEOUT_MS })
    if (swift.exitCode !== 0) return
  } catch {
    return
  }
  try {
    const events = $.process.spawn({ argv: ['swift', `${pluginRoot}/hooks/player-events.swift`] })
    for await (const piece of events) {
      if (piece.stream !== 'stdout') continue
      if (!session.hasListener) {
        session.hasListener = true
        continue
      }
      // A change: read the players now, and once more after they settle.
      void refresh($, session)
      refreshSoon($, session)
    }
  } catch (error) {
    $.ui.log(`player events stopped: ${errorText(error)}`)
  } finally {
    session.hasListener = false
  }
}

/** The filter Claude's tool asked for, from the call's loose input. */
function filterFrom(input: Record<string, unknown>): LibraryFilter {
  const text = (key: string) => (typeof input[key] === 'string' && (input[key] as string).trim() !== '' ? (input[key] as string) : undefined)
  const number = (key: string) => (typeof input[key] === 'number' && Number.isFinite(input[key]) ? (input[key] as number) : undefined)
  const filter: LibraryFilter = {}
  if (text('genre') !== undefined) filter.genre = text('genre')
  if (text('artist') !== undefined) filter.artist = text('artist')
  if (text('album') !== undefined) filter.album = text('album')
  if (text('title') !== undefined) filter.title = text('title')
  if (number('yearFrom') !== undefined) filter.yearFrom = number('yearFrom')
  if (number('yearTo') !== undefined) filter.yearTo = number('yearTo')
  if (number('minStars') !== undefined) filter.minStars = number('minStars')
  if (input.favourite === true) filter.favourite = true
  if (number('minPlays') !== undefined) filter.minPlays = number('minPlays')
  if (number('maxPlays') !== undefined) filter.maxPlays = number('maxPlays')
  if (number('notPlayedForDays') !== undefined) filter.notPlayedForDays = number('notPlayedForDays')
  return filter
}

const LIBRARY_SORTS: readonly LibrarySort[] = ['random', 'leastPlayed', 'mostPlayed', 'newest', 'oldest', 'topRated', 'title']

function sortFrom(value: unknown): LibrarySort | null {
  return LIBRARY_SORTS.find(sort => sort === value) ?? null
}

/**
 * Lists library songs by their facts rather than by Music's text search: the
 * filter runs in Music, a free-text `query` then narrows by title, artist or
 * album, and the sort and the limit are applied here.
 */
async function filterLibrary($: EngineInterface, filter: LibraryFilter, query: string, sort: LibrarySort, limit: number): Promise<string> {
  if (!(await isMusicRunning($))) return 'Music is not running, so the library cannot be filtered.'
  let tracks: LibraryTrack[] | null
  try {
    tracks = await readScript($, filterLibraryScript(filter), parseLibraryTracks, SEARCH_TIMEOUT_MS)
  } catch (error) {
    return `Music could not filter the library: ${errorText(error)}`
  }
  if (tracks === null) return 'Music could not answer the filter. A filter it does not know (favourite needs macOS 14 or later) or a very large match can do that; try a narrower one.'
  const wanted = normalise(query)
  const narrowed = wanted === '' ? tracks : tracks.filter(track => [track.title, track.artist, track.album].some(field => normalise(field).includes(wanted)))
  const picked = pickTracks(narrowed, sort, Math.min(MAX_FILTER_RESULTS, limit))
  const described = describeFilter(filter, query)
  if (picked.length === 0) return `No library song matches ${described}.`
  const lines = picked.map(track => {
    const facts = [track.year > 0 ? String(track.year) : null, track.genre || null, track.stars > 0 ? `${track.stars}★` : null, `${track.playCount} play${track.playCount === 1 ? '' : 's'}`]
    return `- ${trackLineWithAlbum(track)} [${facts.filter(fact => fact !== null).join(', ')}] (id ${track.id})`
  })
  return [`${narrowed.length} library song${narrowed.length === 1 ? '' : 's'} match ${described}; ${picked.length} shown, ${sort}. Add any with add_tracks ids:`, ...lines].join('\n')
}

function describeFilter(filter: LibraryFilter, query: string): string {
  const parts: string[] = []
  if (query.trim() !== '') parts.push(`"${query.trim()}"`)
  if (filter.genre !== undefined) parts.push(`genre ${filter.genre}`)
  if (filter.artist !== undefined) parts.push(`artist ${filter.artist}`)
  if (filter.album !== undefined) parts.push(`album ${filter.album}`)
  if (filter.title !== undefined) parts.push(`title ${filter.title}`)
  if (filter.yearFrom !== undefined || filter.yearTo !== undefined) parts.push(`years ${filter.yearFrom ?? '…'}–${filter.yearTo ?? '…'}`)
  if (filter.minStars !== undefined) parts.push(`${filter.minStars}★ or more`)
  if (filter.favourite) parts.push('favourites')
  if (filter.minPlays !== undefined) parts.push(`played ${filter.minPlays}+ times`)
  if (filter.maxPlays !== undefined) parts.push(`played at most ${filter.maxPlays} times`)
  if (filter.notPlayedForDays !== undefined) parts.push(`not played for ${filter.notPlayedForDays} days`)
  return parts.length === 0 ? 'the whole library' : parts.join(', ')
}

/** Takes tracks out of the mod's playlist by persistent ID; the library keeps them. */
async function removeTracks($: EngineInterface, session: Session, ids: readonly string[]): Promise<string> {
  const unique = [...new Set(ids.filter(id => id !== ''))]
  if (unique.length === 0) return 'No track ids were given.'
  if (!(await isMusicRunning($))) return 'Music is not running.'
  const label = playlistLabel(session)
  let remaining: number | null
  try {
    remaining = await readScript($, removeFromPlaylistScript(session.settings.playlistName, unique), parseCount, SEARCH_TIMEOUT_MS)
  } catch (error) {
    return `Music could not remove from the ${label}: ${errorText(error)}`
  }
  if (remaining === null) return `Could not change the ${label}.`
  const { current } = await refresh($, session)
  await Promise.all([refreshModPlaylist($, session), refreshQueue($, session, current)])
  return `Removed ${unique.length} track${unique.length === 1 ? '' : 's'} from the ${label}; ${remaining} left. The tracks stay in your library.`
}

/** Adds library tracks by persistent ID, as a filter or search listed them. */
async function addByIds($: EngineInterface, session: Session, ids: readonly string[], play: boolean): Promise<string> {
  if (!(await isMusicRunning($))) return 'Music is not running, so nothing could be added. Open Music and try again.'
  const label = playlistLabel(session)
  const outcome = await addTracks($, session, ids)
  if (outcome === null) return `Music refused the additions to the ${label}.`
  const lines = [`Added ${outcome.added} track${outcome.added === 1 ? '' : 's'} by id to the ${label} (${outcome.skipped} already there or unknown; ${outcome.count} in it now).`]
  const start: PlaylistStart = play && outcome.added > 0 ? await startPlaylistIfIdle($, session) : { started: false, failure: null }
  if (start.started) lines.push(`Started playing the ${label}.`)
  else if (start.failure !== null) lines.push(`The playlist did not start: ${start.failure}`)
  else if (await isModPlaylistPlaying($)) lines.push(`The ${label} is what's playing, so they are up next.`)
  else lines.push(`They are in the playlist, not in Up next: /np playlist (or the pane's "play it") plays it.`)
  return lines.join('\n')
}

/**
 * Answers a transport, volume or mode verb for the player on, for /np and
 * for Claude's control tool alike; null for a verb neither knows.
 */
async function controlVerb($: EngineInterface, session: Session, current: NowPlaying, verb: string, argument: string): Promise<string | null> {
  const player = displayName(current.source)
  switch (verb) {
    case 'status':
      return describeTrack(current, await $.clock.now())
    case 'play':
    case 'pause':
    case 'next':
      await control($, session, current.source, verb)
      return `${player}: ${verb}.`
    case 'prev':
    case 'previous':
      await control($, session, current.source, 'previous')
      return `${player}: previous track.`
    case 'toggle':
      await control($, session, current.source, 'playpause')
      return `${player}: ${current.state === 'playing' ? 'paused' : 'playing'}.`
    case 'vol':
    case 'volume': {
      const volume = volumeFromArgument(argument, current.volume, session.settings.volumeStep)
      if (volume === null) return 'Usage: /np vol <0-100>, /np vol +, or /np vol -'
      await control($, session, current.source, { volume })
      return `${player}: volume ${volume}%.`
    }
    case 'mute':
      return toggleMute($, session, current)
    case 'shuffle':
      await control($, session, current.source, 'toggleShuffle')
      return `${player}: shuffle ${current.shuffle ? 'off' : 'on'}.`
    case 'repeat':
      return cycleRepeat($, session, current)
    case 'copy':
      return copyShare($, current, undefined)
    case 'open':
      return openPlayer($, current.source)
    default:
      return null
  }
}

/** What Claude's status tool answers: the track on, what follows it, and the lyrics when asked. */
async function describeForClaude($: EngineInterface, session: Session, upNextCount: number, withLyrics: boolean): Promise<string> {
  const { current, failure } = await refresh($, session)
  if (current === null) return failure ?? 'Nothing is playing in Music or Spotify.'
  const lines = [describeTrack(current, await $.clock.now())]
  if (current.source === 'music' && upNextCount > 0) {
    const list = (await read($, queue)) ?? (await refreshQueue($, session, current))
    if (list !== null && list.note === null) {
      const following = list.entries.filter(entry => entry.index > list.currentIndex).slice(0, upNextCount)
      lines.push(`Playing from ${list.isModPlaylist ? `the ${playlistLabel(session)}` : `"${list.playlistName}"`}; up next: ${following.length === 0 ? 'nothing listed' : following.map(trackLine).join('; ')}.`)
    }
  }
  if (withLyrics) lines.push(await lyricsText($, session, current))
  return lines.join('\n')
}

/** Tells a first session, once, that the band exists and starts hidden. */
async function introduceOnce($: EngineInterface): Promise<void> {
  try {
    if ((await $.store.get(STORE_INTRODUCED)) === true) return
    await $.store.set(STORE_INTRODUCED, true)
    $.ui.toast('Now Playing is installed and hidden until asked: /np show reveals the band, /np queue opens Up next & playlist, or ask Claude.')
  } catch (error) {
    $.ui.log(`introduction skipped: ${errorText(error)}`)
  }
}

/** Hidden or shown: this session's choice, else the store's memory of a show, else hidden. */
async function readHidden($: EngineInterface): Promise<boolean> {
  const chosen = await read($, isHidden)
  if (chosen !== null) return chosen
  return (await $.store.get(STORE_SHOWN)) !== true
}

async function setHidden($: EngineInterface, hidden: boolean): Promise<void> {
  await update($, isHidden, () => hidden)
  await $.store.set(STORE_SHOWN, !hidden)
}

/** Shows or hides the band for a command or Claude's tool, reading the players at once when shown. */
async function setShown($: EngineInterface, session: Session, shown: boolean): Promise<string> {
  await setHidden($, !shown)
  if (!shown) return 'Now Playing hidden. /np show brings it back.'
  const { current, failure } = await refresh($, session)
  if (current !== null) return `Now Playing shown: ${describeTrack(current, await $.clock.now())}`
  return failure === null ? 'Now Playing shown. Nothing is playing in Music or Spotify yet.' : `Now Playing shown. ${failure}`
}

/** The volume `/np vol` asks for: a number, or a step up or down from now. */
function volumeFromArgument(argument: string, currentVolume: number, step: number): number | null {
  if (argument === '+' || argument === 'up') return clampVolume(currentVolume + step)
  if (argument === '-' || argument === 'down') return clampVolume(currentVolume - step)
  const value = Number.parseInt(argument, 10)
  return Number.isFinite(value) ? clampVolume(value) : null
}

/** Whether this terminal draws the kitty graphics protocol, which the Image element needs. */
async function detectArtworkSupport($: EngineInterface): Promise<boolean> {
  const [termProgram, term, kittyWindow] = await Promise.all([
    $.env.get('TERM_PROGRAM'),
    $.env.get('TERM'),
    $.env.get('KITTY_WINDOW_ID'),
  ])
  if (kittyWindow !== undefined) return true
  const program = (termProgram ?? '').toLowerCase()
  if (program === 'ghostty' || program === 'wezterm') return true
  const terminal = (term ?? '').toLowerCase()
  return terminal.includes('kitty') || terminal.includes('ghostty')
}

/** The Mac's locale names the Apple Music storefront to search (en_GB → GB). */
async function detectStorefront($: EngineInterface): Promise<string> {
  try {
    const ran = await $.process.run(['defaults', 'read', '-g', 'AppleLocale'], { timeoutMs: SCRIPT_TIMEOUT_MS })
    return ran.exitCode === 0 ? storefrontFrom(ran.stdout) : 'US'
  } catch {
    return 'US'
  }
}

/** Which build of the mod is running, from where, and how long ago it loaded. */
async function describeBuild($: EngineInterface, session: Session): Promise<string> {
  let version = 'unknown version'
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }
    if (typeof manifest.version === 'string') version = manifest.version
  } catch {
    // The manifest is optional here; the load time still says what matters.
  }
  const ageSeconds = Math.max(0, Math.round(((await $.clock.now()) - session.loadedAt) / MS_PER_SECOND))
  return `now-playing ${version}, loaded from ${$.plugin.root} ${ageSeconds}s ago.`
}

/** A cover as a picture where the terminal draws them, else as coloured cells; null with neither. */
function drawCover(elements: Elements['terminal'], session: Session, picture: Artwork, key: string, size: CoverSize) {
  const { Image, Raster } = elements
  if (session.canDrawArtwork) {
    return (
      <Image
        key={key}
        source={{ file: picture.path, format: 'png', generation: picture.generation }}
        columns={size.columns}
        rows={size.rows}
        alt=" "
      />
    )
  }
  if (picture.thumbnail === null) return null
  const cells = encodeCells(thumbnailCells(picture.thumbnail, size.columns, size.rows))
  return <Raster key={key} columns={size.columns} rows={size.rows} cells={cells} />
}

/** `Artist · Album`, or just the artist for a track without an album. */
function artistLine(track: { artist: string; album: string }): string {
  return track.album ? `${track.artist} · ${track.album}` : track.artist
}

/**
 * Which band to draw: the large one when asked for and the terminal has the
 * rows and columns for it; a shorter or narrower one gets the compact band.
 */
function bandSizeFor(session: Session, maxRows: number, bodyColumns: number): BandSize {
  if (session.settings.size === 'compact') return 'compact'
  return maxRows >= LARGE_BAND_ROWS && bodyColumns >= LARGE_BAND_MIN_COLUMNS ? 'large' : 'compact'
}

/** One control of the band's toolbar. */
type Control = {
  key: string
  hotkey: string
  label: string
  /** Lower survives a narrower band. */
  priority: number
  /** True for a secondary control, drawn dim until the pointer is over the band. */
  isSecondary: boolean
  onPress: (surface: RenderSurface) => void
}

/**
 * The band's controls: transport bright, the rest dim until hovered, and a
 * shuffle or repeat that is on drawn bright with its state in the label.
 */
function bandControls($: EngineInterface, session: Session, current: NowPlaying, size: BandSize): Control[] {
  const step = session.settings.volumeStep
  const isPlaying = current.state === 'playing'
  const act = (command: PlayerCommand) => () => void control($, session, current.source, command)
  const controls: Control[] = [
    { key: 'previous', hotkey: 'b', label: 'prev', priority: 2, isSecondary: false, onPress: act('previous') },
    { key: 'playpause', hotkey: 'p', label: isPlaying ? 'pause' : 'play', priority: 0, isSecondary: false, onPress: act('playpause') },
    { key: 'next', hotkey: 'n', label: 'next', priority: 1, isSecondary: false, onPress: act('next') },
    { key: 'volume-down', hotkey: 'd', label: 'vol-', priority: 4, isSecondary: true, onPress: act({ volume: current.volume - step }) },
    { key: 'volume-up', hotkey: 'u', label: 'vol+', priority: 5, isSecondary: true, onPress: act({ volume: current.volume + step }) },
    { key: 'mute', hotkey: 'm', label: current.volume === 0 ? 'unmute' : 'mute', priority: 6, isSecondary: current.volume !== 0, onPress: () => void toggleMute($, session, current) },
    { key: 'shuffle', hotkey: 's', label: current.shuffle ? 'shuffle on' : 'shuffle', priority: 8, isSecondary: !current.shuffle, onPress: act('toggleShuffle') },
    { key: 'repeat', hotkey: 'r', label: current.repeat === 'off' ? 'repeat' : `repeat ${current.repeat}`, priority: 9, isSecondary: current.repeat === 'off', onPress: () => void cycleRepeat($, session, current) },
    { key: 'copy', hotkey: 'c', label: 'copy', priority: 7, isSecondary: true, onPress: surface => void copyShare($, current, surface) },
    { key: 'queue', hotkey: 'q', label: 'queue', priority: 10, isSecondary: true, onPress: () => void toggleQueue($, session, current) },
    { key: 'hide', hotkey: 'x', label: 'hide', priority: 3, isSecondary: true, onPress: () => void setHidden($, true) },
  ]
  // The compact band's title is the button that opens the player; the large band's title is bold text, so it gets a control.
  if (size === 'large') {
    controls.push({ key: 'open', hotkey: 'o', label: 'open', priority: 11, isSecondary: true, onPress: () => void openPlayer($, current.source) })
  }
  return controls
}

/** Reads the `tracks` a tool call names: a list of strings, or one string. */
function requestedTracks(input: unknown): string[] {
  if (Array.isArray(input)) return input.filter((item): item is string => typeof item === 'string')
  if (typeof input === 'string') return [input]
  return []
}

async function registerTools($: EngineInterface, session: Session): Promise<void> {
  await $.tool.register({
    name: 'search_library',
    description:
      "Search the person's Apple Music library and the Apple Music catalogue by title, artist or album, or filter the library by its facts. " +
      'With only a query, Music ranks text matches; library matches can be added with add_tracks and catalogue matches come with a link that ' +
      'open_in_music opens in the Music app. With any filter (genre, artist, album, title, yearFrom, yearTo, minStars, favourite, minPlays, ' +
      'maxPlays, notPlayedForDays) or a sort, the library alone is listed by those facts, each result with its year, genre, stars, play count ' +
      'and id, which add_tracks takes as ids. That is how to build a playlist by mood: "90s hip hop I have not played in a year" is ' +
      'genre "Hip", yearFrom 1990, yearTo 1999, notPlayedForDays 365, sort random. Only songs in the library can be filtered or added.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to look for in titles, artists and albums; with filters, narrows their matches.' },
        limit: { type: 'integer', description: `How many matches to return from each source, at most ${MAX_SEARCH_RESULTS}; filters allow ${MAX_FILTER_RESULTS}.` },
        scope: { type: 'string', enum: ['both', 'library', 'catalogue'], description: 'Where a text search looks. Default both. Filters are library only.' },
        genre: { type: 'string', description: 'Filter: the genre contains this (Jazz, Hip, Electronic).' },
        artist: { type: 'string', description: 'Filter: the artist contains this.' },
        album: { type: 'string', description: 'Filter: the album contains this.' },
        title: { type: 'string', description: 'Filter: the title contains this.' },
        yearFrom: { type: 'integer', description: 'Filter: released in this year or later.' },
        yearTo: { type: 'integer', description: 'Filter: released in this year or earlier.' },
        minStars: { type: 'integer', description: 'Filter: rated this many stars (1 to 5) or more.' },
        favourite: { type: 'boolean', description: 'Filter: only favourites (the heart in Music).' },
        minPlays: { type: 'integer', description: 'Filter: played at least this many times.' },
        maxPlays: { type: 'integer', description: 'Filter: played at most this many times; 0 for never played.' },
        notPlayedForDays: { type: 'integer', description: 'Filter: not played for this many days, never-played songs included.' },
        sort: { type: 'string', enum: [...LIBRARY_SORTS], description: 'Order of filtered results. Default random.' },
      },
    },
  })
  await $.tool.register({
    name: 'open_in_music',
    description:
      'Open an Apple Music track, album or artist link in the Music app, for a track the library lacks: the person can play it there ' +
      'or add it to their library, after which add_tracks can add it to the playlist. Takes the link search_library or add_tracks gave.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'A music.apple.com link (music:// or https://).' },
      },
      required: ['url'],
    },
  })
  await $.tool.register({
    name: 'add_tracks',
    description:
      `Add songs from the person's Apple Music library to the "${session.settings.playlistName}" playlist that the Now Playing mod plays from ` +
      '(Music\'s own Up Next cannot be scripted). Give each track as "Title — Artist" or just a title; each is searched in the ' +
      'library and its best match added, duplicates skipped. Only tracks already in the library can go in a playlist: for each one ' +
      'not found, the result gives its Apple Music link when the catalogue has it, so tell the person and offer to open it with ' +
      'open_in_music. When asked for a kind of music (10 great jazz tracks), name specific well-known songs; use search_library ' +
      'first if you want to check what they own. Apple Music only: Spotify\'s scripting can neither search nor add, so with Spotify ' +
      'playing this still adds to the Music playlist.',
    inputSchema: {
      type: 'object',
      properties: {
        tracks: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tracks to add, each "Title — Artist" or a title.',
        },
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Library track ids from search_library, added as they are, no search needed.',
        },
        play: {
          type: 'boolean',
          description: 'Start the playlist if nothing is playing. Default true.',
        },
      },
    },
  })
  await $.tool.register({
    name: 'remove_tracks',
    description: `Take tracks out of the "${session.settings.playlistName}" playlist by the ids search_library, now_playing or listening_history gave. The songs stay in the library.`,
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'Library track ids to remove from the playlist.' },
      },
      required: ['ids'],
    },
  })
  await $.tool.register({
    name: 'clear_playlist',
    description: `Empty the "${session.settings.playlistName}" playlist. The playlist stays, and so do the songs in the library. Ask the person first unless they asked for it.`,
    inputSchema: { type: 'object', properties: {} },
  })
  await $.tool.register({
    name: 'control_player',
    description:
      'Control the player that is on (Apple Music or Spotify): play, pause, toggle, next, previous, volume (with volume 0-100 or nudge up/down), ' +
      'mute, shuffle, repeat (cycles off, all, one), or playlist, which starts the mod\'s playlist in Music. Use it when the person asks to ' +
      'skip, pause, turn it up or down, or play their playlist.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['play', 'pause', 'toggle', 'next', 'previous', 'volume', 'mute', 'shuffle', 'repeat', 'playlist'] },
        volume: { type: 'integer', description: 'With action volume: the level, 0 to 100.' },
        nudge: { type: 'string', enum: ['up', 'down'], description: 'With action volume: one step up or down instead of a level.' },
      },
      required: ['action'],
    },
  })
  await $.tool.register({
    name: 'now_playing',
    description:
      'What is playing right now: the player, track, position and volume, what Music lists as up next, and, when asked, the lyrics ' +
      'Music holds for the track (Apple Music only; its streamed lyrics are not exposed to scripts). Use it for "what is this song", ' +
      '"what is coming up" or "what are the lyrics".',
    inputSchema: {
      type: 'object',
      properties: {
        upNext: { type: 'integer', description: `How many following tracks to list. Default ${DEFAULT_UP_NEXT_SHOWN}; 0 for none.` },
        lyrics: { type: 'boolean', description: 'Also read the lyrics. Default false.' },
      },
    },
  })
  await $.tool.register({
    name: 'listening_history',
    description:
      'The tracks heard while Claude Code was open, newest first, with the time and the player. Use it for "what was that song earlier", ' +
      "\"what did I listen to today\" or to build a playlist from a session's music; each line carries the id add_tracks takes.",
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: `How many listens to return. Default 20, at most ${HISTORY_MAX_SHOWN}.` },
      },
    },
  })
  await $.tool.register({
    name: 'show_now_playing',
    description:
      'Show or hide the Now Playing band above the prompt: the track playing in Apple Music or Spotify with cover art and ' +
      'controls. It starts hidden, so use this when the person asks to see what is playing, to show the music player or ' +
      'now playing, or to hide it again. The choice is remembered across sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        shown: { type: 'boolean', description: 'true shows the band, false hides it. Default true.' },
      },
    },
  })
}

export const register: Register = (on, options) => {
  const session: Session = {
    settings: readSettings(options),
    isRefreshing: false,
    retryAfter: new Map(),
    pollTimer: null,
    isTerminal: false,
    canDrawArtwork: false,
    artworkDirectory: '/tmp',
    coverCache: new Map(),
    coverRun: 0,
    artworkRun: 0,
    storefront: 'US',
    loadedAt: 0,
    isReadingQueue: false,
    pendingQueue: null,
    hasListener: false,
  }

  on('session.start', async ($, e, next) => {
    const [loadedAt, storedShown] = await Promise.all([
      $.clock.now(),
      $.store.get(STORE_SHOWN),
      $.command.register({
        name: COMMAND,
        description: 'Now playing in Music or Spotify: play [name], pause, next, prev, vol, mute, shuffle, repeat, copy, open, queue, search, add, playlist, clear, hide, show.',
        argumentHint: '[play [name]|pause|next|prev|vol <0-100|+|->|mute|shuffle|repeat|copy|open|queue|search <text>|add <title — artist>|playlist|clear|version|show|hide]',
        immediate: true,
      }),
      registerTools($, session),
    ])
    session.loadedAt = loadedAt
    // Decided once here, so no later read asks the store.
    await update($, isHidden, () => storedShown !== true)

    const drawsBand = e.surface === 'terminal' || e.surface === 'desktop'
    if (e.isInteractive && drawsBand) {
      session.isTerminal = e.surface === 'terminal'
      const [drawsPictures, tmpdir] = await Promise.all([
        session.isTerminal ? detectArtworkSupport($) : Promise.resolve(false),
        $.env.get('TMPDIR'),
      ])
      session.canDrawArtwork = drawsPictures
      session.artworkDirectory = (tmpdir ?? '/tmp').replace(/\/+$/, '')
      // Only a catalogue search needs the storefront, so startup does not wait for it.
      void detectStorefront($).then(storefront => {
        session.storefront = storefront
      })
      void pollAndReschedule($, session)
      $.clock.every(TICK_MS, () => void tickProgress($))
      if (session.settings.pushUpdates && typeof options.root === 'string') void listenForPlayerEvents($, session, options.root)
      void introduceOnce($)
    }

    return next(e)
  })

  on('tool.call', { tool: TOOL_SEARCH }, async ($, e) => {
    const query = typeof e.query === 'string' ? e.query : ''
    const scope = e.scope === 'library' || e.scope === 'catalogue' ? e.scope : 'both'
    const filter = filterFrom(e)
    const sort = sortFrom(e.sort)
    if (Object.keys(filter).length > 0 || sort !== null) {
      const limit = typeof e.limit === 'number' ? e.limit : MAX_SEARCH_RESULTS
      return { result: await filterLibrary($, filter, query, sort ?? 'random', limit) }
    }
    const limit = typeof e.limit === 'number' ? e.limit : MAX_SEARCH_RESULTS
    if (query.trim() === '') return { result: 'Give a query to search for, or a filter such as genre, yearFrom, minStars or notPlayedForDays.' }
    const found = await searchMusic($, session, query, { limit, withLibrary: scope !== 'catalogue', withCatalogue: scope !== 'library' })
    const isEmpty = found.results.length === 0 && found.catalogue.length === 0
    if (found.note !== null && isEmpty) return { result: found.note }
    const lines: string[] = []
    if (found.note !== null) lines.push(found.note)
    if (scope !== 'catalogue') {
      lines.push(`In the library (${found.results.length}), addable with add_tracks:`)
      for (const result of found.results) lines.push(`- ${trackLineWithAlbum(result)} (id ${result.id})`)
    }
    if (scope !== 'library') {
      lines.push(`On Apple Music but not in the library (${found.catalogue.length}), openable with open_in_music:`)
      for (const result of found.catalogue) lines.push(`- ${trackLineWithAlbum(result)} → ${result.url ?? ''}`)
    }
    return { result: `Results for "${found.query}":\n${lines.join('\n')}` }
  })

  on('tool.call', { tool: TOOL_OPEN }, async ($, e) => {
    const url = typeof e.url === 'string' ? e.url.trim() : ''
    if (url === '') return { result: 'Give an Apple Music link to open.' }
    return { result: await openInMusic($, url) }
  })

  on('tool.call', { tool: TOOL_SHOW }, async ($, e) => {
    return { result: await setShown($, session, e.shown !== false) }
  })

  on('tool.call', { tool: TOOL_ADD }, async ($, e) => {
    const tracks = requestedTracks(e.tracks)
    const ids = Array.isArray(e.ids) ? e.ids.filter((id): id is string => typeof id === 'string' && id.trim() !== '') : []
    const play = e.play !== false
    if (tracks.length === 0 && ids.length === 0) return { result: 'Name tracks ("Title — Artist") or give ids from search_library.' }
    const parts: string[] = []
    if (ids.length > 0) parts.push(await addByIds($, session, ids, play))
    if (tracks.length > 0) parts.push(await addByQueries($, session, tracks, play))
    return { result: parts.join('\n') }
  })

  on('tool.call', { tool: TOOL_REMOVE }, async ($, e) => {
    const ids = Array.isArray(e.ids) ? e.ids.filter((id): id is string => typeof id === 'string') : []
    return { result: await removeTracks($, session, ids) }
  })

  on('tool.call', { tool: TOOL_CLEAR }, async ($) => {
    return { result: await clearModPlaylist($, session) }
  })

  on('tool.call', { tool: TOOL_CONTROL }, async ($, e) => {
    const action = typeof e.action === 'string' ? e.action : ''
    if (action === 'playlist') return { result: await playModPlaylist($, session) }
    const { current, failure } = await refresh($, session)
    if (current === null) {
      return { result: `${failure ?? 'Nothing is playing in Music or Spotify.'} To start music, use action playlist, or add_tracks with play.` }
    }
    const argument = action === 'volume' ? (e.nudge === 'up' ? '+' : e.nudge === 'down' ? '-' : typeof e.volume === 'number' ? String(e.volume) : '') : ''
    const answered = await controlVerb($, session, current, action, argument)
    return { result: answered ?? `Unknown action: ${action}.` }
  })

  on('tool.call', { tool: TOOL_STATUS }, async ($, e) => {
    const upNext = typeof e.upNext === 'number' ? Math.max(0, Math.floor(e.upNext)) : DEFAULT_UP_NEXT_SHOWN
    return { result: await describeForClaude($, session, upNext, e.lyrics === true) }
  })

  on('tool.call', { tool: TOOL_HISTORY }, async ($, e) => {
    const limit = typeof e.limit === 'number' ? e.limit : 20
    return { result: await describeHistory($, limit) }
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(word => word.length > 0)
    const [verb = 'status', ...restWords] = words
    const argument = restWords.join(' ')

    if (verb === 'version') {
      return { text: await describeBuild($, session) }
    }
    if (verb === 'hide' || verb === 'show') {
      return { text: await setShown($, session, verb === 'show') }
    }
    if (verb === 'play' && argument !== '') {
      return { text: await playByName($, session, argument) }
    }
    if (verb === 'add') {
      if (argument === '') return { text: 'Usage: /np add <title — artist>' }
      return { text: await addByQueries($, session, [argument], true) }
    }
    if (verb === 'playlist') {
      return { text: await playModPlaylist($, session) }
    }
    if (verb === 'clear') {
      return { text: await clearModPlaylist($, session) }
    }
    if (verb === 'history') {
      return { text: await describeHistory($, Number.parseInt(argument, 10) || HISTORY_DEFAULT_SHOWN) }
    }

    const { current, failure } = await refresh($, session)
    if (verb === 'search') {
      const found = await searchMusic($, session, argument)
      const opened = await openQueue($, session, current)
      const isEmpty = found.results.length === 0 && found.catalogue.length === 0
      if (found.note !== null && isEmpty) return { text: found.note }
      const counted = `"${found.query}": ${found.results.length} in your library, ${found.catalogue.length} more on Apple Music, in the Up next pane.`
      return { text: found.note === null ? `${counted} ${opened}` : `${found.note} ${counted} ${opened}` }
    }
    if (verb === 'open' && argument.includes('music.apple.com')) {
      return { text: await openInMusic($, argument) }
    }
    if (verb === 'queue' || verb === 'upnext') {
      return { text: await toggleQueue($, session, current) }
    }
    if (verb === 'lyrics') {
      return { text: await toggleLyrics($, session, current) }
    }
    if (current === null) {
      return { text: failure ?? 'Nothing is playing in Music or Spotify.' }
    }
    const answered = await controlVerb($, session, current, verb, argument)
    return {
      text:
        answered ??
        `Unknown: ${verb}. Try /np play [name], pause, next, prev, vol, mute, shuffle, repeat, copy, open, queue, lyrics, search <text>, add <track>, playlist, clear, history, show or hide.`,
    }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!session.settings.tellClaude) return composed
    const { current } = await read($, status)
    if (current === null) return composed
    const text =
      `The person is listening to "${current.title}" by ${current.artist}` +
      `${current.album ? ` (from ${current.album})` : ''} in ${displayName(current.source)} right now` +
      `${current.state === 'paused' ? ', paused' : ''}. Mention it only if they bring up music.`
    return { sections: [...composed.sections, { id: 'now-playing:track', text, scope: 'session' }] }
  })

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (session.settings.placement === 'band') return next(e)

    const [hidden, playerStatus] = await Promise.all([readHidden($), read($, status), read($, tick)])
    if (hidden || playerStatus.current === null) return next(e)

    const label = footerLabel(playerStatus.current, await $.clock.now(), e.viewport?.columns)
    return next({ ...e, props: { ...e.props, modes: [...e.props.modes, label] } })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    // The band carries the controls; in footer placement only a failure, which
    // needs acting on, earns a row above the prompt, and that row has no cover or clock.
    const isFooter = session.settings.placement === 'footer'
    const [hidden, playerStatus, cover] = await Promise.all([
      readHidden($),
      read($, status),
      isFooter ? null : read($, artwork),
      isFooter ? null : read($, tick),
    ])
    if (hidden) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const { current, failure } = playerStatus
    if (current !== null && isFooter) return next(e)

    if (current === null) {
      if (failure === null) return next(e)
      return (
        <Box flexDirection="row" gap={1}>
          <Text dimColor>{NOTE_GLYPH}</Text>
          <Text dimColor wrap="truncate-end">
            {failure}
          </Text>
          <Button key="hide" plain hotkey="x" label="hide" dimColor onPress={() => void setHidden($, true)} />
        </Box>
      )
    }

    const now = await $.clock.now()
    const isQuiet = e.props.isWorking && session.settings.quietWhileWorking
    const size = isQuiet ? 'compact' : bandSizeFor(session, e.props.maxRows, e.props.bodyColumns)
    const coverSize = size === 'large' ? LARGE_COVER : COMPACT_COVER

    const showsCover = !isQuiet && cover !== null && cover.trackId === current.trackId
    const coverElement = showsCover && e.surface === 'terminal' ? drawCover($.ui.resolve(e), session, cover, 'cover', coverSize) : null
    const hasCover = coverElement !== null
    const frameColumns = size === 'large' ? FRAME_COLUMNS : 0
    const bodyColumns = e.props.bodyColumns - frameColumns - (hasCover ? coverSize.columns + COVER_GAP_COLUMNS : 0)
    const isPlaying = current.state === 'playing'
    const stateGlyph = isPlaying ? PLAYING_GLYPH : PAUSED_GLYPH
    const position = positionNow(current, now)
    const clock = `${formatClock(position)}/${formatClock(current.durationSeconds)}`
    const volumeText = `${current.volume}%`
    const modes = modeGlyphs(current)
    const colour = SOURCE_COLOURS[current.source]

    const controlsRow = (controls: readonly Control[]) => (
      <Box flexDirection="row" gap={1}>
        {fitControls(controls, bodyColumns).map(button => (
          <Button
            key={button.key}
            plain
            hotkey={button.hotkey}
            label={button.label}
            dimColor={button.isSecondary}
            hover={{ dimColor: false }}
            onPress={press => button.onPress(press.surface)}
          />
        ))}
      </Box>
    )

    if (size === 'large') {
      // Title, artist and album, then the bar with its figures, each on a row of its own beside the cover.
      const titleText = truncateText(current.title, bodyColumns - cellWidth(stateGlyph) - 1)
      const figures = [clock, volumeText, modes].filter(text => text !== '')
      const figuresWidth = figures.reduce((total, text) => total + cellWidth(text) + 1, 0)
      const barWidth = bodyColumns - figuresWidth
      const bar = progressBar(position, current.durationSeconds, barWidth)
      return (
        <Box key="band" flexDirection="row" gap={1} borderStyle={BORDER_STYLE} borderColor={colour} paddingX={1}>
          {coverElement}
          <Box flexDirection="column" flexGrow={1}>
            <Box flexDirection="row" gap={1}>
              <Text color={colour} bold={isPlaying} dimColor={!isPlaying}>
                {stateGlyph}
              </Text>
              <Text bold>{titleText}</Text>
            </Box>
            <Text dimColor>{truncateText(artistLine(current), bodyColumns)}</Text>
            <Box flexDirection="row" gap={1}>
              {barWidth >= MIN_BAR_WIDTH && (
                <Text>
                  <Text color={colour}>{bar.played}</Text>
                  <Text dimColor>{bar.remaining}</Text>
                </Text>
              )}
              <Text dimColor>{clock}</Text>
              <Text dimColor>{volumeText}</Text>
              {modes !== '' && <Text color={colour}>{modes}</Text>}
            </Box>
            <Box flexGrow={1} />
            {controlsRow(bandControls($, session, current, size))}
          </Box>
        </Box>
      )
    }

    const layout = layoutFor(bodyColumns)
    const bar = progressBar(position, current.durationSeconds, layout.barWidth)
    const fixedParts = [
      cellWidth(NOTE_GLYPH),
      cellWidth(stateGlyph),
      layout.showBar ? layout.barWidth : 0,
      layout.showClock ? cellWidth(clock) : 0,
      layout.showVolume ? cellWidth(volumeText) : 0,
      cellWidth(modes),
    ].filter(width => width > 0)
    const reserved = fixedParts.reduce((total, width) => total + width, 0) + fixedParts.length + 1
    const titleWidth = Math.max(MIN_TITLE_WIDTH, bodyColumns - reserved)
    const description = layout.showAlbum ? trackLineWithAlbum(current) : trackLine(current)
    const titleText = truncateText(description, titleWidth)

    const statusRow = (
      <Box flexDirection="row" gap={1}>
        <Text color={colour} bold>
          {NOTE_GLYPH}
        </Text>
        <Text dimColor={!isPlaying}>{stateGlyph}</Text>
        {isQuiet ? (
          <Text bold={isPlaying}>{titleText}</Text>
        ) : (
          <Button key="title" plain label={titleText} onPress={() => void openPlayer($, current.source)} />
        )}
        {layout.showBar && (
          <Text>
            <Text color={colour}>{bar.played}</Text>
            <Text dimColor>{bar.remaining}</Text>
          </Text>
        )}
        {layout.showClock && <Text dimColor>{clock}</Text>}
        {layout.showVolume && <Text dimColor>{volumeText}</Text>}
        {modes !== '' && <Text color={colour}>{modes}</Text>}
      </Box>
    )

    if (isQuiet) return statusRow

    const controls = controlsRow(bandControls($, session, current, size))
    if (coverElement !== null) {
      return (
        <Box key="band" flexDirection="row" gap={1}>
          {coverElement}
          <Box flexDirection="column">
            {statusRow}
            {controls}
          </Box>
        </Box>
      )
    }

    return (
      <Box key="band" flexDirection="column">
        {statusRow}
        {controls}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: QUEUE_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const [list, playerStatus, covers, found, playlist] = await Promise.all([
      read($, queue),
      read($, status),
      read($, queueCovers),
      read($, search),
      read($, modPlaylist),
    ])
    const current = playerStatus.current
    const width = Math.max(MIN_TITLE_WIDTH, e.props.bodyColumns - PANE_MARGIN_COLUMNS)
    // Covers are drawn on the terminal alone, and only when the setting asks for them.
    const terminal = e.surface === 'terminal' && session.settings.queueArtwork ? $.ui.resolve(e) : null
    const drawsCovers = terminal !== null

    const label = playlistLabel(session)
    // While Music plays the mod's playlist, Up next and the playlist are one list.
    const playsModPlaylist = list !== null && list.note === null && list.isModPlaylist && current !== null

    // Section one: Up next, what Music plays after the track on. Read-only: Music
    // lets no script edit it, which is why additions go to the playlist below.
    const upNextTitle = (() => {
      if (list === null || current === null) return 'Up next'
      if (list.note !== null) return `Up next · ${displayName(current.source)}`
      return `Up next · ${playsModPlaylist ? label : list.playlistName}`
    })()
    const header = (
      <Box flexDirection="row" gap={1}>
        <Text bold>{truncateText(upNextTitle, width - PANE_HEADER_RESERVED)}</Text>
        <Button key="close-queue" role="dismiss" plain hotkey="x" label={CLOSE_LABEL} dimColor onPress={() => void closeQueue($)} />
      </Box>
    )

    // With covers, each row is a cover beside the title and the artist; a cover
    // still to land leaves its cells blank, so rows never shift as covers arrive.
    const queueRows = (() => {
      if (list === null || current === null) return <Text dimColor>Nothing is playing. Play the {label} below, or something in Music.</Text>
      if (list.note !== null) return <Text dimColor>{list.note}</Text>
      const currentIndex = list.currentIndex
      const textWidth = width - (drawsCovers ? QUEUE_COVER.columns + COVER_GAP_COLUMNS : 0)
      const marker = `${PLAYING_GLYPH} `
      return (
        <Box flexDirection="column">
          {list.entries.map(entry => {
            const isCurrent = entry.index === currentIndex
            const text = drawsCovers ? entry.title : trackLine(entry)
            const rowLabel = truncateText(text, textWidth - cellWidth(marker))
            const line = isCurrent ? (
              <Text bold color={SOURCE_COLOURS.music}>
                {marker}
                {rowLabel}
              </Text>
            ) : (
              <Button
                key={`queue-${entry.index}`}
                plain
                label={`  ${rowLabel}`}
                dimColor={entry.index < currentIndex}
                onPress={() => void control($, session, 'music', { playIndex: entry.index })}
              />
            )
            if (terminal === null) return line
            const cover = covers[entry.id]
            const coverElement = cover === undefined ? null : drawCover(terminal, session, cover, `cover-${entry.id}`, QUEUE_COVER)
            return (
              <Box flexDirection="row" gap={1}>
                {coverElement ?? <Box width={QUEUE_COVER.columns} height={QUEUE_COVER.rows} />}
                <Box flexDirection="column">
                  {line}
                  <Text dimColor>{truncateText(`  ${artistLine(entry)}`, textWidth)}</Text>
                </Box>
              </Box>
            )
          })}
        </Box>
      )
    })()

    // Section two: the mod's own playlist, newest last, each track pressable to
    // start the playlist from it. While it is what plays, Up next above is it.
    const playlistSection = (() => {
      if (playlist === null) return null
      const count = `${playlist.count} track${playlist.count === 1 ? '' : 's'}`
      if (playsModPlaylist) return <Text dimColor>{truncateText(`${label}: playing, so it is Up next above. ${count}.`, width)}</Text>
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text bold>
              {label} · {count}
              {playlist.count > playlist.entries.length ? ` (last ${playlist.entries.length} shown)` : ''}
            </Text>
            {playlist.count > 0 && (
              <Button key="play-playlist" plain hotkey="l" label="play it" dimColor onPress={() => void playModPlaylist($, session)} />
            )}
            {playlist.count > 0 && (
              <Button key="clear-playlist" plain label="clear" dimColor onPress={() => void clearModPlaylist($, session).then(said => $.ui.toast(said))} />
            )}
          </Box>
          {playlist.count === 0 && <Text dimColor>Empty. Add songs from your Music library below, or ask Claude to.</Text>}
          {playlist.entries.map(entry => (
            <Box flexDirection="row" gap={1}>
              <Button
                key={`playlist-${entry.index}`}
                plain
                dimColor
                label={truncateText(`  ${trackLine(entry)}`, width - PANE_REMOVE_RESERVED)}
                onPress={() => void playPlaylistTrack($, session, entry.index)}
              />
              <Button key={`remove-${entry.id}`} plain label={REMOVE_LABEL} dimColor onPress={() => void removeTracks($, session, [entry.id]).then(said => $.ui.toast(said))} />
            </Box>
          ))}
        </Box>
      )
    })()

    // Section three: adding, always to the Music playlist. The hints say what that
    // means right now, and name the limit that shapes it all: Music lets a script
    // put only library tracks in a playlist, and Spotify lets it neither search nor add.
    const whereHint = (() => {
      if (current?.source === 'spotify') return "Spotify is on: this adds to your Apple Music playlist, since Spotify's scripting can neither search nor add."
      if (playsModPlaylist) return 'It is playing, so each track you add joins Up next.'
      return 'Added tracks go in the playlist, not Up next; "play it" makes it Up next.'
    })()
    const addHints = [whereHint, LIBRARY_ONLY_HINT]

    // The mobile app draws no text field yet; there the pane lists without a search box.
    const searchBox = (() => {
      if (e.surface === 'mobile') return null
      const { Input } = $.ui.resolve(e)
      return (
        <Input
          key="search"
          placeholder="Search your library and Apple Music"
          submitLabel="search"
          onSubmit={(value: string) => void searchMusic($, session, value)}
        />
      )
    })()

    const results =
      found === null || found.query === '' ? null : (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text dimColor>{found.note ?? `"${found.query}"`}</Text>
            <Button key="clear-search" plain label="clear" dimColor onPress={() => void update($, search, () => null)} />
          </Box>
          {found.results.length > 0 && <Text dimColor>In your library, press one to add it to the playlist:</Text>}
          {found.results.map(result => (
            <Button
              key={`add-${result.id}`}
              plain
              label={truncateText(`+ ${trackLineWithAlbum(result)}`, width)}
              onPress={() => void addResult($, session, result)}
            />
          ))}
          {found.catalogue.length > 0 && <Text dimColor>On Apple Music but not in your library, so not addable here.</Text>}
          {found.catalogue.length > 0 && <Text dimColor>Press one to open it in Music and add it to your library there:</Text>}
          {found.catalogue.map(result => (
            <Button
              key={`open-${result.id}`}
              plain
              dimColor
              label={truncateText(`↗ ${trackLineWithAlbum(result)}`, width)}
              onPress={() => void openInMusic($, result.url ?? '')}
            />
          ))}
        </Box>
      )

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          {header}
          {queueRows}
        </Box>
        {playlistSection}
        <Box flexDirection="column">
          <Text bold>{truncateText(`Add to the ${label}`, width)}</Text>
          {addHints.map(hint => (
            <Text key={hint} dimColor>
              {truncateText(hint, width)}
            </Text>
          ))}
          {searchBox}
          {results}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: LYRICS_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const [view, playerStatus] = await Promise.all([read($, lyrics), read($, status)])
    const width = Math.max(MIN_TITLE_WIDTH, e.props.bodyColumns - PANE_MARGIN_COLUMNS)
    const title = view === null ? 'Lyrics' : `Lyrics · ${trackLine(view)}`
    const body = (() => {
      if (playerStatus.current === null) return <Text dimColor>Nothing is playing.</Text>
      if (view === null) return <Text dimColor>Reading…</Text>
      if (view.note !== null) return <Text dimColor>{view.note}</Text>
      return (
        <Box flexDirection="column">
          {view.text.split('\n').map((line, index) => (
            <Text key={`lyric-${index}`}>{truncateText(line, width) || ' '}</Text>
          ))}
        </Box>
      )
    })()
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1}>
          <Text bold>{truncateText(title, width - PANE_HEADER_RESERVED)}</Text>
          <Button key="close-lyrics" role="dismiss" plain hotkey="x" label={CLOSE_LABEL} dimColor onPress={() => void $.ui.close({ id: LYRICS_PANE })} />
        </Box>
        {body}
      </Box>
    )
  })
}
