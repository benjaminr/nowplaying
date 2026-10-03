/**
 * Talking to Apple Music and Spotify: the AppleScript each query and control
 * runs, how a reply is parsed, and which player the band follows.
 *
 * Every script is guarded by `is running` so the mod never launches a player,
 * and every `tell` names the app literally, which AppleScript needs to compile
 * its vocabulary. A player that is not running is found with pgrep first, so
 * no script is compiled against an app that may not be installed.
 */
import type { NowPlaying, PlaybackState, PlayerSource, QueueEntry, RepeatMode, SearchResult } from '../types'

const SOURCES: readonly PlayerSource[] = ['spotify', 'music']

/** What sets the two players apart: their names, the words their scripting uses, and how repeat cycles. */
type PlayerProfile = {
  name: string
  /** The status fields each player spells differently; `tr` is the current track. */
  fields: {
    duration: string
    trackId: string
    shuffle: string
    repeat: string
    shareUrl: string
    artworkUrl: string
  }
  toggleShuffle: string
  setRepeat: (mode: RepeatMode) => string
  /** The repeat modes in the order the repeat control cycles them. */
  repeatCycle: readonly RepeatMode[]
}

const PLAYERS: Readonly<Record<PlayerSource, PlayerProfile>> = {
  spotify: {
    name: 'Spotify',
    fields: {
      // Spotify reports a track's duration in milliseconds, Music in seconds.
      duration: '((duration of tr) / 1000)',
      trackId: 'id of tr',
      shuffle: 'shuffling',
      repeat: 'repeating',
      shareUrl: 'spotify url of tr',
      artworkUrl: 'artwork url of tr',
    },
    toggleShuffle: 'set shuffling to not shuffling',
    setRepeat: mode => `set repeating to ${mode !== 'off'}`,
    repeatCycle: ['off', 'all'],
  },
  music: {
    name: 'Music',
    fields: {
      duration: 'duration of tr',
      trackId: 'persistent ID of tr',
      shuffle: 'shuffle enabled',
      repeat: 'song repeat',
      shareUrl: '""',
      artworkUrl: '""',
    },
    toggleShuffle: 'set shuffle enabled to not shuffle enabled',
    setRepeat: mode => `set song repeat to ${mode}`,
    repeatCycle: ['off', 'all', 'one'],
  },
}

/** Separates the fields a status script returns; never appears in a track name. */
const FIELD_SEPARATOR = '\u001f'
/** Ends each query's block in a batched search reply. */
const RECORD_SEPARATOR = '\u001e'
const STATUS_FIELD_COUNT = 12
const SCRIPT_TIMEOUT_SECONDS = 3
/** Listing a playlist or writing a cover takes Music longer than a status read. */
const LISTING_TIMEOUT_SECONDS = 5
const SEARCH_TIMEOUT_SECONDS = 10
/** How long curl may spend fetching one cover. */
const DOWNLOAD_TIMEOUT_SECONDS = 8

const MIN_VOLUME = 0
const MAX_VOLUME = 100

/** How many tracks the queue pane lists, the track on included. */
const QUEUE_LENGTH = 20
/** How many already-played tracks the queue shows above the one on. */
const QUEUE_LOOKBACK = 2
/** How many of the mod's playlist's tracks the pane lists: the last ones added. */
const PLAYLIST_LIST_LENGTH = 30
/** How many matches a library search returns at most. */
export const MAX_SEARCH_RESULTS = 25

export type PlayerCommand =
  | 'play'
  | 'pause'
  | 'playpause'
  | 'next'
  | 'previous'
  | 'toggleShuffle'
  | { volume: number }
  | { repeat: RepeatMode }
  | { playIndex: number }

export function displayName(source: PlayerSource): string {
  return PLAYERS[source].name
}

/** `pgrep` arguments that list the players running right now. */
export function runningPlayersArgv(): readonly string[] {
  return ['pgrep', '-l', '-x', SOURCES.map(source => PLAYERS[source].name).join('|')]
}

/** Reads the players `pgrep -l` listed, by their process names. */
export function parseRunningPlayers(stdout: string): PlayerSource[] {
  const names = new Set(
    stdout
      .split('\n')
      .map(line => line.trim().split(/\s+/).slice(1).join(' '))
      .filter(name => name.length > 0),
  )
  return SOURCES.filter(source => names.has(PLAYERS[source].name))
}

export function osascriptArgv(script: string): readonly string[] {
  return ['osascript', '-e', script]
}

/** Brings the player's window to the front. */
export function openAppArgv(source: PlayerSource): readonly string[] {
  return ['open', '-a', PLAYERS[source].name]
}

/** Downloads a cover from its URL to `path`. */
export function downloadArgv(url: string, path: string): readonly string[] {
  return ['curl', '-fsSL', '--max-time', String(DOWNLOAD_TIMEOUT_SECONDS), '-o', path, url]
}

