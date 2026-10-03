import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { cellWidth, fitControls, formatClock, layoutFor, positionNow, progressBar, truncateText } from '../hooks/format'
import { bytesFromBase64, decodeBmp, encodeCells, sampleThumbnail, thumbnailCells } from '../hooks/pixels'
import {
  addTracksScript,
  clearPlaylistScript,
  artworkExportScript,
  catalogueSearchUrl,
  musicAppUrl,
  parseCatalogue,
  storefrontFrom,
  withoutLibraryDuplicates,
  classifyFailure,
  controlScript,
  describeFailure,
  nextRepeatMode,
  parseAdded,
  parseCleared,
  parseQueue,
  parseSearch,
  parseSearchMany,
  pickBestMatch,
  searchLibraryManyScript,
  searchLibraryScript,
  splitTrackQuery,
  parseRunningPlayers,
  parseStatus,
  pickCurrent,
  playByNameScript,
  queueScript,
  shareUrlFor,
  statusScript,
} from '../hooks/players'

const SEP = '\u001f'
const RS = '\u001e'
const SPOTIFY_LINE = [
  'playing', 'Teardrop', 'Massive Attack', 'Mezzanine', '83.5', '329.0', '65',
  'spotify:track:67Hna13dNDkZvBpTXRIaOJ', 'true', 'false', 'spotify:track:67Hna13dNDkZvBpTXRIaOJ',
  'https://i.scdn.co/image/abc',
].join(SEP)
const MUSIC_LINE = [
  'paused', 'Everything In Its Right Place', 'Radiohead', 'Kid A', '12,25', '250.9', '40',
  'C0FFEE12345678', 'false', 'one', '', '',
].join(SEP)
const QUEUE_REPLY = [
  `5${SEP}OK Computer`,
  `3${SEP}Airbag${SEP}Radiohead${SEP}OK Computer${SEP}ID3`,
  `4${SEP}Paranoid Android${SEP}Radiohead${SEP}OK Computer${SEP}ID4`,
  `5${SEP}Subterranean Homesick Alien${SEP}Radiohead${SEP}OK Computer${SEP}C0FFEE12345678`,
  `6${SEP}Exit Music${SEP}Radiohead${SEP}OK Computer${SEP}ID6`,
].join('\n')
const SEARCH_REPLY = [
  `JAZZ1${SEP}So What${SEP}Miles Davis${SEP}Kind of Blue`,
  `JAZZ2${SEP}So What (Live)${SEP}Miles Davis${SEP}Live in Europe`,
  `JAZZ3${SEP}So What${SEP}Some Tribute Band${SEP}Covers`,
].join('\n')

const CATALOGUE_REPLY = JSON.stringify({
  resultCount: 2,
  results: [
    { trackId: 268443097, trackName: 'So What', artistName: 'Miles Davis', collectionName: 'Kind of Blue', trackViewUrl: 'https://music.apple.com/gb/album/so-what/268443092?i=268443097&uo=4' },
    { trackId: 1, trackName: 'Take Five', artistName: 'The Dave Brubeck Quartet', collectionName: 'Time Out', trackViewUrl: 'https://music.apple.com/gb/album/take-five/2?i=1' },
  ],
})

/** Stands for Apple's catalogue search and the Mac's locale. */
function mockCatalogue(on: On, reply: string = CATALOGUE_REPLY) {
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: reply } }))
}

/** What one library search finds in this mocked library: Miles Davis, and nothing else. */
function searchReply(query: string): string {
  return /so what/i.test(query) ? SEARCH_REPLY + '\n' : ''
}

/** Answers Music's library scripts: a search, a batch of searches, the playlist count, an add. */
function libraryReply(script: string): string | null {
  if (script.includes('set queries to {')) {
    const queries = script.match(/set queries to \{(.*)\}/)?.[1]?.split('", "') ?? []
    return queries.map(query => searchReply(query) + RS).join('')
  }
  if (script.includes('search library playlist 1 for')) return searchReply(script) || '\n'
  if (script.includes('set wanted to {')) {
    const ids = script.match(/set wanted to \{(.*)\}/)?.[1]?.split(',').length ?? 0
    return `${ids}${SEP}0${SEP}${ids + 2}\n`
  }
  if (script.includes('delete every track of pl')) return '2\n'
  if (script.includes('delete (first track of pl whose persistent ID is')) return '1\n'
  if (script.includes('a reference to (every track of library playlist 1 whose')) {
    return [
      '2',
      `JAZZ1${SEP}JAZZ2`,
      `So What${SEP}So What (Live)`,
      `Miles Davis${SEP}Miles Davis`,
      `Kind of Blue${SEP}Live in Europe`,
      `1959${SEP}1969`,
      `Jazz${SEP}Jazz`,
      `100${SEP}60`,
      `12${SEP}1`,
    ].join('\n') + '\n'
  }
  if (script.includes('set ly to lyrics of t')) {
    return `C0FFEE12345678${SEP}Everything In Its Right Place${SEP}Radiohead${SEP}Everything\nIn its right place\n`
  }
  if (script.includes('set playlistCount to count of tracks of pl')) {
    return ['2', `1${SEP}Teardrop${SEP}Massive Attack${SEP}Mezzanine${SEP}ID1`, `2${SEP}So What${SEP}Miles Davis${SEP}Kind of Blue${SEP}JAZZ1`].join('\n') + '\n'
  }
  return null
}

/** Answers Music's queue script. */
function queueReply(script: string): string | null {
  if (script.includes('index of current track') && script.includes('repeat with k')) return QUEUE_REPLY + '\n'
  return null
}

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 6,
  bodyColumns: 140,
  scroll: { offset: 0, bodyRows: 5 },
  view: {},
}
const COMPOSER = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 140 } }

