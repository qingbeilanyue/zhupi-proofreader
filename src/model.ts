export type MarkType = 'correct' | 'delete' | 'insert' | 'comment' | 'join' | 'newParagraph';
export type MarkStatus = '待处理' | '已采纳' | '已驳回';
export type InsertionSide = 'before' | 'after';

export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MarkPoint { x: number; y: number }
export interface CubicSegment { start: MarkPoint; control1: MarkPoint; control2: MarkPoint; end: MarkPoint }
export interface PageTextMetrics { typicalHeight: number; linePitch: number; glyphHeight?: number }

export interface ProofMark {
  id: string;
  page: number;
  type: MarkType;
  color: string;
  quote: string;
  replacement: string;
  note: string;
  author: string;
  round: string;
  status: MarkStatus;
  createdAt: string;
  rects: NormalizedRect[];
  insertionSide?: InsertionSide;
  outlines?: NormalizedRect[];
  tailEnd?: MarkPoint;
  positionOffset?: MarkPoint;
  textColor?: string;
  fontSize?: number;
  textMetrics?: PageTextMetrics;
  callout?: NormalizedRect;
  calloutManualSize?: boolean;
  calloutManualPosition?: boolean;
}

export interface ProjectMeta {
  id: string;
  name: string;
  pageCount: number;
  updatedAt: string;
  markCount: number;
}

export interface ProjectData {
  meta: ProjectMeta;
  pdf: Blob;
  marks: ProofMark[];
}

export const MARK_LABEL: Record<MarkType, string> = {
  correct: '改正',
  delete: '删除',
  insert: '增补',
  comment: '批注项',
  join: '接排',
  newParagraph: '另起段',
};

export const COLORS = [
  { name: '编辑朱红', value: '#b13932' },
  { name: '作者蓝', value: '#366dad' },
  { name: '二校绿', value: '#3f8061' },
  { name: '终审紫', value: '#755fa1' },
];

export function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