/** Converts whatever picture `source` holds into a PNG at `target`. */
export function toPngArgv(source: string, target: string): readonly string[] {
  return ['sips', '-s', 'format', 'png', source, '--out', target]
}

/** Shrinks the picture at `source` to `size` by `size` pixels as a BMP at `target`. */
export function toThumbnailArgv(source: string, target: string, size: number): readonly string[] {
  const side = String(Math.max(1, Math.floor(size)))
  return ['sips', '-z', side, side, '-s', 'format', 'bmp', source, '--out', target]
}

/** Quotes `text` for use inside an AppleScript string literal. */
function escapeAppleScript(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, ' ')
}

/** `set <name> to ""` then a guarded read of `expression`, so one missing field never fails the script. */
function guardedField(name: string, expression: string): string[] {
  return [`set ${name} to ""`, 'try', `  set ${name} to (${expression}) as text`, 'end try']
}

function guarded(source: PlayerSource, timeoutSeconds: number, body: readonly string[]): string {
  const appName = PLAYERS[source].name
  return [
    `if application "${appName}" is not running then return "off"`,
    'set sep to character id 31',
    `with timeout of ${timeoutSeconds} seconds`,
    `  tell application "${appName}"`,
    ...body.map(line => `    ${line}`),
    '  end tell',
    'end timeout',
  ].join('\n')
}

/** A one-line script that sends `verb` to the player only while it is running. */
function tellIfRunning(source: PlayerSource, verb: string): string {
  const appName = PLAYERS[source].name
  return `if application "${appName}" is running then tell application "${appName}" to ${verb}`
}

/**
 * Inside a `repeat with k from ...` over playlist `pl`: appends track k's
 * fields to `out` as one line. Only `index` and `track k of playlist` agree on
 * the order; a range (`tracks i thru j`) and `every track` each follow
 * another, so tracks are read one at a time.
 */
function appendTrackLine(): string[] {
  return [
    ...guardedField('trackTitle', 'get name of track k of pl'),
    ...guardedField('trackArtist', 'get artist of track k of pl'),
    ...guardedField('trackAlbum', 'get album of track k of pl'),
    ...guardedField('trackId', 'get persistent ID of track k of pl'),
    'set out to out & (k as text) & sep & trackTitle & sep & trackArtist & sep & trackAlbum & sep & trackId & linefeed',
  ]
}

/**
 * Writes the bytes in `pictureBytes` to the file at `path`, replacing it.
 * The handle is closed on a failed write too: one left open stays open in
 * Music's process, and the next export of that file is refused.
 */
function writePictureLines(path: string): string[] {
  return [
    `set target to POSIX file "${escapeAppleScript(path)}"`,
    'set handle to open for access target with write permission',
    'try',
    '  set eof handle to 0',
    '  write pictureBytes to handle',
    '  close access handle',
    'on error writeError',
    '  close access handle',
    '  error writeError',
    'end try',
  ]
}

/** The AppleScript that reads what `source` is playing, one line of fields. */
export function statusScript(source: PlayerSource): string {
  const { fields } = PLAYERS[source]
  return guarded(source, SCRIPT_TIMEOUT_SECONDS, [
    'set playerState to (player state as text)',
    'if playerState is "stopped" then return "stopped"',
    'set tr to current track',
    ...guardedField('trackName', 'name of tr'),
    ...guardedField('trackArtist', 'artist of tr'),
    ...guardedField('trackAlbum', 'album of tr'),
    ...guardedField('trackDuration', fields.duration),
    ...guardedField('trackId', fields.trackId),
    ...guardedField('shuffleText', fields.shuffle),
    ...guardedField('repeatText', fields.repeat),
    ...guardedField('shareUrl', fields.shareUrl),
    ...guardedField('artworkUrl', fields.artworkUrl),
    'return playerState & sep & trackName & sep & trackArtist & sep & trackAlbum' +
      ' & sep & (player position as text) & sep & trackDuration & sep & (sound volume as text)' +
      ' & sep & trackId & sep & shuffleText & sep & repeatText & sep & shareUrl & sep & artworkUrl',
  ])
}

/** The AppleScript that sends `command` to `source`. */
export function controlScript(source: PlayerSource, command: PlayerCommand): string {
  return tellIfRunning(source, verbFor(source, command))
}

function verbFor(source: PlayerSource, command: PlayerCommand): string {
  const player = PLAYERS[source]
  if (typeof command === 'object') {
    if ('volume' in command) return `set sound volume to ${clampVolume(command.volume)}`
    if ('playIndex' in command) return `play track ${Math.max(1, Math.floor(command.playIndex))} of current playlist`
    return player.setRepeat(command.repeat)
  }
  switch (command) {
    case 'play':
      return 'play'
    case 'pause':
      return 'pause'
    case 'playpause':
      return 'playpause'
    case 'next':
      return 'next track'
    case 'previous':
      return 'previous track'
    case 'toggleShuffle':
      return player.toggleShuffle
  }
}

