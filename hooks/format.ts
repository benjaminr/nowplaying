/**
 * Pure helpers for the band: clocks, truncation, the progress bar, the
 * position between polls, and which controls fit the width the band is given.
 */
import type { NowPlaying } from '../types'

const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60
export const MS_PER_SECOND = 1000
const ELLIPSIS = '…'

const BAR_FILLED = '█'
const BAR_EMPTY = '░'
/** The left-aligned partial blocks, by eighths filled: the bar's head moves in sub-cell steps. */
const BAR_EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']
const EIGHTHS_PER_CELL = BAR_EIGHTHS.length

/** `m:ss`, or `h:mm:ss` past an hour. */
export function formatClock(totalSeconds: number): string {
  const whole = Math.max(0, Math.floor(totalSeconds))
  const seconds = whole % SECONDS_PER_MINUTE
  const minutes = Math.floor(whole / SECONDS_PER_MINUTE) % MINUTES_PER_HOUR
  const hours = Math.floor(whole / (SECONDS_PER_MINUTE * MINUTES_PER_HOUR))
  const paddedSeconds = String(seconds).padStart(2, '0')
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${paddedSeconds}`
  }
  return `${minutes}:${paddedSeconds}`
}

/**
 * The code point ranges a terminal draws two cells wide: the East Asian wide
 * and fullwidth blocks (Hangul, kana, CJK ideographs and their forms). Emoji
 * are checked separately, by property.
 */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x20000, 0x3fffd],
]
/** Pictographs from here on are the colour emoji that take two cells; the older symbols below are one. */
const FIRST_EMOJI_CODE_POINT = 0x1f000
const WIDE_CELLS = 2
const NARROW_CELLS = 1

/**
 * How many terminal cells one character takes: none for a combining mark or
 * a zero-width joiner, two for CJK and emoji, one for the rest. An
 * approximation of wcwidth close enough to keep a title inside its row.
 */
function cellsFor(character: string): number {
  const codePoint = character.codePointAt(0) ?? 0
  if (/^[\p{M}\u200b-\u200f\ufe0f]$/u.test(character)) return 0
  if (WIDE_RANGES.some(([first, last]) => codePoint >= first && codePoint <= last)) return WIDE_CELLS
  if (codePoint >= FIRST_EMOJI_CODE_POINT && /^\p{Extended_Pictographic}$/u.test(character)) return WIDE_CELLS
  return NARROW_CELLS
}

/** The terminal cells `text` occupies on one row. */
export function cellWidth(text: string): number {
  let cells = 0
  for (const character of text) cells += cellsFor(character)
  return cells
}

/** Cuts `text` to `width` cells, ending with an ellipsis when it was longer. */
export function truncateText(text: string, width: number): string {
  if (width <= 0) return ''
  if (cellWidth(text) <= width) return text
  if (width === 1) return ELLIPSIS
  const room = width - cellWidth(ELLIPSIS)
  let kept = ''
  let used = 0
  for (const character of text) {
    const cells = cellsFor(character)
    if (used + cells > room) break
    kept += character
    used += cells
  }
  return kept + ELLIPSIS
}

/**
 * The played and unplayed halves of a bar `width` cells wide. The played
 * half ends in a partial block, so the head advances eight times per cell
 * rather than jumping a whole cell at a time.
 */
export function progressBar(
  positionSeconds: number,
  durationSeconds: number,
  width: number,
): { played: string; remaining: string } {
  if (width <= 0) return { played: '', remaining: '' }
  const fraction = durationSeconds > 0 ? Math.min(1, Math.max(0, positionSeconds / durationSeconds)) : 0
  const eighths = Math.round(fraction * width * EIGHTHS_PER_CELL)
  const fullCells = Math.floor(eighths / EIGHTHS_PER_CELL)
  const head = BAR_EIGHTHS[eighths % EIGHTHS_PER_CELL] ?? ''
  const playedCells = fullCells + (head === '' ? 0 : 1)
  return {
    played: BAR_FILLED.repeat(fullCells) + head,
    remaining: BAR_EMPTY.repeat(Math.max(0, width - playedCells)),
  }
}

/**
 * Where the track is now: the last reading, moved on by the time since it was
 * taken while playing, and never past the end.
 */
export function positionNow(reading: NowPlaying, nowMs: number): number {
  if (reading.state !== 'playing') return reading.positionSeconds
  const elapsed = Math.max(0, nowMs - reading.fetchedAt) / MS_PER_SECOND
  const moved = reading.positionSeconds + elapsed
  return reading.durationSeconds > 0 ? Math.min(reading.durationSeconds, moved) : moved
}

/** Which optional parts of the status row fit a given width. */
type BandLayout = {
  showAlbum: boolean
  showBar: boolean
  showClock: boolean
  showVolume: boolean
  barWidth: number
}

const WIDE_COLUMNS = 120
const ROOMY_COLUMNS = 90
const NARROW_COLUMNS = 60
const FULL_BAR_WIDTH = 16

export function layoutFor(bodyColumns: number): BandLayout {
  if (bodyColumns >= WIDE_COLUMNS) {
    return { showAlbum: true, showBar: true, showClock: true, showVolume: true, barWidth: FULL_BAR_WIDTH }
  }
  if (bodyColumns >= ROOMY_COLUMNS) {
    return { showAlbum: false, showBar: false, showClock: true, showVolume: true, barWidth: 0 }
  }
  if (bodyColumns >= NARROW_COLUMNS) {
    return { showAlbum: false, showBar: false, showClock: true, showVolume: false, barWidth: 0 }
  }
  return { showAlbum: false, showBar: false, showClock: false, showVolume: false, barWidth: 0 }
}

/** A plain Button draws as `b: prev`: the hotkey, a colon, a space, the label. */
const PLAIN_BUTTON_CHROME = 3
/** The cells a row's `gap={1}` leaves between two buttons. */
export const BUTTON_GAP = 1

/** The cells a plain Button with a hotkey takes: `x: label`. */
export function plainButtonWidth(label: string): number {
  return cellWidth(label) + PLAIN_BUTTON_CHROME
}

/**
 * Keeps, in their given order, the controls that fit `width` when taken by
 * rising `priority` (lower first): the most-used controls survive a narrow band.
 */
export function fitControls<T extends { label: string; priority: number }>(controls: readonly T[], width: number): T[] {
  const byPriority = [...controls].sort((a, b) => a.priority - b.priority)
  const kept = new Set<T>()
  let used = 0
  for (const control of byPriority) {
    const cost = plainButtonWidth(control.label) + (kept.size > 0 ? BUTTON_GAP : 0)
    if (used + cost > width) continue
    used += cost
    kept.add(control)
  }
  return controls.filter(control => kept.has(control))
}