/** Stands for the engine's pane bookkeeping: the queue pane opens and is listed as open. */
function mockPanes(on: On) {
  const open = new Set<string>()
  on('ui.open', (_$, e) => {
    open.add(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.panes', () => ({
    value: [...open].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })),
  }))
  on('ui.close', (_$, e) => {
    open.delete(e.id)
    return { value: undefined }
  })
}

/**
 * Which players the mocked Mac has open, what Music says it is doing and
 * lists as its queue, and which scripts macOS refuses with a permission error.
 */
type MacOptions = { running?: string; musicLine?: string; queueReply?: string; refuse?: RegExp; store?: Record<string, unknown> | 'own'; catalogue?: string }

/**
 * Stands for the engine and a Mac beneath the plugin: store, clock and env
 * mocks, the panes, the catalogue, and `$.process.run` answered as a Mac with
 * Spotify playing and Music paused would, unless `mac` says otherwise.
 */
function mockMac(on: On, calls: string[][] = [], mac: MacOptions = {}) {
  const running = mac.running ?? '45315 Music\n50123 Spotify\n'
  const musicLine = mac.musicLine ?? MUSIC_LINE
  const queueListing = mac.queueReply ?? QUEUE_REPLY
  // The band has been shown once before, as it has for anyone past their first session.
  if (mac.store !== 'own') mock.store(on, mac.store ?? { isShown: true })
  mock.clock(on)
  mock.env(on, {})
  mockPanes(on)
  mockCatalogue(on, mac.catalogue)
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', (_$, e) => {
    calls.push([...e.argv])
    const [executable, , script = ''] = e.argv
    if (mac.refuse?.test(script)) {
      const stderr = 'execution error: Not authorized to send Apple events to Music. (-1743)'
      return { value: { exitCode: 1, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } }
    }
    let stdout = ''
    if (executable === 'defaults') stdout = 'en_GB\n'
    else if (executable === 'pgrep') stdout = running
    else if (script.includes('tell application "Spotify"') && script.includes('player state')) stdout = SPOTIFY_LINE + '\n'
    else if (script.includes('tell application "Music"') && queueReply(script) !== null) stdout = queueListing + '\n'
    else if (script.includes('tell application "Music"') && libraryReply(script) !== null) stdout = libraryReply(script) ?? ''
    else if (script.includes('tell application "Music"') && script.includes('player state')) stdout = musicLine + '\n'
    return {
      value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
}

/** Stands for the engine's own drawing beneath the plugin's, as one line of text. */
function mockEngineDrawing(on: On, text: string) {
  on('ui.render', ($engine, e) => {
    const { Text } = $engine.ui.resolve(e)
    const modes = e.component === 'SessionMode' ? e.props.modes.join(' & ') : text
    return <Text key="engine">{modes}</Text>
  })
}

const PANE_PROPS = { title: 'Up next', isFocused: false, bodyColumns: 60, placement: 'inline' as const, scroll: { offset: 0, bodyRows: 12 }, view: {} }

function sentScript(calls: string[][], fragment: string): string | undefined {
  return calls.map(argv => argv.join(' ')).find(line => line.includes(fragment))
}

describe('reading the players', () => {
  test('parses a Spotify reply into a snapshot the band can draw', () => {
    const reading = parseStatus('spotify', SPOTIFY_LINE + '\n', 1000)
    expect(reading?.state).toBe('playing')
    expect(reading?.title).toBe('Teardrop')
    expect(reading?.artist).toBe('Massive Attack')
    expect(reading?.durationSeconds).toBe(329)
    expect(reading?.volume).toBe(65)
    expect(reading?.shuffle).toBe(true)
    expect(reading?.repeat).toBe('off')
    expect(reading?.shareUrl).toBe('https://open.spotify.com/track/67Hna13dNDkZvBpTXRIaOJ')
    expect(reading?.artworkUrl).toBe('https://i.scdn.co/image/abc')
    expect(reading?.fetchedAt).toBe(1000)
  })

  test('reads a Music reply, with a locale that writes decimals with a comma', () => {
    const reading = parseStatus('music', MUSIC_LINE, 0)
    expect(reading?.positionSeconds).toBe(12.25)
    expect(reading?.repeat).toBe('one')
    expect(reading?.shareUrl).toBe(null)
    expect(reading?.trackId).toBe('C0FFEE12345678')
  })

  test('shows nothing for a player that is off, stopped or garbled', () => {
    expect(parseStatus('music', 'off', 0)).toBe(null)
    expect(parseStatus('music', 'stopped', 0)).toBe(null)
    expect(parseStatus('music', 'playing\u001fonly two', 0)).toBe(null)
  })

  test('finds the running players from pgrep output', () => {
    expect(parseRunningPlayers('45315 Music\n')).toEqual(['music'])
    expect(parseRunningPlayers('1 Spotify\n2 Music\n')).toEqual(['spotify', 'music'])
    expect(parseRunningPlayers('')).toEqual([])
  })

  test('follows the playing player and sticks with the last one shown on a tie', () => {
    const spotify = parseStatus('spotify', SPOTIFY_LINE, 0)
    const music = parseStatus('music', MUSIC_LINE, 0)
    expect(pickCurrent([music, spotify], 'music')?.source).toBe('spotify')
    const pausedSpotify = spotify === null ? null : { ...spotify, state: 'paused' as const }
    expect(pickCurrent([music, pausedSpotify], 'spotify')?.source).toBe('spotify')
    expect(pickCurrent([music, pausedSpotify], null)?.source).toBe('music')
    expect(pickCurrent([null, null], null)).toBe(null)
  })

  test('reads the playlist around the track on, each track by its own position', () => {
    const parsed = parseQueue(QUEUE_REPLY)
    expect(parsed?.currentIndex).toBe(5)
    expect(parsed?.playlistName).toBe('OK Computer')
    expect(parsed?.entries.length).toBe(4)
    expect(parsed?.entries[2]?.title).toBe('Subterranean Homesick Alien')
    expect(parsed?.entries[2]?.id).toBe('C0FFEE12345678')
    expect(parsed?.entries[2]?.album).toBe('OK Computer')
    expect(parseQueue('off')).toBe(null)
    expect(queueScript()).toContain('get name of track k of pl')
    expect(queueScript()).not.toContain(' thru ')
  })

  test('tells a refused permission from a player that is merely slow', () => {
    expect(classifyFailure('Not authorized to send Apple events to Music. (-1743)')).toBe('permission')
    expect(describeFailure('music', '(-1743)')).toContain('System Settings')
    expect(classifyFailure('AppleEvent timed out. (-1712)')).toBe('timeout')
    expect(describeFailure('music', 'AppleEvent timed out. (-1712)')).toContain('slow to answer')
    expect(describeFailure('music', 'AppleEvent timed out. (-1712)')).not.toContain('System Settings')
    expect(classifyFailure('syntax error')).toBe('other')
  })

  test('turns a Spotify URI into a link anyone can open', () => {
    expect(shareUrlFor('spotify:track:abc')).toBe('https://open.spotify.com/track/abc')
    expect(shareUrlFor('https://open.spotify.com/track/abc')).toBe('https://open.spotify.com/track/abc')
    expect(shareUrlFor('')).toBe(null)
  })
})

describe('scripting the players', () => {
  test('never launches a player: every script is guarded by is running', () => {
    expect(statusScript('music')).toContain('if application "Music" is not running then return "off"')
    expect(playByNameScript('x')).toContain('if application "Music" is not running then return "off"')
    expect(artworkExportScript('/tmp/c.src')).toContain('if application "Music" is not running then return "off"')
    expect(controlScript('spotify', 'next')).toBe(
      'if application "Spotify" is running then tell application "Spotify" to next track',
    )
  })

  test('speaks each player\'s own words for shuffle, repeat and volume', () => {
    expect(controlScript('music', { volume: 140 })).toContain('set sound volume to 100')
    expect(controlScript('music', 'toggleShuffle')).toContain('set shuffle enabled to not shuffle enabled')
    expect(controlScript('spotify', 'toggleShuffle')).toContain('set shuffling to not shuffling')
    expect(controlScript('music', { repeat: 'one' })).toContain('set song repeat to one')
    expect(controlScript('spotify', { repeat: 'all' })).toContain('set repeating to true')
    expect(controlScript('music', { playIndex: 7 })).toContain('play track 7 of current playlist')
  })

  test('cycles repeat off, all, one on Music and off, all on Spotify', () => {
    expect(nextRepeatMode('music', 'off')).toBe('all')
    expect(nextRepeatMode('music', 'all')).toBe('one')
    expect(nextRepeatMode('music', 'one')).toBe('off')
    expect(nextRepeatMode('spotify', 'off')).toBe('all')
    expect(nextRepeatMode('spotify', 'all')).toBe('off')
  })

  test('quotes a search so a name with quotes cannot break out of the script', () => {
    const script = playByNameScript('Say "Hello" \\ wave')
    expect(script).toContain('whose name contains "Say \\"Hello\\" \\\\ wave"')
  })
})

describe('formatting', () => {
  test('writes clocks as m:ss and h:mm:ss', () => {
    expect(formatClock(83.5)).toBe('1:23')
    expect(formatClock(3725)).toBe('1:02:05')
    expect(formatClock(-4)).toBe('0:00')
  })

  test('moves the position on between polls while playing, never past the end', () => {
    const reading = parseStatus('spotify', SPOTIFY_LINE, 10_000)
    if (reading === null) throw new Error('expected a reading')
    expect(positionNow(reading, 15_000)).toBe(88.5)
    expect(positionNow(reading, 10_000_000)).toBe(329)
    expect(positionNow({ ...reading, state: 'paused' }, 15_000)).toBe(83.5)
  })

  test('truncates long titles with an ellipsis and keeps short ones whole', () => {
    expect(truncateText('Teardrop', 20)).toBe('Teardrop')
    expect(truncateText('Everything In Its Right Place', 10)).toBe('Everythin…')
  })

  test('measures wide characters as two cells so a CJK or emoji title stays inside its row', () => {
    expect(cellWidth('Teardrop')).toBe(8)
    expect(cellWidth('東京は夜の七時')).toBe(14)
    expect(cellWidth('🎵 x')).toBe(4)
    expect(cellWidth('café')).toBe(4)
    expect(truncateText('東京は夜の七時 — ピチカート・ファイヴ', 6)).toBe('東京…')
    expect(truncateText('東京', 4)).toBe('東京')
  })

  test('fills the bar in proportion to the position, its head moving in eighths of a cell', () => {
    const bar = progressBar(50, 100, 10)
    expect(bar.played.length).toBe(5)
    expect(bar.remaining.length).toBe(5)
    // 55% of 10 cells is 5 cells and 4 eighths: a half block heads the bar.
    const between = progressBar(55, 100, 10)
    expect(between.played).toBe('█████▌')
    expect(between.remaining.length).toBe(4)
    expect(progressBar(0, 100, 4).played).toBe('')
    expect(progressBar(100, 100, 4).played).toBe('████')
  })

  test('drops status parts as the band gets narrower', () => {
    expect(layoutFor(160).showAlbum).toBe(true)
    expect(layoutFor(100).showAlbum).toBe(false)
    expect(layoutFor(100).showVolume).toBe(true)
    expect(layoutFor(70).showVolume).toBe(false)
    expect(layoutFor(50).showClock).toBe(false)
  })

  test('keeps the most-used controls when the band is narrow, in their drawn order', () => {
    const controls = [
      { label: 'prev', priority: 2 },
      { label: 'pause', priority: 0 },
      { label: 'next', priority: 1 },
      { label: 'shuffle', priority: 8 },
    ]
    expect(fitControls(controls, 200).map(c => c.label)).toEqual(['prev', 'pause', 'next', 'shuffle'])
    expect(fitControls(controls, 16).map(c => c.label)).toEqual(['pause', 'next'])
  })
})

describe('the footer', () => {
  test('adds the track to the bottom-right mode labels and keeps the engine\'s own', { options: { placement: 'footer' } }, async ($, on) => {
    mockMac(on)
    mockEngineDrawing(on, '')

    await $.command.run({ command: 'np', args: '', ...COMPOSER })

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'now-playing',
        surface,
        component: 'SessionMode',
        props: { modes: ['focus'] },
        viewport: { columns: 140, rows: 40 },
      })
      const footer = await ui.find({ type: 'Text', text: /focus & / })
      expect(footer?.text).toContain('focus & ♪ ▶ Teardrop — Massive Attack 1:23/5:29')
      await ui.unmount()
    }
  })

  test('leaves the band empty in footer placement so the prompt area stays clean', { options: { placement: 'footer' } }, async ($, on) => {
    mockMac(on)
    mockEngineDrawing(on, 'engine')
    await $.command.run({ command: 'np', args: '', ...COMPOSER })
    const ui = await $.ui.mount({ plugin: 'now-playing', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    expect(await ui.find({ key: 'playpause' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^engine$/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('the band', () => {
  test('draws the playing track with controls, and a press sends the command to that player', async ($, on) => {
    const calls: string[][] = []
    mockMac(on, calls)

    const { text } = await $.command.run({ command: 'np', args: '', ...COMPOSER })
    expect(text).toContain('Spotify playing: Teardrop — Massive Attack')

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'now-playing', surface, component: 'AbovePrompt', props: BAND_PROPS })
      expect(await ui.find({ key: 'title' })).toBeDefined()
      expect(await ui.find({ key: 'playpause' })).toBeDefined()
      expect(await ui.find({ key: 'shuffle' })).toBeDefined()

      calls.length = 0
      await ui.press({ key: 'playpause' })
      expect(sentScript(calls, 'playpause')).toContain('tell application "Spotify" to playpause')

      calls.length = 0
      await ui.press({ key: 'shuffle' })
      expect(sentScript(calls, 'shuffling')).toContain('set shuffling to not shuffling')
      await ui.unmount()
    }
  })

  test('draws the large band when the terminal has the rows: title, artist and the bar on rows of their own', async ($, on) => {
    const calls: string[][] = []
    mockMac(on, calls)
    await $.command.run({ command: 'np', args: '', ...COMPOSER })
    const ui = await $.ui.mount({ plugin: 'now-playing', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND_PROPS, maxRows: 12 } })
    expect(await ui.find({ type: 'Text', text: /^Teardrop$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Massive Attack · Mezzanine$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1:23\/5:29/ })).toBeDefined()
    expect(await ui.find({ key: 'title' })).toBeUndefined()
    expect(await ui.find({ key: 'open' })).toBeDefined()
    calls.length = 0
    await ui.press({ key: 'open' })
    expect(calls.find(argv => argv[0] === 'open')?.[2]).toBe('Spotify')
    await ui.unmount()
  })

  test('keeps the compact band when asked to, however tall the terminal', { options: { size: 'compact' } }, async ($, on) => {
    mockMac(on)
    await $.command.run({ command: 'np', args: '', ...COMPOSER })
    const ui = await $.ui.mount({ plugin: 'now-playing', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND_PROPS, maxRows: 12 } })
    expect(await ui.find({ key: 'title' })).toBeDefined()
    expect(await ui.find({ key: 'open' })).toBeUndefined()
    await ui.unmount()
  })

  test('collapses to the status row, without controls, while Claude is working', async ($, on) => {
    mockMac(on)
    await $.command.run({ command: 'np', args: '', ...COMPOSER })
    const ui = await $.ui.mount({
      plugin: 'now-playing',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { ...BAND_PROPS, isWorking: true },
    })
    expect(await ui.find({ type: 'Text', text: /Teardrop — Massive Attack/ })).toBeDefined()
    expect(await ui.find({ key: 'playpause' })).toBeUndefined()
    await ui.unmount()
  })

  test('mutes to silence and unmutes back to the volume it had', async ($, on) => {
    const calls: string[][] = []
    mockMac(on, calls)

    const muted = await $.command.run({ command: 'np', args: 'mute', ...COMPOSER })
    expect(muted.text).toContain('muted')
    expect(sentScript(calls, 'set sound volume to')).toContain('set sound volume to 0')
  })

  test('starts hidden until shown by /np show or by Claude, and remembers the choice', async ($, on) => {
    // A store with no record of a show: a fresh install. The test keeps it, to see what the mod writes.
    const stored: Record<string, unknown> = {}
    on('store.get', (_$, e) => ({ value: stored[e.key] }))
    on('store.set', (_$, e) => {
      stored[e.key] = e.value
      return { value: undefined }
    })
    mockMac(on, [], { store: 'own' })
    mockEngineDrawing(on, 'engine')

    const hidden = await $.ui.mount({ plugin: 'now-playing', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    expect(await hidden.find({ key: 'playpause' })).toBeUndefined()
    await hidden.unmount()

    const { result } = await $.tool.call({ tool: 'mcp__now-playing__show_now_playing', shown: true })
    expect(result).toContain('Now Playing shown')
    expect(result).toContain('Teardrop')
    expect(stored.isShown).toBe(true)
    const shown = await $.ui.mount({ plugin: 'now-playing', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    expect(await shown.find({ key: 'playpause' })).toBeDefined()
    await shown.unmount()

    const { text } = await $.command.run({ command: 'np', args: 'hide', ...COMPOSER })
    expect(text).toContain('hidden')
    expect(stored.isShown).toBe(false)
  })

  test('hides on request and draws nothing until shown again', { options: { placement: 'both' } }, async ($, on) => {
    mockMac(on)
    mockEngineDrawing(on, 'engine')
    const run = (args: string) => $.command.run({ command: 'np', args, ...COMPOSER })

    await run('')
    await run('hide')
    const ui = await $.ui.mount({ plugin: 'now-playing', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    expect(await ui.find({ key: 'playpause' })).toBeUndefined()
    await ui.unmount()

    await run('show')
    const shown = await $.ui.mount({ plugin: 'now-playing', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    expect(await shown.find({ key: 'playpause' })).toBeDefined()
    await shown.unmount()
  })
})

describe('the library and the playlist', () => {
  test('reads search results and picks the best match for a request', () => {
    const results = parseSearch(SEARCH_REPLY)
    expect(results.length).toBe(3)
    expect(splitTrackQuery('So What — Miles Davis')).toEqual({ title: 'So What', artist: 'Miles Davis' })
    expect(splitTrackQuery('So What by Miles Davis')).toEqual({ title: 'So What', artist: 'Miles Davis' })
    expect(splitTrackQuery('So What')).toEqual({ title: 'So What', artist: null })
    // A title with "by" in it keeps it when a dash names the artist, or when "by" comes last.
    expect(splitTrackQuery('Stand by Me — Ben E. King')).toEqual({ title: 'Stand by Me', artist: 'Ben E. King' })
    expect(splitTrackQuery('Killed by Death - Motörhead')).toEqual({ title: 'Killed by Death', artist: 'Motörhead' })
    expect(splitTrackQuery('Killed by Death by Motörhead')).toEqual({ title: 'Killed by Death', artist: 'Motörhead' })
    expect(pickBestMatch(results, 'So What', 'Miles Davis')?.id).toBe('JAZZ1')
    expect(pickBestMatch(results, 'so what', null)?.id).toBe('JAZZ1')
    expect(pickBestMatch(results, 'So What', 'Tribute')?.id).toBe('JAZZ3')
    expect(pickBestMatch(results, 'So What Live', 'Miles Davis')?.id).toBe('JAZZ2')
    // A request whose title matches nothing is not answered with an unrelated first result.
    expect(pickBestMatch(results, 'Blue in Green', 'Miles Davis')).toBe(null)
    expect(pickBestMatch([], 'x', null)).toBe(null)
  })

  test('searches the Apple Music catalogue in the Mac\'s storefront and drops what the library already has', () => {
    expect(storefrontFrom('en_GB')).toBe('GB')
    expect(storefrontFrom('de_DE@currency=EUR')).toBe('DE')
    expect(storefrontFrom('')).toBe('US')
    const url = catalogueSearchUrl('so what miles', 'en_GB', 5)
    expect(url).toContain('https://itunes.apple.com/search?')
    expect(url).toContain('term=so+what+miles')
    expect(url).toContain('country=GB')
    expect(url).toContain('entity=song')
    expect(musicAppUrl('https://music.apple.com/gb/album/x/1?i=2')).toBe('music://music.apple.com/gb/album/x/1?i=2')

    const catalogue = parseCatalogue(CATALOGUE_REPLY)
    expect(catalogue.length).toBe(2)
    expect(catalogue[0]?.kind).toBe('catalogue')
    expect(catalogue[0]?.url).toBe('music://music.apple.com/gb/album/so-what/268443092?i=268443097&uo=4')
    expect(parseCatalogue('not json')).toEqual([])

    const library = parseSearch(SEARCH_REPLY)
    const unowned = withoutLibraryDuplicates(catalogue, library)
    expect(unowned.map(result => result.title)).toEqual(['Take Five'])
  })

  test('runs a batch of searches in one script and reads one block of results per request', () => {
    const script = searchLibraryManyScript(['so what miles', 'take five'], 3)
    expect(script).toContain('set queries to {"so what miles", "take five"}')
    expect(script).toContain('search library playlist 1 for needle')
    const reply = `${SEARCH_REPLY}\n${RS}${RS}`
    const blocks = parseSearchMany(reply, 2)
    expect(blocks.length).toBe(2)
    expect(blocks[0]?.length).toBe(3)
    expect(blocks[1]).toEqual([])
    expect(parseSearchMany('off', 2)).toEqual([[], []])
  })

  test('scripts search, create the playlist and skip duplicates, quoting what the person typed', () => {
    expect(searchLibraryScript('say "hi"')).toContain('search library playlist 1 for "say \\"hi\\""')
    const script = addTracksScript('Claude Code', ['A1', 'B2'])
    expect(script).toContain('if not (exists user playlist "Claude Code") then make new user playlist')
    expect(script).toContain('set wanted to {"A1", "B2"}')
    expect(script).toContain('set wantedId to contents of wantedRef')
    expect(script).toContain('whose persistent ID is wantedId')
    expect(parseAdded(`2${SEP}1${SEP}7`)).toEqual({ added: 2, skipped: 1, count: 7 })
    expect(parseAdded('off')).toBe(null)
  })

  test('/np clear empties the playlist but keeps the playlist and the library', async ($, on) => {
    const script = clearPlaylistScript('Claude Code')
    expect(script).toContain('if not (exists user playlist "Claude Code") then return "0"')
    expect(script).toContain('delete every track of pl')
    expect(script).not.toContain('delete pl')
    expect(parseCleared('2\n')).toBe(2)
    expect(parseCleared('off')).toBe(null)

    const calls: string[][] = []
    // Music is the player on here, so the pane shows Music's queue, which a clear changes under the same track.
    mockMac(on, calls, { running: '45315 Music\n', musicLine: MUSIC_LINE.replace('paused', 'playing') })
    await $.command.run({ command: 'np', args: 'queue', ...COMPOSER })
    calls.length = 0

    const { text } = await $.command.run({ command: 'np', args: 'clear', ...COMPOSER })
    expect(text).toContain('Removed 2 tracks from "Claude Code"')
    expect(sentScript(calls, 'delete every track of pl')).toContain('user playlist "Claude Code"')
    // Both halves of the pane are re-read afterwards: the mod's playlist and Music's queue.
    expect(sentScript(calls, 'set playlistCount to count of tracks of pl')).toBeDefined()
    expect(sentScript(calls, 'index of current track')).toBeDefined()
  })

  test('Claude controls the player, asks what is on and reads the history through its tools', async ($, on) => {
    const calls: string[][] = []
    mockMac(on, calls)
    const paused = await $.tool.call({ tool: 'mcp__now-playing__control_player', action: 'pause' })
    expect(String(paused.result)).toContain('Spotify: pause.')
    expect(sentScript(calls, 'tell application "Spotify" to pause')).toBeDefined()
    const louder = await $.tool.call({ tool: 'mcp__now-playing__control_player', action: 'volume', nudge: 'up' })
    expect(String(louder.result)).toContain('volume 75%')
    const level = await $.tool.call({ tool: 'mcp__now-playing__control_player', action: 'volume', volume: 20 })
    expect(String(level.result)).toContain('volume 20%')

    const status = await $.tool.call({ tool: 'mcp__now-playing__now_playing' })
    expect(String(status.result)).toContain('Spotify playing: Teardrop — Massive Attack')

    // The first refresh recorded the listen, with the id add_tracks takes.
    const history = await $.tool.call({ tool: 'mcp__now-playing__listening_history' })
    expect(String(history.result)).toContain('Teardrop — Massive Attack · Mezzanine (Spotify, id spotify:track:67Hna13dNDkZvBpTXRIaOJ)')
    const { text } = await $.command.run({ command: 'np', args: 'history 5', ...COMPOSER })
    expect(text).toContain('Last 1 of 1 listens')
  })

  test('filters the library by its facts, adds a pick by id and removes it again', async ($, on) => {
    const calls: string[][] = []
    mockMac(on, calls)
    const found = await $.tool.call({ tool: 'mcp__now-playing__search_library', genre: 'Jazz', yearTo: 1960, sort: 'leastPlayed', limit: 1 })
    const text = String(found.result)
    expect(sentScript(calls, 'whose media kind is song and genre contains "Jazz" and year <= 1960')).toBeDefined()
    expect(text).toContain('2 library songs match genre Jazz, years …–1960; 1 shown, leastPlayed')
    expect(text).toContain('So What (Live) — Miles Davis · Live in Europe [1969, Jazz, 3★, 1 play] (id JAZZ2)')
    // A free-text query narrows the filtered matches here, not in Music.
    const narrowed = await $.tool.call({ tool: 'mcp__now-playing__search_library', query: 'live', genre: 'Jazz' })
    expect(String(narrowed.result)).toContain('1 library song match')
    expect(String(narrowed.result)).not.toContain('(id JAZZ1)')

    calls.length = 0
    const added = await $.tool.call({ tool: 'mcp__now-playing__add_tracks', ids: ['JAZZ2'], play: false })
    expect(String(added.result)).toContain('Added 1 track by id to the Claude Code playlist')
    expect(sentScript(calls, 'set wanted to')).toContain('set wanted to {"JAZZ2"}')

    const removed = await $.tool.call({ tool: 'mcp__now-playing__remove_tracks', ids: ['JAZZ2'] })
    expect(String(removed.result)).toContain('Removed 1 track from the Claude Code playlist; 1 left')
    expect(sentScript(calls, 'delete (first track of pl whose persistent ID is wantedId)')).toContain('user playlist "Claude Code"')
  })

  test('/np lyrics opens a pane with the lyrics Music holds, on every surface, and Claude can read them', async ($, on) => {
    mockMac(on, [], { running: '45315 Music\n', musicLine: MUSIC_LINE.replace('paused', 'playing') })
    const { text } = await $.command.run({ command: 'np', args: 'lyrics', ...COMPOSER })
    expect(text).toContain('Lyrics opened for Everything In Its Right Place — Radiohead')
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'now-playing', surface, component: 'Pane', requestId: 'now-playing-lyrics', props: { ...PANE_PROPS, title: 'Lyrics' } })
      expect(await ui.find({ type: 'Text', text: /In its right place/ })).toBeDefined()
      await ui.unmount()
    }
    const status = await $.tool.call({ tool: 'mcp__now-playing__now_playing', lyrics: true, upNext: 2 })
    expect(String(status.result)).toContain('up next: Exit Music — Radiohead')
    expect(String(status.result)).toContain('Lyrics of Everything In Its Right Place — Radiohead:\nEverything\nIn its right place')
  })

  test('/np add finds the best library match, adds it to the playlist and starts it when idle', async ($, on) => {
    const calls: string[][] = []
    mockMac(on, calls)

    const { text } = await $.command.run({ command: 'np', args: 'add So What — Miles Davis', ...COMPOSER })
    expect(text).toContain('Added 1 track to the Claude Code playlist')
    expect(text).toContain('not in Up next')
    expect(text).toContain('So What — Miles Davis · Kind of Blue')
    expect(sentScript(calls, 'set wanted to')).toContain('set wanted to {"JAZZ1"}')
    // Spotify is playing in this mock, so the playlist is not started over it.
    expect(sentScript(calls, 'play user playlist')).toBeUndefined()

    // The pane lists the playlist's tracks, the new one included, and a press starts it there.
    const ui = await $.ui.mount({
      plugin: 'now-playing',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'now-playing-queue',
      props: PANE_PROPS,
    })
    expect(await ui.find({ type: 'Text', text: /Up next · Spotify/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Claude Code playlist · 2 tracks/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Add to the Claude Code playlist/ })).toBeDefined()
    // Spotify is on, so the pane says where an add really goes, and the library limit is always stated.
    expect(await ui.find({ type: 'Text', text: /Spotify is on: this adds to your Apple Music playlist/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Only songs already in your Music library/ })).toBeDefined()
    expect(await ui.find({ key: 'playlist-2' })).toBeDefined()
    calls.length = 0
    await ui.press({ key: 'playlist-2' })
    expect(sentScript(calls, 'play track 2 of user playlist')).toContain('play track 2 of user playlist "Claude Code"')
    calls.length = 0
    await ui.press({ key: 'remove-JAZZ1' })
    expect(sentScript(calls, 'delete (first track of pl whose persistent ID is wantedId)')).toContain('"JAZZ1"')
    expect(await ui.find({ key: 'clear-playlist' })).toBeDefined()
    await ui.unmount()
    const desktop = await $.ui.mount({ plugin: 'now-playing', surface: 'desktop', component: 'Pane', requestId: 'now-playing-queue', props: PANE_PROPS })
    expect(await desktop.find({ key: 'playlist-2' })).toBeDefined()
    expect(await desktop.find({ type: 'Text', text: /Add to the Claude Code playlist/ })).toBeDefined()
    await desktop.unmount()
  })

  test('Claude adds a batch through its tool and hears which tracks the library lacks', async ($, on) => {
    const calls: string[][] = []
    mockMac(on, calls)

    const text = await $.command.run({ command: 'np', args: 'add So What — Miles Davis', ...COMPOSER })
    expect(text.text).toContain('Added')

    calls.length = 0
    const outcome = await $.tool.call({ tool: 'mcp__now-playing__add_tracks', tracks: ['So What — Miles Davis', 'Take Five — Dave Brubeck'] })
    expect(outcome.deny).toBeUndefined()
    const summary = String(outcome.result)
    expect(summary).toContain('Added 1 track')
    expect(summary).toContain('So What — Miles Davis · Kind of Blue')
    expect(summary).toContain('Take Five — Dave Brubeck: Take Five — The Dave Brubeck Quartet · Time Out → music://music.apple.com/gb/album/take-five/2?i=1')
    // Both requests went to Music in one script, not one osascript each.
    expect(calls.filter(argv => argv.join(' ').includes('search library playlist 1 for')).length).toBe(1)
  })

  test('search_library still lists Apple Music matches, and says why the library was skipped, with Music closed', async ($, on) => {
    mockMac(on, [], { running: '50123 Spotify\n' })
    const outcome = await $.tool.call({ tool: 'mcp__now-playing__search_library', query: 'so what' })
    const result = String(outcome.result)
    expect(result).toContain('Music is not running')
    expect(result).toContain('Take Five — The Dave Brubeck Quartet')
  })

  test('a catalogue-only search never asks the library, nor blames it when nothing is found', async ($, on) => {
    const calls: string[][] = []
    mockMac(on, calls, { running: '50123 Spotify\n', catalogue: '{"results":[]}' })
    const outcome = await $.tool.call({ tool: 'mcp__now-playing__search_library', query: 'nothing', scope: 'catalogue' })
    expect(String(outcome.result)).toContain('Nothing on Apple Music matches "nothing"')
    expect(String(outcome.result)).not.toContain('Music is not running')
    expect(sentScript(calls, 'search library playlist 1 for')).toBeUndefined()
  })

  test('add_tracks reports a library that could not be searched, not fifty tracks nobody owns', async ($, on) => {
    mockMac(on, [], { refuse: /set queries to/ })
    const outcome = await $.tool.call({ tool: 'mcp__now-playing__add_tracks', tracks: ['So What — Miles Davis'] })
    const summary = String(outcome.result)
    expect(summary).toContain('nothing was added')
    expect(summary).toContain('System Settings')
    expect(summary).not.toContain('Not in the library')
  })

  test('add_tracks with no library match leaves the playlist alone and says so, without a made-up count', async ($, on) => {
    const calls: string[][] = []
    mockMac(on, calls)
    const outcome = await $.tool.call({ tool: 'mcp__now-playing__add_tracks', tracks: ['Take Five — Dave Brubeck'] })
    const summary = String(outcome.result)
    expect(summary).toContain('the Claude Code playlist is unchanged')
    expect(summary).not.toContain('in it now')
    expect(summary).toContain('Take Five — The Dave Brubeck Quartet')
    expect(sentScript(calls, 'set wanted to')).toBeUndefined()
  })

  test('/np playlist reports a refused start instead of claiming the playlist plays', async ($, on) => {
    mockMac(on, [], { refuse: /play user playlist/ })
    const { text } = await $.command.run({ command: 'np', args: 'playlist', ...COMPOSER })
    expect(text).not.toContain('Playing "Claude Code"')
    expect(text).toContain('System Settings')
  })
})

describe('the queue pane', () => {
  test('marks the row Music is on when the same song appears twice, leaving the other pressable', async ($, on) => {
    const twice = [
      `5${SEP}Mixtape`,
      `3${SEP}Intro${SEP}Radiohead${SEP}OK Computer${SEP}C0FFEE12345678`,
      `4${SEP}Airbag${SEP}Radiohead${SEP}OK Computer${SEP}ID4`,
      `5${SEP}Intro${SEP}Radiohead${SEP}OK Computer${SEP}C0FFEE12345678`,
    ].join('\n')
    mockMac(on, [], { running: '45315 Music\n', musicLine: MUSIC_LINE.replace('paused', 'playing'), queueReply: twice })
    await $.command.run({ command: 'np', args: 'queue', ...COMPOSER })
    const ui = await $.ui.mount({ plugin: 'now-playing', surface: 'terminal', component: 'Pane', requestId: 'now-playing-queue', props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: /Up next · Mixtape/ })).toBeDefined()
    expect(await ui.find({ key: 'queue-3' })).toBeDefined()
    expect(await ui.find({ key: 'queue-4' })).toBeDefined()
    expect(await ui.find({ key: 'queue-5' })).toBeUndefined()
    await ui.unmount()
  })

  test('lists Music\'s playlist around the track on, and a press plays that track', async ($, on) => {
    const calls: string[][] = []
    mockMac(on, calls, { running: '45315 Music\n', musicLine: MUSIC_LINE.replace('paused', 'playing') })

    // A status refresh alone preloads the queue, before the pane is ever opened.
    await $.command.run({ command: 'np', args: '', ...COMPOSER })
    expect(sentScript(calls, 'index of current track')).toBeDefined()

    // Opening the pane then needs no second read of the queue.
    calls.length = 0
    await $.command.run({ command: 'np', args: 'queue', ...COMPOSER })
    expect(sentScript(calls, 'index of current track')).toBeUndefined()
    const ui = await $.ui.mount({
      plugin: 'now-playing',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'now-playing-queue',
      props: PANE_PROPS,
    })
    expect(await ui.find({ type: 'Text', text: /OK Computer/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Subterranean Homesick Alien/ })).toBeDefined()
    // With covers drawn, each row names the artist and album on a line of its own.
    expect(await ui.find({ type: 'Text', text: /Radiohead · OK Computer/ })).toBeDefined()
    expect(await ui.find({ key: 'queue-6' })).toBeDefined()
    expect(await ui.find({ key: 'search' })).toBeDefined()

    await ui.input({ key: 'search', text: 'so what' })
    expect(await ui.find({ key: 'add-JAZZ1' })).toBeDefined()
    expect(await ui.find({ key: 'open-1' })).toBeDefined()
    expect(await ui.find({ key: 'open-268443097' })).toBeUndefined()
    calls.length = 0
    await ui.press({ key: 'open-1' })
    expect(calls.find(argv => argv[0] === 'open')?.[1]).toBe('music://music.apple.com/gb/album/take-five/2?i=1')
    calls.length = 0
    await ui.press({ key: 'add-JAZZ1' })
    expect(sentScript(calls, 'set wanted to')).toContain('set wanted to {"JAZZ1"}')
    await ui.press({ key: 'clear-search' })
    expect(await ui.find({ key: 'add-JAZZ1' })).toBeUndefined()

    calls.length = 0
    await ui.press({ key: 'queue-6' })
    expect(sentScript(calls, 'play track')).toContain('play track 6 of current playlist')
    expect(await ui.find({ key: 'close-queue' })).toBeDefined()
    await ui.unmount()

    const { text } = await $.command.run({ command: 'np', args: 'queue', ...COMPOSER })
    expect(text).toContain('closed')
  })
})

describe('thumbnails for terminals without pictures', () => {
  /** A 2 by 2, 24-bit, top-down BMP as sips writes one: red, green / blue, white. */
  function tinyBmp(): Uint8Array {
    const header = new Uint8Array(54)
    header[0] = 0x42
    header[1] = 0x4d
    header[10] = 54
    header[14] = 40
    header[18] = 2
    header[22] = 0xfe
    header[23] = 0xff
    header[24] = 0xff
    header[25] = 0xff
    header[26] = 1
    header[28] = 24
    const rows = [
      [0, 0, 255, 0, 255, 0, 0, 0],
      [255, 0, 0, 255, 255, 255, 0, 0],
    ]
    return Uint8Array.from([...header, ...rows[0]!, ...rows[1]!])
  }

  test('decodes the BMP sips writes into pixels from the top left', () => {
    const picture = decodeBmp(tinyBmp())
    expect(picture?.width).toBe(2)
    expect(picture?.height).toBe(2)
    expect(picture?.pixels).toEqual([0xff0000, 0x00ff00, 0x0000ff, 0xffffff])
    expect(decodeBmp(Uint8Array.from([1, 2, 3]))).toBe(null)
  })

  test('folds two pixel rows into one row of half-block cells and packs them for Raster', () => {
    const picture = decodeBmp(tinyBmp())
    if (picture === null) throw new Error('expected a picture')
    const cells = thumbnailCells(picture, 2, 1)
    expect(cells).toEqual([
      { codePoint: 0x2580, foreground: 0xff0000, background: 0x0000ff },
      { codePoint: 0x2580, foreground: 0x00ff00, background: 0xffffff },
    ])
    const packed = bytesFromBase64(encodeCells(cells))
    const words = new Uint32Array(packed.buffer, packed.byteOffset, packed.length / 4)
    expect([...words]).toEqual([0x2580, 0xff0000, 0x0000ff, 0x2580, 0x00ff00, 0xffffff])
  })

  test('shrinks a picture by averaging the pixels each cell covers', () => {
    const picture = { width: 2, height: 2, pixels: [0x000000, 0xffffff, 0x000000, 0xffffff] }
    expect(sampleThumbnail(picture, 1, 1).pixels).toEqual([0x808080])
    expect(sampleThumbnail(picture, 2, 1).pixels).toEqual([0x000000, 0xffffff])
  })
})