/** The repeat mode after this one in the player's cycle: off, all, one (Spotify skips `one`). */
export function nextRepeatMode(source: PlayerSource, current: RepeatMode): RepeatMode {
  const cycle = PLAYERS[source].repeatCycle
  return cycle[(cycle.indexOf(current) + 1) % cycle.length] ?? 'off'
}

/** Music plays the first library track whose name contains `query`, and says which. */
export function playByNameScript(query: string): string {
  return guarded('music', SEARCH_TIMEOUT_SECONDS, [
    `set found to (first track of library playlist 1 whose name contains "${escapeAppleScript(query)}")`,
    'play found',
    'return (name of found) & sep & (artist of found)',
  ])
}

/** Reads a `playByNameScript` reply: the track that started, or null. */
export function parsePlayed(stdout: string): { title: string; artist: string } | null {
  const line = stdout.trim()
  if (line === '' || line === 'off') return null
  const [title = '', artist = ''] = line.split(FIELD_SEPARATOR)
  return title === '' ? null : { title, artist }
}

/** Music lists the tracks around the one on in its current playlist. */
export function queueScript(): string {
  return guarded('music', LISTING_TIMEOUT_SECONDS, [
    'if (player state as text) is "stopped" then return ""',
    'set pl to current playlist',
    'set i to index of current track',
    'set n to count of tracks of pl',
    `set firstIndex to i - ${QUEUE_LOOKBACK}`,
    'if firstIndex < 1 then set firstIndex to 1',
    `set lastIndex to firstIndex + ${QUEUE_LENGTH - 1}`,
    'if lastIndex > n then set lastIndex to n',
    'set out to (i as text) & sep & (get name of pl) & linefeed',
    'repeat with k from firstIndex to lastIndex',
    ...appendTrackLine(),
    'end repeat',
    'return out',
  ])
}

type ParsedQueue = { currentIndex: number; playlistName: string; entries: QueueEntry[] }

/** The non-empty lines of a reply, or null when the player was off or said nothing. */
function replyLines(stdout: string): string[] | null {
  const lines = stdout.split('\n').filter(line => line.trim() !== '')
  const first = lines[0]
  return first === undefined || first === 'off' ? null : lines
}

/** Reads the lines `appendTrackLine` wrote, one entry per well-formed line. */
function parseTrackLines(lines: readonly string[]): QueueEntry[] {
  const entries: QueueEntry[] = []
  for (const line of lines) {
    const [indexText = '', title = '', artist = '', album = '', id = ''] = line.split(FIELD_SEPARATOR)
    const index = Number.parseInt(indexText, 10)
    if (Number.isFinite(index)) entries.push({ index, title, artist, album, id })
  }
  return entries
}

/** Reads a `queueScript` reply: the track on and its playlist, then the entries. */
export function parseQueue(stdout: string): ParsedQueue | null {
  const lines = replyLines(stdout)
  if (lines === null) return null
  const [first = '', ...rest] = lines
  const [indexText = '', playlistName = ''] = first.split(FIELD_SEPARATOR)
  const currentIndex = Number.parseInt(indexText, 10)
  if (!Number.isFinite(currentIndex)) return null
  return { currentIndex, playlistName, entries: parseTrackLines(rest) }
}

/** Music writes the current track's cover bytes to `path` and says their format. */
export function artworkExportScript(path: string): string {
  return guarded('music', LISTING_TIMEOUT_SECONDS, [
    'if (player state as text) is "stopped" then return ""',
    'if (count of artworks of current track) is 0 then return ""',
    'set art to artwork 1 of current track',
    'set pictureBytes to (get raw data of art)',
    ...writePictureLines(path),
    'return (format of art) as text',
  ])
}

/** Music writes the cover of the library track with this persistent ID to `path`. */
export function artworkByIdScript(id: string, path: string): string {
  return guarded('music', LISTING_TIMEOUT_SECONDS, [
    `set t to (first track of library playlist 1 whose persistent ID is "${escapeAppleScript(id)}")`,
    'if (count of artworks of t) is 0 then return ""',
    'set pictureBytes to (get raw data of artwork 1 of t)',
    ...writePictureLines(path),
    'return "ok"',
  ])
}

/** `limit` held to 1 through `MAX_SEARCH_RESULTS`. */
function capResults(limit: number): number {
  return Math.max(1, Math.min(MAX_SEARCH_RESULTS, Math.floor(limit)))
}

/**
 * Inside a script with `out` set: Music searches the library for the text
 * `needleExpression` names and appends up to `limit` matches to `out`, one
 * line each.
 */
function appendSearchLines(needleExpression: string, limit: number): string[] {
  return [
    `set found to (search library playlist 1 for ${needleExpression})`,
    'set n to count of found',
    `repeat with k from 1 to ${capResults(limit)}`,
    '  if k > n then exit repeat',
    '  set t to item k of found',
    ...guardedField('trackName', 'name of t'),
    ...guardedField('trackArtist', 'artist of t'),
    ...guardedField('trackAlbum', 'album of t'),
    '  set out to out & (get persistent ID of t) & sep & trackName & sep & trackArtist & sep & trackAlbum & linefeed',
    'end repeat',
  ]
}