// PDF.js may put each Chinese glyph in a separate text-layer span. A browser
// Range then returns one rectangle per glyph, while a proofreader needs one
// outline around each continuous selected run on a visual line.
export function mergeSelectionRects(rects: NormalizedRect[], pageWidth: number, pageHeight: number): NormalizedRect[] {
  if (!(pageWidth > 0 && pageHeight > 0)) return rects;
  type PixelRect = { left: number; top: number; right: number; bottom: number };
  const pixels: PixelRect[] = rects
    .filter((rect) => [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0)
    .map((rect) => ({
      left: clamp(rect.x) * pageWidth,
      top: clamp(rect.y) * pageHeight,
      right: clamp(rect.x + rect.width) * pageWidth,
      bottom: clamp(rect.y + rect.height) * pageHeight,
    }))
    .filter((rect) => rect.right > rect.left && rect.bottom > rect.top)
    .sort((a, b) => (a.top + a.bottom) / 2 - (b.top + b.bottom) / 2 || a.left - b.left);
  const rows: { top: number; bottom: number; center: number; items: PixelRect[] }[] = [];
  for (const rect of pixels) {
    const height = rect.bottom - rect.top;
    const center = (rect.top + rect.bottom) / 2;
    const row = rows.find((candidate) => {
      const overlap = Math.min(candidate.bottom, rect.bottom) - Math.max(candidate.top, rect.top);
      const rowHeight = candidate.bottom - candidate.top;
      return overlap >= Math.min(rowHeight, height) * .5 &&
        Math.abs(center - candidate.center) <= Math.max(rowHeight, height) * .45;
    });
    if (row) {
      row.items.push(rect);
      row.top = Math.min(row.top, rect.top);
      row.bottom = Math.max(row.bottom, rect.bottom);
      row.center = row.items.reduce((sum, item) => sum + (item.top + item.bottom) / 2, 0) / row.items.length;
    } else rows.push({ top: rect.top, bottom: rect.bottom, center, items: [rect] });
  }
  const result: PixelRect[] = [];
  for (const row of rows) {
    const ordered = row.items.sort((a, b) => a.left - b.left);
    let run = { ...ordered[0] };
    for (const next of ordered.slice(1)) {
      const gap = next.left - run.right;
      const textHeight = Math.min(run.bottom - run.top, next.bottom - next.top);
      if (gap <= Math.max(2, textHeight * .8)) {
        run.left = Math.min(run.left, next.left);
        run.top = Math.min(run.top, next.top);
        run.right = Math.max(run.right, next.right);
        run.bottom = Math.max(run.bottom, next.bottom);
      } else {
        result.push(run);
        run = { ...next };
      }
    }
    result.push(run);
  }
  return result.sort((a, b) => a.top - b.top || a.left - b.left).map((rect) => ({
    x: rect.left / pageWidth,
    y: rect.top / pageHeight,
    width: (rect.right - rect.left) / pageWidth,
    height: (rect.bottom - rect.top) / pageHeight,
  }));
}

export function markBounds(rects: NormalizedRect[]): NormalizedRect {
  const left = Math.min(...rects.map((r) => r.x));
  const top = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function fontSizeOf(mark: ProofMark): number {
  return Number.isFinite(mark.fontSize) ? clamp(mark.fontSize!, 8, 32) : 10.5;
}

function glyphWidth(char: string, fontSize: number): number {
  if (char === ' ') return fontSize * .34;
  return fontSize * (char.codePointAt(0)! > 255 ? 1 : .56);
}

export function calloutLines(text: string, type: MarkType, pageWidth = 595, fontSize = 10.5): string[] {
  const maxWidth = type === 'comment' ? Math.min(180, pageWidth * .34) : Math.min(125, pageWidth * .24);
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    let width = 0;
    for (const char of paragraph) {
      const advance = glyphWidth(char, fontSize);
      if (line && width + advance > maxWidth) { lines.push(line); line = ''; width = 0; }
      line += char;
      width += advance;
    }
    lines.push(line || ' ');
  }
  return lines;
}

export function calloutSize(text: string, type: MarkType, pageWidth = 595, pageHeight = 842, fontSize = 10.5): Pick<NormalizedRect, 'width' | 'height'> {
  const lines = calloutLines(text, type, pageWidth, fontSize);
  const contentWidth = Math.max(fontSize, ...lines.map((line) => [...line].reduce((sum, char) => sum + glyphWidth(char, fontSize), 0)));
  if (type === 'comment') {
    return {
      width: Math.min(.42, (contentWidth + fontSize * .7) / pageWidth),
      height: Math.min(.35, (lines.length * fontSize * 1.35 + fontSize * .35) / pageHeight),
    };
  }
  const sideAllowance = lines.length > 1 ? fontSize * 3.25 : contentWidth > fontSize ? fontSize * 2.1 : fontSize * 1.45;
  const boxWidth = Math.max(fontSize * 2.5, contentWidth + sideAllowance);
  const boxHeight = Math.max(fontSize * 2.5, lines.length * fontSize * 1.35 + fontSize * 1.15);
  return { width: Math.min(.42, boxWidth / pageWidth), height: Math.min(.32, boxHeight / pageHeight) };
}

export function pageTextMetrics(rects: NormalizedRect[]): PageTextMetrics {
  const heights = rects.map((r) => r.height).filter((h) => Number.isFinite(h) && h > 0).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)] ?? .015;
  const centers = rects.map((r) => r.y + r.height / 2).filter(Number.isFinite).sort((a, b) => a - b);
  const rows: number[] = [];
  for (const center of centers) if (!rows.length || center - rows[rows.length - 1] > median * .65) rows.push(center);
  const pitches = rows.slice(1).map((center, index) => center - rows[index]).filter((gap) => gap > median * .7).sort((a, b) => a - b);
  return { typicalHeight: median, linePitch: pitches[Math.floor(pitches.length / 2)] ?? median * 1.5 };
}

export function defaultSourceFrame(rect: NormalizedRect, pageWidth = 595, pageHeight = 842): NormalizedRect {
  const padX = Math.min(1 / pageWidth, rect.width * .1);
  const padY = Math.min(1 / pageHeight, rect.height * .1);
  const x = clamp(rect.x - padX);
  const y = clamp(rect.y - padY);
  return { x, y, width: Math.min(1 - x, rect.x + rect.width + padX - x), height: Math.min(1 - y, rect.y + rect.height + padY - y) };
}

