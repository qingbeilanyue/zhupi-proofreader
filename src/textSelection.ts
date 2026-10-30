import type { NormalizedRect } from './model';
import { mergeSelectionRects } from './model';

interface GlyphRange {
  range: Range;
  text: string;
}

const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' });

function glyphRanges(root: Element): GlyphRange[] {
  const result: GlyphRange[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const value = node.textContent ?? '';
    for (const part of segmenter.segment(value)) {
      const range = document.createRange();
      range.setStart(node, part.index);
      range.setEnd(node, part.index + part.segment.length);
      result.push({ range, text: part.segment });
    }
  }
  return result;
}

function overlaps(a: Range, b: Range): boolean {
  return a.compareBoundaryPoints(Range.START_TO_END, b) > 0 &&
    a.compareBoundaryPoints(Range.END_TO_START, b) < 0;
}

/** Select the complete grapheme beneath a click, including punctuation. */
export function selectPdfGlyphAtPoint(page: HTMLElement, clientX: number, clientY: number): boolean {
  const layer = page.querySelector('.pdf-text-layer');
  if (!layer) return false;
  const span = document.elementsFromPoint(clientX, clientY)
    .map((element) => element.closest('.pdf-text-layer span'))
    .find((element): element is HTMLSpanElement => !!element && layer.contains(element));
  if (!span) return false;
  const bounds = span.getBoundingClientRect();
  if (clientX < bounds.left - 2 || clientX > bounds.right + 2 || clientY < bounds.top - 2 || clientY > bounds.bottom + 2) return false;
  let nearest: { range: Range; distance: number } | null = null;
  for (const glyph of glyphRanges(span)) {
    if (!glyph.text.trim()) continue;
    const rect = glyph.range.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) continue;
    const dx = Math.max(rect.left - clientX, 0, clientX - rect.right);
    const dy = Math.max(rect.top - clientY, 0, clientY - rect.bottom);
    const distance = dx * dx + dy * dy;
    if (!nearest || distance < nearest.distance) nearest = { range: glyph.range, distance };
  }
  if (!nearest || nearest.distance > 16) return false;
  const selection = window.getSelection();
  if (!selection) return false;
  selection.removeAllRanges();
  selection.addRange(nearest.range);
  return true;
}

/** Read browser selection as complete Unicode graphemes with measured text-layer boxes. */
export function readPdfTextSelection(selection: Selection, page: HTMLElement): { quote: string; rects: NormalizedRect[]; endNode: Node } | null {
  const layer = page.querySelector('.pdf-text-layer');
  if (!layer || !selection.rangeCount || !selection.anchorNode || !selection.focusNode ||
      !layer.contains(selection.anchorNode) || !layer.contains(selection.focusNode)) return null;
  const selectedRange = selection.getRangeAt(0);
  if (selectedRange.collapsed) return null;
  const bounds = page.getBoundingClientRect();
  if (!(bounds.width > 0 && bounds.height > 0)) return null;
  const selected: GlyphRange[] = [];
  const rects: NormalizedRect[] = [];
  for (const span of layer.querySelectorAll('span')) {
    if (!selectedRange.intersectsNode(span)) continue;
    for (const glyph of glyphRanges(span)) {
      if (!overlaps(glyph.range, selectedRange)) continue;
      selected.push(glyph);
      if (!glyph.text.trim()) continue;
      for (const rect of glyph.range.getClientRects()) {
        if (!(rect.width > 0 && rect.height > 0)) continue;
        const left = Math.max(0, Math.min(1, (rect.left - bounds.left) / bounds.width));
        const top = Math.max(0, Math.min(1, (rect.top - bounds.top) / bounds.height));
        const right = Math.max(0, Math.min(1, (rect.right - bounds.left) / bounds.width));
        const bottom = Math.max(0, Math.min(1, (rect.bottom - bounds.top) / bounds.height));
        if (right > left && bottom > top) rects.push({ x: left, y: top, width: right - left, height: bottom - top });
      }
    }
  }
  if (!selected.length || !rects.length) return null;
  const first = selected[0].range;
  const last = selected[selected.length - 1].range;
  if (selectedRange.startContainer !== first.startContainer || selectedRange.startOffset !== first.startOffset ||
      selectedRange.endContainer !== last.endContainer || selectedRange.endOffset !== last.endOffset) {
    const snapped = document.createRange();
    snapped.setStart(first.startContainer, first.startOffset);
    snapped.setEnd(last.endContainer, last.endOffset);
    selection.removeAllRanges();
    selection.addRange(snapped);
  }
  const quote = selection.toString().trim();
  return quote ? { quote, rects: mergeSelectionRects(rects, bounds.width, bounds.height), endNode: last.endContainer } : null;
}