/**
 * Music searches its library the way its own search box does: every word of
 * `query` matched across title, artist, album and the rest, results ranked.
 */
export function searchLibraryScript(query: string, limit: number = MAX_SEARCH_RESULTS): string {
  const needle = escapeAppleScript(query)
  return guarded('music', SEARCH_TIMEOUT_SECONDS, ['set out to ""', ...appendSearchLines(`"${needle}"`, limit), 'return out'])
}

/**
 * One script that runs every search in `queries` in turn, so a batch of
 * requests costs one osascript launch rather than one per request. The reply
 * holds one block per query, in order, each ended by a record separator; a
 * search that fails leaves its block empty.
 */
export function searchLibraryManyScript(queries: readonly string[], limit: number = MAX_SEARCH_RESULTS): string {
  const list = queries.map(query => `"${escapeAppleScript(query)}"`).join(', ')
  return guarded('music', SEARCH_TIMEOUT_SECONDS, [
    'set rs to character id 30',
    `set queries to {${list}}`,
    'set out to ""',
    'repeat with q from 1 to count of queries',
    '  set needle to item q of queries',
    '  try',
    ...appendSearchLines('needle', limit).map(line => `  ${line}`),
    '  end try',
    '  set out to out & rs',
    'end repeat',
    'return out',
  ])
}

/** Reads a `searchLibraryManyScript` reply: one list of results per query, in the order asked. */
export function parseSearchMany(stdout: string, queryCount: number): SearchResult[][] {
  if (stdout.trim() === 'off') return Array.from({ length: queryCount }, () => [])
  const blocks = stdout.split(RECORD_SEPARATOR).map(parseSearch)
  return Array.from({ length: queryCount }, (_, index) => blocks[index] ?? [])
}

/** Reads a `searchLibraryScript` reply. */
export function parseSearch(stdout: string): SearchResult[] {
  const results: SearchResult[] = []
  for (const line of stdout.split('\n')) {
    if (line.trim() === '' || line === 'off') continue
    const [id = '', title = '', artist = '', album = ''] = line.split(FIELD_SEPARATOR)
    if (id !== '') results.push({ id, kind: 'library', title, artist, album, url: null })
  }
  return results
}

/** Apple's public catalogue search, no sign-in needed; `country` is the storefront (GB, US). */
export function catalogueSearchUrl(query: string, country: string, limit: number = MAX_SEARCH_RESULTS): string {
  const params = new URLSearchParams({
    term: query,
    media: 'music',
    entity: 'song',
    limit: String(capResults(limit)),
    country: storefrontFrom(country),
  })
  return `https://itunes.apple.com/search?${params.toString()}`
}

/** The two-letter storefront in a locale (`en_GB` → `GB`); `US` when none is found. */
export function storefrontFrom(locale: string): string {
  const match = /[_-]([A-Za-z]{2})\b/.exec(locale.trim())
  const country = match?.[1] ?? (/^[A-Za-z]{2}$/.test(locale.trim()) ? locale.trim() : 'US')
  return country.toUpperCase()
}

/** A web link to a track becomes the `music://` link that opens in the Music app. */
export function musicAppUrl(webUrl: string): string {
  return webUrl.replace(/^https?:\/\//, 'music://')
}

/** Reads the JSON Apple's catalogue search answers. */
export function parseCatalogue(json: string): SearchResult[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { results?: unknown }).results)) return []
  const results: SearchResult[] = []
  for (const item of (parsed as { results: unknown[] }).results) {
    if (typeof item !== 'object' || item === null) continue
    const row = item as Record<string, unknown>
    const title = typeof row.trackName === 'string' ? row.trackName : ''
    const artist = typeof row.artistName === 'string' ? row.artistName : ''
    const album = typeof row.collectionName === 'string' ? row.collectionName : ''
    const id = typeof row.trackId === 'number' ? String(row.trackId) : ''
    const webUrl = typeof row.trackViewUrl === 'string' ? row.trackViewUrl : ''
    if (title === '' || id === '' || webUrl === '') continue
    results.push({ id, kind: 'catalogue', title, artist, album, url: musicAppUrl(webUrl) })
  }
  return results
}

