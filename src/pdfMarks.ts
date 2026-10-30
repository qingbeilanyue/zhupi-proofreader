import { PDFDocument, rgb, type PDFPage } from 'pdf-lib';
import type { NormalizedRect, ProofMark } from './model';
import { calloutLines, deletionTailSegments, fontSizeOf, insertionAnchor, insertionFork, leaderEndpoints, mergeSelectionRects, positionMarkStrokes, resolveCallout, sourceFrames } from './model';

function ink(hex: string) {
  const clean = /^#[\da-f]{6}$/i.test(hex) ? hex.slice(1) : 'b13932';
  return rgb(parseInt(clean.slice(0, 2), 16) / 255, parseInt(clean.slice(2, 4), 16) / 255, parseInt(clean.slice(4, 6), 16) / 255);
}

function point(page: PDFPage, x: number, y: number) {
  const { width, height } = page.getSize();
  return { x: x * width, y: (1 - y) * height };
}

function ellipse(page: PDFPage, rect: NormalizedRect, color: ReturnType<typeof ink>, pad = 0.003): void {
  const { width, height } = page.getSize();
  page.drawEllipse({
    x: (rect.x + rect.width / 2) * width,
    y: (1 - rect.y - rect.height / 2) * height,
    xScale: Math.max((rect.width / 2 + pad) * width, 4),
    yScale: Math.max((rect.height / 2 + pad) * height, 4),
    borderColor: color,
    borderWidth: 1.3,
  });
}

function frame(page: PDFPage, rect: NormalizedRect, color: ReturnType<typeof ink>): void {
  const { width, height } = page.getSize();
  page.drawRectangle({ x: rect.x * width, y: (1 - rect.y - rect.height) * height,
    width: rect.width * width, height: rect.height * height, borderColor: color, borderWidth: 1.3 });
}

function segment(page: PDFPage, x1: number, y1: number, x2: number, y2: number, color: ReturnType<typeof ink>): void {
  page.drawLine({ start: point(page, x1, y1), end: point(page, x2, y2), color, thickness: 1.3 });
}

function curve(page: PDFPage, start: [number, number], control1: [number, number], control2: [number, number], end: [number, number], color: ReturnType<typeof ink>): void {
  let previous = start;
  for (let step = 1; step <= 12; step += 1) {
    const t = step / 12;
    const n = 1 - t;
    const current: [number, number] = [
      n ** 3 * start[0] + 3 * n ** 2 * t * control1[0] + 3 * n * t ** 2 * control2[0] + t ** 3 * end[0],
      n ** 3 * start[1] + 3 * n ** 2 * t * control1[1] + 3 * n * t ** 2 * control2[1] + t ** 3 * end[1],
    ];
    segment(page, previous[0], previous[1], current[0], current[1], color);
    previous = current;
  }
}

async function drawCalloutText(pdf: PDFDocument, page: PDFPage, mark: ProofMark, box: NormalizedRect): Promise<void> {
  const value = mark.type === 'comment' ? mark.note : mark.replacement;
  if (!value) return;
  const { width, height } = page.getSize();
  const scale = 4;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(8, Math.ceil(box.width * width * scale));
  canvas.height = Math.max(8, Math.ceil(box.height * height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('页内批注文字绘制失败');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const fontSize = fontSizeOf(mark);
  ctx.font = `${mark.type === 'comment' ? 500 : 700} ${fontSize * scale}px 'Noto Sans CJK SC', 'Microsoft YaHei', 'PingFang SC', sans-serif`;
  ctx.fillStyle = mark.textColor ?? mark.color;
  const lineHeight = fontSize * 1.35 * scale;
  const lines = calloutLines(value, mark.type, width, fontSize);
  if (mark.type === 'correct' || mark.type === 'insert') {
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    const firstY = canvas.height / 2 - (lines.length - 1) * lineHeight / 2;
    lines.forEach((line, index) => ctx.fillText(line, canvas.width / 2, firstY + index * lineHeight));
  } else {
    const padding = fontSize * .25 * scale;
    ctx.textBaseline = 'top';
    lines.forEach((line, index) => ctx.fillText(line, padding, padding + index * lineHeight));
  }
  const image = await pdf.embedPng(canvas.toDataURL('image/png'));
  page.drawImage(image, { x: box.x * width, y: (1 - box.y - box.height) * height, width: box.width * width, height: box.height * height });
}

export async function drawMarks(pdf: PDFDocument, marks: ProofMark[]): Promise<void> {
  const pages = pdf.getPages();
  for (const storedMark of marks) {
    const page = pages[storedMark.page - 1];
    if (!page || !storedMark.rects.length) continue;
    const { width: pageWidth, height: pageHeight } = page.getSize();
    const mark = { ...storedMark, rects: mergeSelectionRects(storedMark.rects, pageWidth, pageHeight) };
    if (!mark.rects.length) continue;
    const color = ink(mark.color);
    if (mark.type === 'join' || mark.type === 'newParagraph') {
      positionMarkStrokes(mark, pageWidth, pageHeight).forEach((stroke) => stroke.forEach(({ start, control1, control2, end }) => {
        curve(page, [start.x, start.y], [control1.x, control1.y], [control2.x, control2.y], [end.x, end.y], color);
      }));
      continue;
    }
    if (mark.type === 'insert') {
      const anchor = insertionAnchor(mark.rects, mark.insertionSide);
      const fork = insertionFork(anchor, pageWidth, pageHeight, resolveCallout(mark), mark.textMetrics?.linePitch, mark.insertionSide, mark.textMetrics?.glyphHeight);
      segment(page, fork.leftWing.x, fork.leftWing.y, fork.tip.x, fork.tip.y, color);
      segment(page, fork.tip.x, fork.tip.y, fork.rightWing.x, fork.rightWing.y, color);
      segment(page, fork.tip.x, fork.tip.y, fork.base.x, fork.base.y, color);
    } else {
      sourceFrames(mark, pageWidth, pageHeight).forEach((source) => frame(page, source, color));
    }
    if (mark.type === 'delete') {
      const last = sourceFrames(mark, pageWidth, pageHeight).at(-1)!;
      deletionTailSegments(last, pageWidth, pageHeight, mark.tailEnd).forEach(({ start, control1, control2, end }) => {
        curve(page, [start.x, start.y], [control1.x, control1.y], [control2.x, control2.y], [end.x, end.y], color);
      });
      continue;
    }
    const box = resolveCallout(mark);
    const leader = leaderEndpoints(mark, box, pageWidth, pageHeight);
    segment(page, leader.x1, leader.y1, leader.x2, leader.y2, color);
    if (mark.type === 'correct' || mark.type === 'insert') ellipse(page, box, color, 0);
    await drawCalloutText(pdf, page, mark, box);
  }
}
