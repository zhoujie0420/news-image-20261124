// One image summing up the world's news of Tuesday 24 November 2026.
//
// The program draws a newspaper front page in code — no network, no
// bundled image — and writes it to /output/entry.png as a whole PNG
// (at most 1 MiB, 1024 by 1024). Fully deterministic: the same bytes
// on every run. Node 22 standard library only.
//
// Layout (1024 x 1024):
//   masthead ............. the date, big, so the day is unmistakable
//   2 x 2 story grid ..... NATO AWACS, Korea alert, Russian war dead,
//                          Huang's $34bn day
//   bottom strip ......... four one-line briefs, full width
//
// Run it: mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const W = 1024;
const H = 1024;

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------
type RGB = [number, number, number];
const PAPER: RGB = [247, 242, 230];
const INK: RGB = [24, 24, 24];
const NAVY: RGB = [15, 32, 58];
const WHITE: RGB = [255, 255, 255];
const RED: RGB = [183, 58, 46];
const BLUE: RGB = [32, 84, 160];
const TEAL: RGB = [13, 118, 110];
const GREEN: RGB = [28, 116, 50];
const SLATE: RGB = [70, 86, 104];
const MUTED: RGB = [88, 88, 80];
const CELL: RGB = [255, 255, 255];
const GOLD: RGB = [176, 132, 32];

// ---------------------------------------------------------------------------
// Canvas: an RGB buffer plus the drawing primitives
// ---------------------------------------------------------------------------
const img = new Uint8Array(W * H * 3);

function setPixel(x: number, y: number, c: RGB): void {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  img[i] = c[0];
  img[i + 1] = c[1];
  img[i + 2] = c[2];
}

function rect(x: number, y: number, w: number, h: number, c: RGB): void {
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(W, x + w);
  const y1 = Math.min(H, y + h);
  for (let yy = y0; yy < y1; yy++) {
    let i = (yy * W + x0) * 3;
    for (let xx = x0; xx < x1; xx++) {
      img[i] = c[0];
      img[i + 1] = c[1];
      img[i + 2] = c[2];
      i += 3;
    }
  }
}

function hline(x0: number, x1: number, y: number, c: RGB): void {
  if (y < 0 || y >= H) return;
  const a = Math.max(0, Math.min(x0, x1));
  const b = Math.min(W - 1, Math.max(x0, x1));
  for (let x = a; x <= b; x++) setPixel(x, y, c);
}

// Bresenham segment; w > 1 draws a square brush.
function seg(x0: number, y0: number, x1: number, y1: number, c: RGB, w = 1): void {
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = x0;
  let y = y0;
  for (;;) {
    if (w <= 1) setPixel(x, y, c);
    else rect(x - ((w / 2) | 0), y - ((w / 2) | 0), w, w, c);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
}

function disc(cx: number, cy: number, r: number, c: RGB): void {
  for (let dy = -r; dy <= r; dy++) {
    const dx = Math.floor(Math.sqrt(r * r - dy * dy));
    hline(cx - dx, cx + dx, cy + dy, c);
  }
}

function ring(cx: number, cy: number, r: number, t: number, c: RGB): void {
  for (let dy = -r; dy <= r; dy++) {
    const outer = Math.floor(Math.sqrt(r * r - dy * dy));
    const inner = r - t > 0 ? Math.floor(Math.sqrt((r - t) * (r - t) - dy * dy)) : -1;
    if (inner >= 0) {
      hline(cx - outer, cx - inner - 1, cy + dy, c);
      hline(cx + inner + 1, cx + outer, cy + dy, c);
    } else {
      hline(cx - outer, cx + outer, cy + dy, c);
    }
  }
}

// Scanline fill of a simple polygon (even-odd rule).
function poly(pts: [number, number][], c: RGB): void {
  let minY = H;
  let maxY = 0;
  for (const [, y] of pts) {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  for (let y = Math.max(0, minY); y <= Math.min(H - 1, maxY); y++) {
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[(i + 1) % pts.length];
      if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y)) {
        xs.push(Math.round(x0 + ((y - y0) * (x1 - x0)) / (y1 - y0)));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) hline(xs[k], xs[k + 1], y, c);
  }
}

// ---------------------------------------------------------------------------
// PNG encoder (colour type 2, 8-bit, filter 0 on every scanline)
// ---------------------------------------------------------------------------
const CRC_TABLE: number[] = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t.push(c >>> 0);
  }
  return t;
})();