/** Catalogue results the library already holds are dropped: the library row is the one to add. */
export function withoutLibraryDuplicates(catalogue: readonly SearchResult[], library: readonly SearchResult[]): SearchResult[] {
  const owned = new Set(library.map(result => `${normalise(result.title)}|${normalise(result.artist)}`))
  const seen = new Set<string>()
  return catalogue.filter(result => {
    const key = `${normalise(result.title)}|${normalise(result.artist)}`
    if (owned.has(key) || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Music makes the mod's playlist when it is missing and lists its last tracks. */
export function ensurePlaylistScript(name: string): string {
  const playlist = escapeAppleScript(name)
  return guarded('music', SEARCH_TIMEOUT_SECONDS, [
    `if not (exists user playlist "${playlist}") then make new user playlist with properties {name:"${playlist}"}`,
    `set pl to user playlist "${playlist}"`,
    'set playlistCount to count of tracks of pl',
    `set firstIndex to playlistCount - ${PLAYLIST_LIST_LENGTH - 1}`,
    'if firstIndex < 1 then set firstIndex to 1',
    'set out to (playlistCount as text) & linefeed',
    'repeat with k from firstIndex to playlistCount',
    ...appendTrackLine(),
    'end repeat',
    'return out',
  ])
}

/** Reads an `ensurePlaylistScript` reply: how many tracks, then the last of them. */
export function parsePlaylist(stdout: string): { count: number; entries: QueueEntry[] } | null {
  const lines = replyLines(stdout)
  if (lines === null) return null
  const [first = '', ...rest] = lines
  const count = Number.parseInt(first, 10)
  if (!Number.isFinite(count)) return null
  return { count, entries: parseTrackLines(rest) }
}

/** Music starts the mod's playlist at its `index`th track (from 1). */
export function playPlaylistTrackScript(name: string, index: number): string {
  const position = Math.max(1, Math.floor(index))
  return tellIfRunning('music', `play track ${position} of user playlist "${escapeAppleScript(name)}"`)
}

/** Music starts the mod's playlist from its first track. */
export function playPlaylistScript(name: string): string {
  return tellIfRunning('music', `play user playlist "${escapeAppleScript(name)}"`)
}

/**
 * Music adds the library tracks with these persistent IDs to the mod's
 * playlist, skipping any already in it, and answers `added<sep>skipped<sep>count`.
 */
export function addTracksScript(name: string, ids: readonly string[]): string {
  const playlist = escapeAppleScript(name)
  const idList = ids.map(id => `"${escapeAppleScript(id)}"`).join(', ')
  return guarded('music', SEARCH_TIMEOUT_SECONDS, [
    `if not (exists user playlist "${playlist}") then make new user playlist with properties {name:"${playlist}"}`,
    `set pl to user playlist "${playlist}"`,
    `set wanted to {${idList}}`,
    'set added to 0',
    'set skipped to 0',
    'repeat with wantedRef in wanted',
    // The loop variable is a reference into the list; the string itself is what the filters compare.
    '  set wantedId to contents of wantedRef',
    '  set already to (count of (tracks of pl whose persistent ID is wantedId))',
    '  if already > 0 then',
    '    set skipped to skipped + 1',
    '  else',
    '    try',
    '      duplicate (first track of library playlist 1 whose persistent ID is wantedId) to pl',
    '      set added to added + 1',
    '    on error',
    '      set skipped to skipped + 1',
    '    end try',
    '  end if',
    'end repeat',
    'return (added as text) & sep & (skipped as text) & sep & ((count of tracks of pl) as text)',
  ])
}

/** What an add did: tracks added, tracks already there, and the playlist's size after. */
export type AddOutcome = { added: number; skipped: number; count: number }

/** Reads an `addTracksScript` reply. */
export function parseAdded(stdout: string): AddOutcome | null {
  const line = stdout.trim()
  if (line === '' || line === 'off') return null
  const [added = '', skipped = '', count = ''] = line.split(FIELD_SEPARATOR).map(part => part.trim())
  const numbers = [added, skipped, count].map(text => Number.parseInt(text, 10))
  if (numbers.some(value => !Number.isFinite(value))) return null
  return { added: numbers[0] ?? 0, skipped: numbers[1] ?? 0, count: numbers[2] ?? 0 }
}

/**
 * Music removes every track from the mod's playlist, leaving the playlist
 * itself and the library untouched, and answers how many it removed. A
 * playlist that does not exist counts as empty.
 */
export function clearPlaylistScript(name: string): string {
  const playlist = escapeAppleScript(name)
  return guarded('music', SEARCH_TIMEOUT_SECONDS, [
    `if not (exists user playlist "${playlist}") then return "0"`,
    `set pl to user playlist "${playlist}"`,
    // `removed` is a reserved word in Music's dictionary, so the count has a longer name.
    'set trackTotal to count of tracks of pl',
    'if trackTotal > 0 then delete every track of pl',
    'return (trackTotal as text)',
  ])
}

/** Reads a `clearPlaylistScript` reply: how many tracks were removed. */
export function parseCleared(stdout: string): number | null {
  return parseCount(stdout)
}

/**
 * `Title — Artist`, `Title - Artist` or `Title by Artist` into its two parts.
 * A dash is tried before `by`, and `by` is split at its last occurrence, so
 * titles such as "Stand by Me — Ben E. King" or "Killed by Death by Motörhead"
 * keep their `by`. A lone title containing `by` cannot be told from one with
 * an artist, so Claude is asked to name tracks with a dash.
 */
export function splitTrackQuery(query: string): { title: string; artist: string | null } {
  const trimmed = query.trim()
  const dash = /^(.+?)\s+(?:—|–|-)\s+(.+)$/.exec(trimmed)
  if (dash !== null) return trackParts(dash[1] ?? '', dash[2] ?? '')
  const by = /^(.+)\s+by\s+(.+)$/i.exec(trimmed)
  if (by !== null) return trackParts(by[1] ?? '', by[2] ?? '')
  return { title: trimmed, artist: null }
}

function trackParts(title: string, artist: string): { title: string; artist: string | null } {
  return { title: title.trim(), artist: artist.trim() || null }
}

/**
 * A title or artist as compared: lower case, without accents or apostrophes,
 * without a "(feat. X)" credit, and with runs of anything else as one space,
 * so "Damselfly (feat. Tom Misch)" and "damselfly" are the same song and
 * "Beyoncé" finds "Beyonce".
 */
export function normalise(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[([][^)\]]*\b(?:feat|ft|featuring)\b[^)\]]*[)\]]/g, ' ')
    .replace(/\s\b(?:feat|ft|featuring)\b\.?\s.*$/, ' ')
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** Returns a reply that is a single count, or null for off, empty or garbled. */
export function parseCount(stdout: string): number | null {
  const line = stdout.trim()
  if (line === '' || line === 'off') return null
  const count = Number.parseInt(line, 10)
  return Number.isFinite(count) ? count : null
}

