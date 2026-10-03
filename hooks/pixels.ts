/**
 * Tiny pictures for terminals without an image protocol: decoding the small
 * BMP `sips` writes, shrinking it to a grid, and packing that grid into the
 * half-block cells a `Raster` element draws, two pixels per cell.
 */
import type { Thumbnail } from '../types'

const BMP_HEADER_BYTES = 54
const BITS_PER_BYTE = 8
const UPPER_HALF_BLOCK = 0x2580
const BYTES_PER_CELL_WORD = 4
const WORDS_PER_CELL = 3

/** One terminal cell: its glyph and the two colours, as `0xRRGGBB`. */
type Cell = { codePoint: number; foreground: number; background: number }

function readU16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)
}

function readI32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16) | ((bytes[offset + 3] ?? 0) << 24)) | 0
}

/**
 * Reads an uncompressed 24- or 32-bit BMP into `0xRRGGBB` pixels, row-major
 * from the top. Returns null for anything else.
 */
export function decodeBmp(bytes: Uint8Array): Thumbnail | null {
  if (bytes.length < BMP_HEADER_BYTES || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return null
  const pixelOffset = readI32(bytes, 10)
  const width = readI32(bytes, 18)
  const rawHeight = readI32(bytes, 22)
  const bitsPerPixel = readU16(bytes, 28)
  const compression = readI32(bytes, 30)
  if (width <= 0 || rawHeight === 0 || compression !== 0) return null
  if (bitsPerPixel !== 24 && bitsPerPixel !== 32) return null

  const height = Math.abs(rawHeight)
  const isTopDown = rawHeight < 0
  const bytesPerPixel = bitsPerPixel / BITS_PER_BYTE
  const stride = Math.ceil((width * bytesPerPixel) / 4) * 4
  if (pixelOffset + stride * height > bytes.length) return null

  const pixels: number[] = []
  for (let row = 0; row < height; row++) {
    const sourceRow = isTopDown ? row : height - 1 - row
    const rowStart = pixelOffset + sourceRow * stride
    for (let column = 0; column < width; column++) {
      const at = rowStart + column * bytesPerPixel
      const blue = bytes[at] ?? 0
      const green = bytes[at + 1] ?? 0
      const red = bytes[at + 2] ?? 0
      pixels.push((red << 16) | (green << 8) | blue)
    }
  }
  return { width, height, pixels }
}

/** Shrinks a picture to `width` by `height` by averaging the pixels each cell covers. */
export function sampleThumbnail(source: Thumbnail, width: number, height: number): Thumbnail {
  const pixels: number[] = []
  for (let row = 0; row < height; row++) {
    const top = Math.floor((row * source.height) / height)
    const bottom = Math.max(top + 1, Math.floor(((row + 1) * source.height) / height))
    for (let column = 0; column < width; column++) {
      const left = Math.floor((column * source.width) / width)
      const right = Math.max(left + 1, Math.floor(((column + 1) * source.width) / width))
      let red = 0
      let green = 0
      let blue = 0
      let count = 0
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          const pixel = source.pixels[y * source.width + x] ?? 0
          red += (pixel >> 16) & 0xff
          green += (pixel >> 8) & 0xff
          blue += pixel & 0xff
          count++
        }
      }
      const average = (channel: number) => Math.round(channel / Math.max(1, count))
      pixels.push((average(red) << 16) | (average(green) << 8) | average(blue))
    }
  }
  return { width, height, pixels }
}

/**
 * Folds a picture into `columns` by `rows` half-block cells: each cell shows
 * two pixels, the upper as the glyph's colour and the lower as its background.
 */
export function thumbnailCells(source: Thumbnail, columns: number, rows: number): Cell[] {
  const grid = sampleThumbnail(source, columns, rows * 2)
  const cells: Cell[] = []
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const upper = grid.pixels[row * 2 * columns + column] ?? 0
      const lower = grid.pixels[(row * 2 + 1) * columns + column] ?? 0
      cells.push({ codePoint: UPPER_HALF_BLOCK, foreground: upper, background: lower })
    }
  }
  return cells
}

/** Packs cells as `Raster` wants them: little-endian u32 triplets, base64. */
export function encodeCells(cells: readonly Cell[]): string {
  const bytes = new Uint8Array(cells.length * WORDS_PER_CELL * BYTES_PER_CELL_WORD)
  let at = 0
  for (const cell of cells) {
    for (const word of [cell.codePoint, cell.foreground, cell.background]) {
      bytes[at++] = word & 0xff
      bytes[at++] = (word >> 8) & 0xff
      bytes[at++] = (word >> 16) & 0xff
      bytes[at++] = (word >> 24) & 0xff
    }
  }
  return btoa(String.fromCharCode(...bytes))
}

/** The bytes behind the base64 the host hands over, as `$.fs.read(path, { as: 'bytes' })` answers. */
export function bytesFromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), character => character.charCodeAt(0))
}