function crc32(b: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

function pngBytes(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 3)] = 0;
    raw.set(img.subarray(y * W * 3, (y + 1) * W * 3), y * (1 + W * 3) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// 5x7 bitmap font (each glyph: 7 rows, 5 bits, MSB = leftmost column).
// All text is set in capitals; anything unmapped draws blank.
// ---------------------------------------------------------------------------
const GLYPHS: Record<string, number[]> = {
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x15, 0x0a],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  '0': [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  '1': [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  '2': [0x0e, 0x11, 0x01, 0x06, 0x08, 0x10, 0x1f],
  '3': [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  '4': [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  '5': [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  '6': [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  '7': [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  '8': [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  '9': [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  ' ': [0, 0, 0, 0, 0, 0, 0],
  '.': [0, 0, 0, 0, 0, 0x0c, 0x0c],
  ',': [0, 0, 0, 0, 0x0c, 0x04, 0x08],
  ':': [0, 0x0c, 0x0c, 0, 0x0c, 0x0c, 0],
  ';': [0, 0x0c, 0x0c, 0, 0x0c, 0x04, 0x08],
  '-': [0, 0, 0, 0x0e, 0, 0, 0],
  '!': [0x04, 0x04, 0x04, 0x04, 0x04, 0, 0x04],
  '?': [0x0e, 0x11, 0x01, 0x06, 0x04, 0, 0x04],
  '/': [0x01, 0x02, 0x02, 0x04, 0x08, 0x08, 0x10],
  '(': [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02],
  ')': [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08],
  '&': [0x0c, 0x12, 0x14, 0x08, 0x15, 0x12, 0x0d],
  '%': [0x19, 0x1a, 0x02, 0x04, 0x08, 0x0b, 0x13],
  $: [0x04, 0x0f, 0x14, 0x0e, 0x05, 0x1e, 0x04],
  '+': [0, 0x04, 0x04, 0x1f, 0x04, 0x04, 0],
  '=': [0, 0, 0x1f, 0, 0x1f, 0, 0],
  "'": [0x04, 0x04, 0x08, 0, 0, 0, 0],
  '\u2022': [0, 0, 0x0e, 0x0e, 0x0e, 0, 0],
  '\u00b7': [0, 0, 0, 0x0c, 0x0c, 0, 0],
  '\u00d7': [0, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0],
};
const EMPTY_GLYPH = [0, 0, 0, 0, 0, 0, 0];

function glyphFor(ch: string): number[] {
  if (ch === '\u2019' || ch === '\u2018') return GLYPHS["'"];
  if (ch === '\u2014' || ch === '\u2013') return GLYPHS['-'];
  return GLYPHS[ch] ?? EMPTY_GLYPH;
}

// Advance per character at a scale: 6 columns (5 glyph + 1 space).
function textW(s: string, scale: number): number {
  const t = s.toUpperCase();
  return t.length === 0 ? 0 : t.length * 6 * scale - scale;
}

function drawChar(ch: string, x: number, y: number, scale: number, c: RGB): void {
  const g = glyphFor(ch.toUpperCase());
  for (let r = 0; r < 7; r++) {
    const row = g[r];
    for (let col = 0; col < 5; col++) {
      if ((row >> (4 - col)) & 1) rect(x + col * scale, y + r * scale, scale, scale, c);
    }
  }
}

function drawText(s: string, x: number, y: number, scale: number, c: RGB): void {
  const t = s.toUpperCase();
  for (let i = 0; i < t.length; i++) drawChar(t[i], x + i * 6 * scale, y, scale, c);
}

function drawTextCenter(s: string, cx: number, y: number, scale: number, c: RGB): void {
  drawText(s, cx - Math.floor(textW(s, scale) / 2), y, scale, c);
}

// Greedy word wrap; a word longer than maxW is split by character.
function wrap(s: string, scale: number, maxW: number): string[] {
  const words = s.toUpperCase().split(' ');
  const lines: string[] = [];
  let cur = '';
  const fits = (w: string) => textW(w, scale) <= maxW;
  for (const w of words) {
    if (fits(w)) {
      if (cur === '') cur = w;
      else if (fits(cur + ' ' + w)) cur += ' ' + w;
      else {
        lines.push(cur);
        cur = w;
      }
    } else {
      // Split the over-long word across lines, character by character.
      let rest = w;
      while (rest !== '') {
        let take = 0;
        while (
          take < rest.length &&
          fits((cur === '' ? '' : cur + ' ') + rest.slice(0, take + 1))
        ) {
          take++;
        }
        if (take === 0) take = 1;
        cur = (cur === '' ? '' : cur + ' ') + rest.slice(0, take);
        rest = rest.slice(take);
        if (rest !== '' && textW(cur, scale) >= maxW - 6 * scale) {
          lines.push(cur);
          cur = '';
        }
      }
    }
  }
  if (cur !== '') lines.push(cur);
  return lines;
}

// ---------------------------------------------------------------------------
// The day's news (Tuesday 24 November 2026, as reported that day)
// ---------------------------------------------------------------------------
type Pic = 'radar' | 'jet' | 'bars' | 'coin';
type Story = {
  kicker: string;
  headline: string;
  body: string;
  accent: RGB;
  tint: RGB;
  pic: Pic;
  word: string;
  wordColor: RGB;
};

const STORIES: Story[] = [
  {
    kicker: 'EUROPE - SECURITY',
    headline: 'NATO SENDS AWACS TO POLAND',
    body: 'Alliance deploys early-warning jets after three Russian missiles land in Poland. SACEUR authorises the move.',
    accent: BLUE,
    tint: [228, 234, 247],
    pic: 'radar',
    word: 'AWACS',
    wordColor: BLUE,
  },
  {
    kicker: 'ASIA - KOREA',
    headline: 'RUSSIAN JETS SPARK KOREA ALERT',
    body: 'Seoul scrambles fighters as Russian planes enter its air zone off Ulleung. Alert lifted in 3 minutes.',
    accent: TEAL,
    tint: [227, 240, 238],
    pic: 'jet',
    word: 'NO BREACH',
    wordColor: TEAL,
  },
  {
    kicker: 'WAR IN UKRAINE',
    headline: 'RUSSIAN DEAD NEAR 500,000',
    body: 'Hacked Rosstat records put recorded Russian war dead near half a million; true toll may be 700,000.',
    accent: SLATE,
    tint: [232, 236, 240],
    pic: 'bars',
    word: '500,000',
    wordColor: RED,
  },
  {
    kicker: 'MARKETS - WALL STREET',
    headline: "HUANG $34BN RICHER IN A DAY",
    body: "Nvidia founder's fortune jumps $34bn in a day after his return. Reports say Vance lobbied the board.",
    accent: GREEN,
    tint: [230, 242, 228],
    pic: 'coin',
    word: '+$34BN',
    wordColor: GREEN,
  },
];

const BRIEFS = [
  'IRAN SAYS 3 TANKERS HIT MINES IN HORMUZ',
  'ICJ: MYANMAR MUST COMPLY AFTER ROHINGYA RULING',
  'US STATES SUE MUSK FIRMS OVER GROK SEXUALISED IMAGES',
  "2031 WOMEN'S WORLD CUP FOR US, MEXICO, COSTA RICA, JAMAICA",
];

// ---------------------------------------------------------------------------
// Pictograms (drawn into a band at bx, by, 466 x 140; art on the left,
// the big word centred in the space to its right)
// ---------------------------------------------------------------------------
function drawPic(kind: Pic, bx: number, by: number, accent: RGB): void {
  if (kind === 'radar') {
    // Radar screen: concentric rings, cross hairs, a sweep and blips.
    const cx = bx + 92;
    const cy = by + 70;
    ring(cx, cy, 52, 5, accent);
    ring(cx, cy, 34, 4, accent);
    ring(cx, cy, 16, 4, accent);
    seg(cx - 52, cy, cx + 52, cy, accent, 3);
    seg(cx, cy - 52, cx, cy + 52, accent, 3);
    seg(cx, cy, cx + 40, cy - 34, accent, 5);
    disc(cx + 24, cy - 20, 6, RED);
    disc(cx - 18, cy + 22, 6, RED);
    disc(cx + 8, cy + 30, 5, RED);
  } else if (kind === 'jet') {
    // Fighter jet seen from above, nose up-right, with motion lines.
    poly(
      [
        [bx + 128, by + 22],
        [bx + 148, by + 62],
        [bx + 186, by + 96],
        [bx + 158, by + 96],
        [bx + 138, by + 78],
        [bx + 132, by + 104],
        [bx + 118, by + 104],
        [bx + 112, by + 78],
        [bx + 92, by + 96],
        [bx + 64, by + 96],
        [bx + 102, by + 62],
      ],
      accent,
    );
    seg(bx + 30, by + 96, bx + 52, by + 96, RED, 5);
    seg(bx + 22, by + 112, bx + 44, by + 112, RED, 5);
    seg(bx + 38, by + 126, bx + 60, by + 126, RED, 5);
  } else if (kind === 'bars') {
    // Ascending bars, the last one red: a toll that keeps climbing.
    const base = by + 118;
    const widths = [34, 34, 34, 34];
    const heights = [34, 56, 82, 104];
    const xs = [bx + 36, bx + 78, bx + 120, bx + 162];
    for (let i = 0; i < 4; i++) {
      rect(xs[i], base - heights[i], widths[i], heights[i], i === 3 ? RED : accent);
    }
    seg(bx + 28, base, bx + 206, base, INK, 4);
  } else {
    // coin: a gold disc with a $ sign, rising bars behind it.
    const base = by + 118;
    rect(bx + 40, base - 46, 30, 46, accent);
    rect(bx + 80, base - 72, 30, 72, accent);
    rect(bx + 120, base - 98, 30, 98, accent);
    seg(bx + 32, base, bx + 160, base, INK, 4);
    disc(bx + 176, by + 44, 30, GOLD);
    ring(bx + 176, by + 44, 30, 4, INK);
    drawText('$', bx + 176 - 15, by + 44 - 21, 6, INK);
  }
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------
const CELL_W = 490;
const CELL_H = 368;

function masthead(): void {
  rect(0, 0, W, 124, NAVY);
  drawTextCenter('TUESDAY - THE WORLD IN ONE PICTURE', W / 2, 18, 2, [176, 196, 216]);
  drawTextCenter('24 NOVEMBER 2026', W / 2, 48, 8, WHITE);
  rect(0, 118, W, 6, RED);
}

function storyCard(s: Story, x: number, y: number): void {
  rect(x, y, CELL_W, CELL_H, CELL);
  // 3px border
  rect(x, y, CELL_W, 3, INK);
  rect(x, y + CELL_H - 3, CELL_W, 3, INK);
  rect(x, y, 3, CELL_H, INK);
  rect(x + CELL_W - 3, y, 3, CELL_H, INK);
  // Pictogram band
  const bx = x + 12;
  const by = y + 12;
  rect(bx, by, 466, 140, s.tint);
  drawPic(s.pic, bx, by, s.accent);
  // Big word, centred in the band to the right of the art.
  const wordScale = textW(s.word, 6) <= 272 ? 6 : 5;
  const wordX = bx + 194 + Math.floor((272 - textW(s.word, wordScale)) / 2);
  drawText(s.word, wordX, by + 49, wordScale, s.wordColor);
  // Kicker + rule
  drawText(s.kicker, x + 16, y + 168, 2, s.accent);
  rect(x + 16, y + 190, 64, 4, s.accent);
  // Headline
  const headLines = wrap(s.headline, 4, 458).slice(0, 3);
  headLines.forEach((ln, i) => drawText(ln, x + 16, y + 204 + i * 34, 4, INK));
  // Body
  const bodyTop = y + 204 + headLines.length * 34 + 10;
  const bodyLines = wrap(s.body, 2, 458).slice(0, 3);
  bodyLines.forEach((ln, i) => drawText(ln, x + 16, bodyTop + i * 20, 2, MUTED));
}

function strip(): void {
  const y0 = 892;
  rect(0, y0, W, 6, RED);
  drawText('ALSO TODAY', 28, y0 + 20, 2, RED);
  drawText('WIRE REPORTS', W - 28 - textW('WIRE REPORTS', 2), y0 + 20, 2, MUTED);
  BRIEFS.forEach((b, i) => {
    const by = y0 + 56 + i * 20;
    drawText('\u2022', 28, by, 2, RED);
    drawText(b, 46, by, 2, INK);
  });
}

function main(): void {
  rect(0, 0, W, H, PAPER);
  masthead();
  STORIES.forEach((s, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    storyCard(s, 16 + col * 502, 136 + row * 380);
  });
  strip();
  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  mkdirSync(outDir, { recursive: true });
  const png = pngBytes();
  writeFileSync(join(outDir, 'entry.png'), png);
  console.log(`wrote entry.png: ${png.length} bytes, ${W}x${H}`);
}

main();