/**
 * What a filtered library search asks for; the fields given are combined with
 * "and", and none at all means the whole library (for a random pick).
 */
export type LibraryFilter = {
  title?: string
  artist?: string
  album?: string
  genre?: string
  yearFrom?: number
  yearTo?: number
  /** Stars from 1 to 5; Music keeps a rating from 0 to 100 in steps of 20. */
  minStars?: number
  /** Music's favourite (the heart; `favorited` since macOS 14). */
  favourite?: boolean
  minPlays?: number
  maxPlays?: number
  /** Tracks not played for this many days, never-played ones included. */
  notPlayedForDays?: number
}

/** A library track with the facts a filter can sort by. */
export type LibraryTrack = SearchResult & { year: number; genre: string; stars: number; playCount: number }

export type LibrarySort = 'random' | 'leastPlayed' | 'mostPlayed' | 'newest' | 'oldest' | 'topRated' | 'title'

const STARS_TO_RATING = 20

function wholeNumber(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) ? Math.floor(value) : null
}

/** The `whose` conditions a filter stands for, as Music's scripting spells them. */
function filterConditions(filter: LibraryFilter): string[] {
  const conditions = ['media kind is song']
  const texts: [string, string | undefined][] = [['name', filter.title], ['artist', filter.artist], ['album', filter.album], ['genre', filter.genre]]
  for (const [property, value] of texts) {
    if (value !== undefined && value.trim() !== '') conditions.push(`${property} contains "${escapeAppleScript(value.trim())}"`)
  }
  const yearFrom = wholeNumber(filter.yearFrom)
  const yearTo = wholeNumber(filter.yearTo)
  const minStars = wholeNumber(filter.minStars)
  const minPlays = wholeNumber(filter.minPlays)
  const maxPlays = wholeNumber(filter.maxPlays)
  if (yearFrom !== null) conditions.push(`year >= ${yearFrom}`)
  if (yearTo !== null) conditions.push(`year <= ${yearTo}`)
  if (minStars !== null && minStars > 0) conditions.push(`rating >= ${Math.min(5, minStars) * STARS_TO_RATING}`)
  if (filter.favourite === true) conditions.push('favorited is true')
  if (minPlays !== null) conditions.push(`played count >= ${minPlays}`)
  if (maxPlays !== null) conditions.push(`played count <= ${maxPlays}`)
  if (wholeNumber(filter.notPlayedForDays) !== null) conditions.push('(played date < staleDate or played count = 0)')
  return conditions
}

/**
 * Music lists every library song a filter matches, as one line per property
 * (IDs, names, artists, albums, years, genres, ratings, play counts), each a
 * separated list: eight reads of a filtered reference, which Music answers in
 * well under a second for hundreds of tracks. The caller sorts and trims.
 */
export function filterLibraryScript(filter: LibraryFilter): string {
  const staleDays = wholeNumber(filter.notPlayedForDays)
  const lists = ['persistent ID', 'name', 'artist', 'album', 'year', 'genre', 'rating', 'played count']
  return guarded('music', SEARCH_TIMEOUT_SECONDS, [
    ...(staleDays === null ? [] : [`set staleDate to (current date) - (${Math.max(0, staleDays)} * days)`]),
    // `matched` and `removed` are reserved words here; `hits` is not.
    `set hits to a reference to (every track of library playlist 1 whose ${filterConditions(filter).join(' and ')})`,
    'set n to count of hits',
    "set AppleScript's text item delimiters to sep",
    'set out to (n as text) & linefeed',
    'if n > 0 then',
    ...lists.map(property => `  set out to out & ((${property} of hits) as text) & linefeed`),
    'end if',
    'return out',
  ])
}