export function sourceFrames(mark: ProofMark, pageWidth = 595, pageHeight = 842): NormalizedRect[] {
  if (mark.outlines?.length === mark.rects.length && mark.outlines.every((rect) =>
    [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0)) return mark.outlines;
  return mark.rects.map((rect) => defaultSourceFrame(rect, pageWidth, pageHeight));
}

export function deletionTailSegments(frame: NormalizedRect, pageWidth: number, pageHeight: number, tailEnd?: MarkPoint): CubicSegment[] {
  const cx = frame.x + frame.width / 2;
  const cy = frame.y + frame.height / 2;
  const start: MarkPoint = { x: frame.x + frame.width, y: frame.y + frame.height * .22 };
  const glyphY = Math.max(.005, frame.height - .006);
  const glyphX = glyphY * pageHeight / pageWidth;
  const horizontal = Math.min(1, Math.max(.05, (1 - start.x - .005) / (2.6 * glyphX)));
  const vertical = Math.min(1, Math.max(.05, (start.y - .005) / (1.4 * glyphY)));
  const p = (x: number, y: number): MarkPoint => ({ x: start.x + x * glyphX * horizontal, y: start.y + y * glyphY * vertical });
  const segments: CubicSegment[] = [];
  const add = (from: MarkPoint, c1: MarkPoint, c2: MarkPoint, end: MarkPoint) => segments.push({ start: from, control1: c1, control2: c2, end });
  const a = p(1.05, -.55);
  const b = p(.95, -.72);
  const c = p(1.8, -.85);
  const d = p(1.7, -1);
  add(start, p(.35, -.45), p(.75, -.80), a);
  add(a, p(1.32, -.28), p(.85, -.30), b);
  add(b, p(1.15, -1.05), p(1.55, -1.15), c);
  add(c, p(2.1, -.60), p(1.63, -.60), d);
  add(d, p(1.9, -1.30), p(2.3, -1.35), p(2.55, -1.12));
  if (!tailEnd || !Number.isFinite(tailEnd.x) || !Number.isFinite(tailEnd.y)) return segments;
  // Rotate the familiar upward curl in physical page coordinates, so dragging
  // the tip changes direction without stretching its loops or entering the frame.
  const centerPx = { x: cx * pageWidth, y: cy * pageHeight };
  const endPx = { x: tailEnd.x * pageWidth, y: tailEnd.y * pageHeight };
  const angle = Math.atan2(endPx.y - centerPx.y, endPx.x - centerPx.x);
  const attached = frameEdgeToward(frame, tailEnd);
  const originalStart = segments[0].start;
  const originalEnd = segments.at(-1)!.end;
  const baseX = (originalEnd.x - originalStart.x) * pageWidth;
  const baseY = (originalEnd.y - originalStart.y) * pageHeight;
  const radial = (endPx.x - attached.x * pageWidth) * Math.cos(angle) + (endPx.y - attached.y * pageHeight) * Math.sin(angle);
  const travel = Math.max(radial, Math.max(frame.height * pageHeight, 8));
  const targetX = Math.cos(angle) * travel;
  const targetY = Math.sin(angle) * travel;
  const baseLength = Math.hypot(baseX, baseY);
  const targetLength = Math.hypot(targetX, targetY);
  const rotation = Math.atan2(targetY, targetX) - Math.atan2(baseY, baseX);
  const factor = targetLength / baseLength;
  const transform = (item: MarkPoint): MarkPoint => {
    const px = (item.x - originalStart.x) * pageWidth;
    const py = (item.y - originalStart.y) * pageHeight;
    return {
      x: attached.x + (px * Math.cos(rotation) - py * Math.sin(rotation)) * factor / pageWidth,
      y: attached.y + (px * Math.sin(rotation) + py * Math.cos(rotation)) * factor / pageHeight,
    };
  };
  return segments.map(({ start, control1, control2, end }) => ({
    start: transform(start), control1: transform(control1), control2: transform(control2), end: transform(end),
  }));
}

export function insertionAnchor(rects: NormalizedRect[], side: InsertionSide = 'after'): NormalizedRect {
  return rects[side === 'before' ? 0 : rects.length - 1];
}

export function insertionFork(rect: NormalizedRect, pageWidth: number, pageHeight: number, box?: NormalizedRect, linePitch?: number, side: InsertionSide = 'after', glyphHeight?: number): {
  leftWing: MarkPoint; tip: MarkPoint; rightWing: MarkPoint; base: MarkPoint;
} {
  // Put the shaft at the chosen edge of the selected text. Its fork opens
  // away from the text circle: a lower circle produces an upward fork.
  // PDF.js selection rectangles include font leading, which can be much taller
  // than the printed glyph. Keep the entire shaft and V close to one glyph high.
  const measuredHeight = glyphHeight && glyphHeight > 0 ? glyphHeight * .8 : rect.height * .58;
  const height = Math.min(measuredHeight, rect.height * .8, linePitch && linePitch > 0 ? linePitch * .46 : Infinity);
  const glyphX = height * pageHeight / pageWidth;
  const inset = Math.min(glyphX * .07, rect.width * .08);
  const x = clamp(side === 'before' ? rect.x + inset : rect.x + rect.width - inset, .003, .997);
  const y = clamp(rect.y + rect.height / 2, .01, .99);
  const direction = box && box.y + box.height / 2 > y ? -1 : 1;
  const reach = Math.max(0, Math.min(height * .46, direction < 0 ? y - .003 : 1 - y - .003));
  const tip: MarkPoint = { x, y: y + direction * reach };
  const base: MarkPoint = { x, y: y - direction * reach };
  const wingX = Math.min(glyphX * .19, x - .003, 1 - x - .003);
  const wingY = Math.min(height * .16, direction < 0 ? tip.y - .003 : 1 - tip.y - .003);
  return {
    leftWing: { x: x - wingX, y: tip.y + direction * wingY },
    tip,
    rightWing: { x: x + wingX, y: tip.y + direction * wingY },
    base,
  };
}

function straight(start: MarkPoint, end: MarkPoint): CubicSegment {
  return { start, control1: { x: start.x + (end.x - start.x) / 3, y: start.y + (end.y - start.y) / 3 },
    control2: { x: start.x + (end.x - start.x) * 2 / 3, y: start.y + (end.y - start.y) * 2 / 3 }, end };
}

/** GB/T 14706 position marks, in page-normalized coordinates for SVG and PDF. */
export function positionMarkStrokes(mark: Pick<ProofMark, 'type' | 'rects' | 'positionOffset'>, pageWidth: number, pageHeight: number): CubicSegment[][] {
  if (!mark.rects.length) return [];
  if (mark.type === 'join') {
    if (mark.rects.length < 2) return [];
    const first = mark.rects[0];
    const last = mark.rects[mark.rects.length - 1];
    const glyph = Math.min(first.height, last.height) * pageHeight;
    const curlX = Math.min(glyph * .75, 12) / pageWidth;
    const curlY = Math.min(glyph * .6, 10) / pageHeight;
    const gap = Math.max(0, last.y - first.y - first.height);
    const offset = Math.min(4 / pageHeight, gap * .25);
    const upperY = first.y + first.height + offset;
    const lowerY = last.y - offset;
    const upperEnd = { x: clamp(first.x + first.width + curlX * .32), y: upperY };
    const lowerEnd = { x: clamp(last.x - curlX * .32), y: lowerY };
    return [
      [straight({ x: first.x, y: upperY }, upperEnd), {
        start: upperEnd,
        control1: { x: clamp(upperEnd.x + curlX * .75), y: upperY + curlY * .15 },
        control2: { x: clamp(upperEnd.x + curlX * .8), y: upperY - curlY * .8 },
        end: { x: clamp(upperEnd.x + curlX * .15), y: upperY - curlY },
      }],
      [straight({ x: last.x + last.width, y: lowerY }, lowerEnd), {
        start: lowerEnd,
        control1: { x: clamp(lowerEnd.x - curlX * .75), y: lowerY - curlY * .15 },
        control2: { x: clamp(lowerEnd.x - curlX * .8), y: lowerY + curlY * .8 },
        end: { x: clamp(lowerEnd.x - curlX * .15), y: lowerY + curlY },
      }],
    ];
  }
  if (mark.type === 'newParagraph') {
    // The selection ends immediately before the new paragraph. The bracket
    // opens to the right of that caret; its leader turns left below the line.
    const last = mark.rects[mark.rects.length - 1];
    const glyph = last.height * pageHeight;
    const cuspX = clamp(last.x + last.width + Math.min(glyph * .1, 1.5) / pageWidth, .004, .996);
    const rightX = clamp(cuspX + Math.min(glyph * .85, 15) / pageWidth, .004, .997);
    const topY = clamp(last.y - Math.min(glyph * .18, 3) / pageHeight, .003, .997);
    const bottomY = clamp(last.y + last.height + Math.min(glyph * .18, 3) / pageHeight, .003, .997);
    const middleY = (topY + bottomY) / 2;
    const middle = { x: cuspX, y: middleY };
    const tipTop = { x: rightX, y: topY };
    const tipBottom = { x: rightX, y: bottomY };
    const bracket: CubicSegment[] = [
      { start: tipTop, control1: { x: cuspX + (rightX - cuspX) * .3, y: topY },
        control2: { x: cuspX, y: middleY - (middleY - topY) * .25 }, end: middle },
      { start: middle, control1: { x: cuspX, y: middleY + (bottomY - middleY) * .25 },
        control2: { x: cuspX + (rightX - cuspX) * .3, y: bottomY }, end: tipBottom },
    ];
    const lineY = clamp(last.y + last.height + Math.min(glyph * .38, 7) / pageHeight, .006, .994);
    const elbowX = clamp(cuspX - Math.min(glyph * .6, 11) / pageWidth, .006, .994);
    const barX = clamp(cuspX - Math.min(glyph * 3.2, 52) / pageWidth, .006, .994);
    const elbow = { x: elbowX, y: lineY };
    const bar = { x: barX, y: lineY };
    const wingX = Math.min(glyph * .23, 4.5) / pageWidth;
    const wingY = Math.min(glyph * .18, 3.5) / pageHeight;
    const barHalfHeight = Math.min(glyph * .36, 7) / pageHeight;
    const strokes: CubicSegment[][] = [
      bracket,
      [{ start: middle, control1: { x: cuspX, y: lineY - (lineY - middleY) * .25 },
        control2: { x: elbowX + (cuspX - elbowX) * .35, y: lineY }, end: elbow },
        straight(elbow, bar)],
      [straight({ x: clamp(barX + wingX), y: clamp(lineY - wingY) }, bar),
        straight(bar, { x: clamp(barX + wingX), y: clamp(lineY + wingY) })],
      [straight({ x: barX, y: clamp(lineY - barHalfHeight) },
        { x: barX, y: clamp(lineY + barHalfHeight) })],
    ];
    const offset = mark.positionOffset ?? { x: 0, y: 0 };
    return strokes.map((stroke) => stroke.map((segment) => ({
      start: { x: segment.start.x + offset.x, y: segment.start.y + offset.y },
      control1: { x: segment.control1.x + offset.x, y: segment.control1.y + offset.y },
      control2: { x: segment.control2.x + offset.x, y: segment.control2.y + offset.y },
      end: { x: segment.end.x + offset.x, y: segment.end.y + offset.y },
    })));
  }
  return [];
}

function overlapArea(a: NormalizedRect, b: NormalizedRect): number {
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
}

export function placeCallout(rects: NormalizedRect[], text: string, type: MarkType, occupied: NormalizedRect[] = [], pageWidth = 595, pageHeight = 842): NormalizedRect {
  const anchor = markBounds(rects);
  const size = calloutSize(text, type, pageWidth, pageHeight);
  const pad = 0.018;
  const positions = [
    { x: anchor.x + anchor.width + 0.032, y: anchor.y - 0.006 },
    { x: anchor.x - size.width - 0.032, y: anchor.y - 0.006 },
    { x: anchor.x, y: anchor.y - size.height - 0.04 },
    { x: anchor.x, y: anchor.y + anchor.height + 0.04 },
    { x: 0.73, y: anchor.y - 0.006 },
    { x: 0.05, y: anchor.y - 0.006 },
  ];
  const candidates = positions.flatMap((position) => [0, -0.04, 0.04, -0.09, 0.09, -0.15, 0.15].map((offset) => ({
    x: clamp(position.x, pad, 1 - size.width - pad),
    y: clamp(position.y + offset, pad, 1 - size.height - pad),
    ...size,
  })));
  const center = { x: anchor.x + anchor.width / 2, y: anchor.y + anchor.height / 2 };
  return candidates.reduce((best, candidate) => {
    const score = (r: NormalizedRect) => {
      const overlaps = occupied.reduce((sum, item) => sum + overlapArea(r, item), 0);
      const anchorOverlap = overlapArea(r, anchor);
      const dx = r.x + r.width / 2 - center.x;
      const dy = r.y + r.height / 2 - center.y;
      return overlaps * 500 + anchorOverlap * 1000 + Math.hypot(dx, dy);
    };
    return score(candidate) < score(best) ? candidate : best;
  });
}

export function resolveCallout(mark: ProofMark): NormalizedRect {
  return mark.callout ?? placeCallout(mark.rects, mark.type === 'comment' ? mark.note : mark.replacement, mark.type);
}

function ellipseEdgeToward(rect: NormalizedRect, target: MarkPoint): MarkPoint {
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  const radiusX = Math.max(rect.width / 2, .0001);
  const radiusY = Math.max(rect.height / 2, .0001);
  const dx = target.x - centerX;
  const dy = target.y - centerY;
  // When the source is directly above/below or beside the callout, retain a
  // straight vertical/horizontal leader and intersect that line with the oval.
  if (target.x > rect.x && target.x < rect.x + rect.width && (target.y < rect.y || target.y > rect.y + rect.height)) {
    const offset = (target.x - centerX) / radiusX;
    return { x: target.x, y: centerY + Math.sign(dy) * radiusY * Math.sqrt(Math.max(0, 1 - offset * offset)) };
  }
  if (target.y > rect.y && target.y < rect.y + rect.height && (target.x < rect.x || target.x > rect.x + rect.width)) {
    const offset = (target.y - centerY) / radiusY;
    return { x: centerX + Math.sign(dx) * radiusX * Math.sqrt(Math.max(0, 1 - offset * offset)), y: target.y };
  }
  const distance = Math.hypot(dx / radiusX, dy / radiusY);
  if (distance < .0001) return { x: centerX, y: centerY + radiusY };
  return { x: centerX + dx / distance, y: centerY + dy / distance };
}

function frameEdgeToward(rect: NormalizedRect, target: MarkPoint): MarkPoint {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const dx = target.x - cx;
  const dy = target.y - cy;
  const tx = Math.abs(dx) > 1e-8 ? rect.width / 2 / Math.abs(dx) : Infinity;
  const ty = Math.abs(dy) > 1e-8 ? rect.height / 2 / Math.abs(dy) : Infinity;
  const scale = Math.min(tx, ty);
  return Number.isFinite(scale) ? { x: cx + dx * scale, y: cy + dy * scale } : { x: rect.x + rect.width, y: cy };
}

export function leaderEndpoints(mark: ProofMark, box: NormalizedRect, pageWidth = 595, pageHeight = 842): { x1: number; y1: number; x2: number; y2: number } {
  const targetX = box.x + box.width / 2;
  const targetY = box.y + box.height / 2;
  const candidates = mark.type === 'insert' ? mark.rects : sourceFrames(mark, pageWidth, pageHeight);
  const source = mark.type === 'insert' ? insertionAnchor(candidates, mark.insertionSide) : candidates.reduce((nearest, rect) => {
    const distance = (r: NormalizedRect) => Math.hypot(r.x + r.width / 2 - targetX, r.y + r.height / 2 - targetY);
    return distance(rect) < distance(nearest) ? rect : nearest;
  });
  const fork = mark.type === 'insert' ? insertionFork(source, pageWidth, pageHeight, box, mark.textMetrics?.linePitch, mark.insertionSide, mark.textMetrics?.glyphHeight) : null;
  const cx = fork ? fork.base.x : source.x + source.width / 2;
  const cy = fork ? fork.base.y : source.y + source.height / 2;
  const edge = mark.type === 'comment'
    ? { x: clamp(cx, box.x, box.x + box.width), y: clamp(cy, box.y, box.y + box.height) }
    : ellipseEdgeToward(box, { x: cx, y: cy });
  // Extend slightly beneath the callout border so screen antialiasing and PDF
  // strokes cannot reveal a hairline gap between the leader and the oval.
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  const edgeDistance = Math.hypot((centerX - edge.x) * pageWidth, (centerY - edge.y) * pageHeight);
  const approachDistance = Math.hypot((edge.x - cx) * pageWidth, (edge.y - cy) * pageHeight);
  const inset = mark.type === 'comment' || edgeDistance < .0001 || approachDistance < .0001 ? 0 : Math.min(2, edgeDistance * .25) / approachDistance;
  const x2 = edge.x + (edge.x - cx) * inset;
  const y2 = edge.y + (edge.y - cy) * inset;
  if (mark.type === 'insert') return { x1: cx, y1: cy, x2, y2 };
  const start = frameEdgeToward(source, { x: x2, y: y2 });
  return { x1: start.x, y1: start.y, x2, y2 };
}