/**
 * Reads a `filterLibraryScript` reply. Null for a player that is off or a
 * reply whose lists do not line up (a name holding a line break would do it).
 */
export function parseLibraryTracks(stdout: string): LibraryTrack[] | null {
  const lines = stdout.split('\n')
  const count = Number.parseInt(lines[0]?.trim() ?? '', 10)
  if (lines[0]?.trim() === 'off' || !Number.isFinite(count)) return null
  if (count === 0) return []
  const columns = lines.slice(1, 9).map(line => line.split(FIELD_SEPARATOR))
  const [ids = [], titles = [], artists = [], albums = [], years = [], genres = [], ratings = [], plays = []] = columns
  if (ids.length !== count || titles.length !== count) return null
  return ids.map((id, index) => ({
    id,
    kind: 'library' as const,
    title: titles[index] ?? '',
    artist: artists[index] ?? '',
    album: albums[index] ?? '',
    url: null,
    year: Number.parseInt(years[index] ?? '', 10) || 0,
    genre: genres[index] ?? '',
    stars: Math.round((Number.parseInt(ratings[index] ?? '', 10) || 0) / STARS_TO_RATING),
    playCount: Number.parseInt(plays[index] ?? '', 10) || 0,
  }))
}

/** The first `limit` tracks in the order asked; random is a fair shuffle. */
export function pickTracks(tracks: readonly LibraryTrack[], sort: LibrarySort, limit: number, random: () => number = Math.random): LibraryTrack[] {
  const list = [...tracks]
  if (sort === 'random') {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1))
      const swap = list[i] as LibraryTrack
      list[i] = list[j] as LibraryTrack
      list[j] = swap
    }
  } else {
    const compare: Record<Exclude<LibrarySort, 'random'>, (a: LibraryTrack, b: LibraryTrack) => number> = {
      leastPlayed: (a, b) => a.playCount - b.playCount,
      mostPlayed: (a, b) => b.playCount - a.playCount,
      newest: (a, b) => b.year - a.year,
      oldest: (a, b) => a.year - b.year,
      topRated: (a, b) => b.stars - a.stars || b.playCount - a.playCount,
      title: (a, b) => a.title.localeCompare(b.title),
    }
    list.sort(compare[sort])
  }
  return list.slice(0, Math.max(0, Math.floor(limit)))
}

/** Music takes these tracks out of the mod's playlist (the library keeps them) and answers how many remain. */
export function removeFromPlaylistScript(name: string, ids: readonly string[]): string {
  const playlist = escapeAppleScript(name)
  const idList = ids.map(id => `"${escapeAppleScript(id)}"`).join(', ')
  return guarded('music', SEARCH_TIMEOUT_SECONDS, [
    `if not (exists user playlist "${playlist}") then return "0"`,
    `set pl to user playlist "${playlist}"`,
    `set wanted to {${idList}}`,
    'repeat with wantedRef in wanted',
    '  set wantedId to contents of wantedRef',
    '  try',
    '    delete (first track of pl whose persistent ID is wantedId)',
    '  end try',
    'end repeat',
    'return ((count of tracks of pl) as text)',
  ])
}

/** The lyrics Music holds for the track on, with the track's identity. */
export type Lyrics = { id: string; title: string; artist: string; text: string }

/** Music gives the track on and its lyrics (empty when it has none); `stopped` gives nothing. */
export function lyricsScript(): string {
  return guarded('music', LISTING_TIMEOUT_SECONDS, [
    'if player state is stopped then return ""',
    'set t to current track',
    'set ly to ""',
    'try',
    '  set ly to lyrics of t',
    'end try',
    'return (get persistent ID of t) & sep & (get name of t) & sep & (get artist of t) & sep & ly',
  ])
}

/** Reads a `lyricsScript` reply; null for nothing on or Music off. */
export function parseLyrics(stdout: string): Lyrics | null {
  const trimmed = stdout.replace(/\s+$/, '')
  if (trimmed === '' || trimmed === 'off') return null
  const [id = '', title = '', artist = '', ...rest] = trimmed.split(FIELD_SEPARATOR)
  if (id === '') return null
  return { id, title, artist, text: rest.join(FIELD_SEPARATOR).trim() }
}

/**
 * The result that best answers a request: an exact title by the named artist
 * first, then an exact title, then a title that contains (or is contained in)
 * the request, by that artist first. The title must match: Music's search
 * matches any word, so a loose first result could be the wrong song.
 */
export function pickBestMatch(results: readonly SearchResult[], title: string, artist: string | null): SearchResult | null {
  if (results.length === 0) return null
  const wantedTitle = normalise(title)
  if (wantedTitle === '') return null
  const wantedArtist = artist === null ? null : normalise(artist)
  const hasArtist = (result: SearchResult) => wantedArtist !== null && normalise(result.artist).includes(wantedArtist)
  const pick = (list: readonly SearchResult[]) => list.find(hasArtist) ?? (wantedArtist === null ? list[0] : undefined)

  const exact = results.filter(result => normalise(result.title) === wantedTitle)
  const close = results.filter(result => {
    const found = normalise(result.title)
    return found !== wantedTitle && (found.includes(wantedTitle) || wantedTitle.includes(found))
  })
  return pick(exact) ?? exact[0] ?? pick(close) ?? null
}

/** A whole number from 0 to 100; 100 for anything that is not a number. */
export function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) return MAX_VOLUME
  return Math.min(MAX_VOLUME, Math.max(MIN_VOLUME, Math.round(volume)))
}

/**
 * Reads a status script's reply. `off` and `stopped` mean nothing to show;
 * anything malformed is also nothing, rather than a half-filled row.
 */
export function parseStatus(source: PlayerSource, stdout: string, fetchedAt: number): NowPlaying | null {
  const line = stdout.trim()
  if (line === '' || line === 'off' || line === 'stopped') return null

  const fields = line.split(FIELD_SEPARATOR)
  if (fields.length !== STATUS_FIELD_COUNT) return null

  const [
    stateText = '',
    title = '',
    artist = '',
    album = '',
    positionText = '',
    durationText = '',
    volumeText = '',
    trackId = '',
    shuffleText = '',
    repeatText = '',
    shareUrlText = '',
    artworkUrlText = '',
  ] = fields
  const state = parsePlaybackState(stateText)
  if (state === null) return null

  return {
    source,
    state,
    trackId: trackId || `${title}|${artist}|${album}`,
    title,
    artist,
    album,
    positionSeconds: parseAppleScriptNumber(positionText),
    durationSeconds: parseAppleScriptNumber(durationText),
    volume: clampVolume(parseAppleScriptNumber(volumeText)),
    shuffle: shuffleText === 'true',
    repeat: parseRepeat(repeatText),
    shareUrl: shareUrlFor(shareUrlText),
    artworkUrl: artworkUrlText.startsWith('http') ? artworkUrlText : null,
    fetchedAt,
  }
}

function parsePlaybackState(text: string): PlaybackState | null {
  if (text === 'playing') return 'playing'
  if (text === 'paused') return 'paused'
  return null
}

function parseRepeat(text: string): RepeatMode {
  if (text === 'one' || text === 'all') return text
  if (text === 'true') return 'all'
  return 'off'
}

/** A Spotify URI (`spotify:track:ID`) becomes the web link anyone can open. */
export function shareUrlFor(text: string): string | null {
  const uri = text.trim()
  if (uri === '') return null
  if (uri.startsWith('http')) return uri
  const parts = uri.split(':')
  if (parts[0] === 'spotify' && parts.length === 3) {
    return `https://open.spotify.com/${parts[1]}/${parts[2]}`
  }
  return null
}

/** AppleScript writes reals in the system locale, so a comma may be the point. */
function parseAppleScriptNumber(text: string): number {
  const value = Number.parseFloat(text.replace(',', '.'))
  return Number.isFinite(value) ? value : 0
}

/**
 * Which reading the band follows when more than one player is open: whatever
 * is playing wins; between two in the same state the one shown last stays, so
 * the band does not flicker between players.
 */
export function pickCurrent(
  readings: readonly (NowPlaying | null)[],
  previousSource: PlayerSource | null,
): NowPlaying | null {
  const present = readings.filter((reading): reading is NowPlaying => reading !== null)
  if (present.length === 0) return null

  const playing = present.filter(reading => reading.state === 'playing')
  const pool = playing.length > 0 ? playing : present
  return pool.find(reading => reading.source === previousSource) ?? pool[0] ?? null
}

/** Why a script failed: a permission to grant, a player too slow to answer, or something else. */
export type FailureKind = 'permission' | 'timeout' | 'other'

/**
 * Reads osascript's stderr. `-1743` is macOS refusing the Apple Event because
 * the terminal is not allowed to control the player; `-1712` is the event
 * timing out, which a player still launching, scanning a large library or
 * waiting on the permission prompt also does.
 */
export function classifyFailure(stderr: string): FailureKind {
  if (/not authori[sz]ed|-1743/i.test(stderr)) return 'permission'
  if (/timed out|-1712/i.test(stderr)) return 'timeout'
  return 'other'
}

/** Turns an osascript failure into one line the band can show. */
export function describeFailure(source: PlayerSource, stderr: string): string {
  const app = PLAYERS[source].name
  switch (classifyFailure(stderr)) {
    case 'permission':
      return `${app} is not answering. Allow your terminal to control ${app} under System Settings → Privacy & Security → Automation.`
    case 'timeout':
      return `${app} is slow to answer (busy, or waiting on a permission prompt); it will be asked again shortly.`
    case 'other': {
      const firstLine = stderr.trim().split('\n')[0] ?? ''
      return `${app} could not be read${firstLine ? `: ${firstLine}` : '.'}`
    }
  }
}
