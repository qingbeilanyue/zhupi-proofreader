import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import {
  ArrowLeft, ArrowRight, Check, ChevronDown, ChevronLeft, ChevronRight,
  CircleHelp, Clock3, CloudOff, Download, FileArchive, FileDown, FileSpreadsheet, FileText,
  FolderOpen, Highlighter, ListFilter, Menu, MousePointer2, Plus, RotateCcw, Settings2,
  Trash2, UploadCloud, X, ZoomIn, ZoomOut,
} from 'lucide-react';
// Both realms need PDF.js compatibility shims (for example Uint8Array.toHex).
import { getDocument, GlobalWorkerOptions, TextLayer, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import type { InsertionSide, MarkPoint, MarkType, NormalizedRect, PageTextMetrics, ProjectData, ProjectMeta, ProofMark } from './model';
import { COLORS, MARK_LABEL, calloutLines, calloutSize, clamp, deletionTailSegments, fontSizeOf, insertionAnchor, insertionFork, leaderEndpoints, mergeSelectionRects, pageTextMetrics, placeCallout, positionMarkStrokes, resolveCallout, sourceFrames, type CubicSegment } from './model';
import { readPdfTextSelection, selectPdfGlyphAtPoint } from './textSelection';
import { listProjects, loadProject, saveProject } from './storage';
import { exportCleanPdf, exportExcel, exportMarkedPdf, exportProject, exportWord, importProject } from './export';

GlobalWorkerOptions.workerSrc = workerUrl;

interface SelectionInfo {
  quote: string;
  rects: NormalizedRect[];
  textMetrics: PageTextMetrics;
  x: number;
  y: number;
}

function pageLabel(page: number): string { return String(page).padStart(2, '0'); }

function svgCubicPath(segments: CubicSegment[]): string {
  if (!segments.length) return '';
  const first = segments[0].start;
  return `M ${first.x} ${first.y} ${segments.map(({ control1, control2, end }) =>
    `C ${control1.x} ${control1.y} ${control2.x} ${control2.y} ${end.x} ${end.y}`).join(' ')}`;
}

function MarkIcon({ type }: { type: MarkType }) {
  return <svg className="proof-icon" viewBox="0 0 36 28" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {type === 'correct' && <><rect x="2" y="14" width="10" height="10" /><path d="M12 17 L23 9" /><ellipse cx="28" cy="9" rx="6" ry="6" /></>}
    {type === 'delete' && <><rect x="2" y="14" width="10" height="10" /><path d="M12 16 C16 8 21 7 21 11 C20 14 18 11 21 8 C24 5 28 4 28 8 C27 10 25 8 28 5 L34 3" /></>}
    {type === 'insert' && <><path d="M3 6 L8 11 L13 6 M8 11 L8 23 M8 23 L22 12" /><ellipse cx="28" cy="10" rx="6" ry="6" /></>}
    {type === 'comment' && <><rect x="2" y="13" width="10" height="10" /><path d="M12 15 L23 8 M23 5 L34 5 M23 10 L32 10 M23 15 L30 15" /></>}
    {type === 'join' && <><path d="M3 11 H25 C33 11 31 4 24 5 M33 18 H11 C3 18 5 25 12 23" /></>}
    {type === 'newParagraph' && <><path d="M32 3 C22 3 22 10 22 14 C22 18 22 25 32 25 M22 14 C22 19 18 20 15 20 H3 M6 17 L3 20 L6 23 M3 15 V25" /></>}
  </svg>;
}

function PdfPage({ pdf, pageNumber, zoom, marks, focusedId, editMode, pageRef, onSelection, onFocusMark, onCalloutMove, onCalloutResize, onOutlineMove, onTailMove, onPositionMove, onDeleteMark, onPageMetrics, onCalloutDragStart }: {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  zoom: number;
  marks: ProofMark[];
  focusedId: string | null;
  editMode: boolean;
  pageRef: RefObject<HTMLDivElement | null>;
  onSelection: (point?: { x: number; y: number }) => void;
  onFocusMark: (id: string | null) => void;
  onCalloutMove: (id: string, callout: NormalizedRect) => void;
  onCalloutResize: (id: string, callout: NormalizedRect) => void;
  onOutlineMove: (id: string, index: number, oval: NormalizedRect) => void;
  onTailMove: (id: string, end: MarkPoint) => void;
  onPositionMove: (id: string, offset: MarkPoint) => void;
  onDeleteMark: (id: string) => void;
  onPageMetrics: (page: number, metrics: PageTextMetrics) => void;
  onCalloutDragStart: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const renderQueueRef = useRef<Promise<void>>(Promise.resolve());
  const dragRef = useRef<{ id: string; pointerId: number; x: number; y: number; start: NormalizedRect } | null>(null);
  const calloutResizeRef = useRef<{ id: string; pointerId: number; x: number; y: number; start: NormalizedRect } | null>(null);
  const ovalDragRef = useRef<{ id: string; index: number; pointerId: number; x: number; y: number; start: NormalizedRect; mode: 'move' | 'resize' } | null>(null);
  const tailDragRef = useRef<{ id: string; pointerId: number } | null>(null);
  const positionDragRef = useRef<{ id: string; pointerId: number; x: number; y: number; start: MarkPoint; minX: number; maxX: number; minY: number; maxY: number } | null>(null);
  const [size, setSize] = useState({ width: 595 * zoom, height: 842 * zoom });

  useEffect(() => {
    let disposed = false;
    let renderTask: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | null = null;
    let layer: TextLayer | null = null;
    const task = renderQueueRef.current.catch(() => undefined).then(async () => {
      if (disposed) return;
      const page = await pdf.getPage(pageNumber);
      if (disposed) return;
      const viewport = page.getViewport({ scale: zoom });
      const canvas = canvasRef.current;
      const textContainer = textRef.current;
      if (!canvas || !textContainer) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(viewport.width * ratio);
      canvas.height = Math.round(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      setSize({ width: viewport.width, height: viewport.height });
      const context = canvas.getContext('2d');
      if (!context) return;
      textContainer.replaceChildren();
      const content = await page.getTextContent();
      if (disposed) return;
      layer = new TextLayer({ textContentSource: content, container: textContainer, viewport });
      await layer.render();
      if (disposed) return;
      const bounds = textContainer.getBoundingClientRect();
      if (bounds.width > 0 && bounds.height > 0) {
        const spans = textContainer.querySelectorAll('span');
        const step = Math.max(1, Math.ceil(spans.length / 1200));
        const glyphs: NormalizedRect[] = [];
        for (let index = 0; index < spans.length; index += step) {
          const rect = spans[index].getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) glyphs.push({
            x: (rect.left - bounds.left) / bounds.width,
            y: (rect.top - bounds.top) / bounds.height,
            width: rect.width / bounds.width,
            height: rect.height / bounds.height,
          });
        }
        onPageMetrics(pageNumber, pageTextMetrics(glyphs));
      }
      renderTask = page.render({ canvasContext: context, canvas, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
      await renderTask.promise;
    });
    renderQueueRef.current = task.catch((error) => {
      if (!disposed && error?.name !== 'RenderingCancelledException') console.error('PDF 页面渲染失败', error);
    });
    return () => {
      disposed = true;
      renderTask?.cancel();
      layer?.cancel();
    };
  }, [pdf, pageNumber, zoom, onPageMetrics]);

  const beginOvalDrag = (event: ReactPointerEvent<SVGElement>, mark: ProofMark, index: number, oval: NormalizedRect, mode: 'move' | 'resize') => {
    if (!editMode) return;
    event.preventDefault();
    event.stopPropagation();
    onFocusMark(mark.id);
    onCalloutDragStart();
    ovalDragRef.current = { id: mark.id, index, pointerId: event.pointerId, x: event.clientX, y: event.clientY, start: oval, mode };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const beginPositionDrag = (event: ReactPointerEvent<SVGPathElement>, mark: ProofMark) => {
    event.preventDefault();
    event.stopPropagation();
    onFocusMark(mark.id);
    onCalloutDragStart();
    const points = positionMarkStrokes({ ...mark, positionOffset: undefined }, size.width, size.height)
      .flatMap((stroke) => stroke.flatMap((segment) => [segment.start, segment.control1, segment.control2, segment.end]));
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    positionDragRef.current = { id: mark.id, pointerId: event.pointerId, x: event.clientX, y: event.clientY,
      start: mark.positionOffset ?? { x: 0, y: 0 },
      minX: .003 - Math.min(...xs), maxX: .997 - Math.max(...xs),
      minY: .003 - Math.min(...ys), maxY: .997 - Math.max(...ys) };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveMarks = (event: ReactPointerEvent<SVGSVGElement>) => {
    const positionDrag = positionDragRef.current;
    if (positionDrag?.pointerId === event.pointerId) {
      event.preventDefault();
      onPositionMove(positionDrag.id, {
        x: clamp(positionDrag.start.x + (event.clientX - positionDrag.x) / size.width, positionDrag.minX, positionDrag.maxX),
        y: clamp(positionDrag.start.y + (event.clientY - positionDrag.y) / size.height, positionDrag.minY, positionDrag.maxY),
      });
      return;
    }
    const tailDrag = tailDragRef.current;
    if (tailDrag?.pointerId === event.pointerId) {
      event.preventDefault();
      const bounds = event.currentTarget.getBoundingClientRect();
      onTailMove(tailDrag.id, { x: clamp((event.clientX - bounds.left) / bounds.width, .003, .997), y: clamp((event.clientY - bounds.top) / bounds.height, .003, .997) });
      return;
    }
    const drag = ovalDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const dx = (event.clientX - drag.x) / size.width;
    const dy = (event.clientY - drag.y) / size.height;
    const oval = drag.mode === 'move'
      ? { ...drag.start, x: clamp(drag.start.x + dx, .002, 1 - drag.start.width - .002), y: clamp(drag.start.y + dy, .002, 1 - drag.start.height - .002) }
      : { ...drag.start, width: clamp(drag.start.width + dx, 12 / size.width, 1 - drag.start.x - .002), height: clamp(drag.start.height + dy, 12 / size.height, 1 - drag.start.y - .002) };
    onOutlineMove(drag.id, drag.index, oval);
  };

  return <div className="paper-frame" style={{ width: size.width, height: size.height }}>
    <div ref={pageRef} className={`paper-surface ${editMode ? 'mark-editing' : ''}`} style={{ width: size.width, height: size.height, ['--scale-factor' as string]: zoom }} onPointerDown={(event) => { if (!editMode && (event.target as Element).closest('.pdf-text-layer')) onFocusMark(null); }} onMouseUp={(event) => { if (!editMode) onSelection((event.target as Element).closest('.pdf-text-layer span') ? { x: event.clientX, y: event.clientY } : undefined); }} onTouchEnd={() => { if (!editMode) window.setTimeout(() => onSelection(), 80); }}>
      <canvas ref={canvasRef} className="pdf-canvas" aria-label={`第 ${pageNumber} 页 PDF`} />
      <div ref={textRef} className="textLayer pdf-text-layer" />
      <svg className="marks-layer" viewBox="0 0 1 1" preserveAspectRatio="none" aria-label="校对符号层" onPointerMove={moveMarks} onPointerUp={() => { ovalDragRef.current = null; tailDragRef.current = null; positionDragRef.current = null; }} onPointerCancel={() => { ovalDragRef.current = null; tailDragRef.current = null; positionDragRef.current = null; }}>
        {marks.map((mark) => mark.rects.map((rect, index) => {
          const active = focusedId === mark.id;
          const strokeWidth = active ? 0.0027 : 0.002;
          const common = { stroke: mark.color, strokeWidth, fill: 'none' };
          const frame = mark.type === 'correct' || mark.type === 'delete' || mark.type === 'comment'
            ? sourceFrames(mark, size.width, size.height)[index] : null;
          return <g key={`${mark.id}-${index}`} className={active ? 'mark-focused' : ''}>
            {frame && <><rect x={frame.x} y={frame.y} width={frame.width} height={frame.height} {...common} pointerEvents="none" />
              {editMode && <rect x={frame.x} y={frame.y} width={frame.width} height={frame.height} stroke="transparent" strokeWidth={Math.max(.008, 8 / size.width)} fill="transparent" pointerEvents="stroke" className="oval-hit" aria-label={`选中${MARK_LABEL[mark.type]}标注并拖动原文框`} onPointerDown={(event) => beginOvalDrag(event, mark, index, frame, 'move')} />}
              {editMode && active && <><rect x={frame.x + frame.width - 5 / size.width} y={frame.y + frame.height - 5 / size.height} width={10 / size.width} height={10 / size.height} rx={1 / size.width} fill="#fff" stroke={mark.color} strokeWidth=".002" pointerEvents="none" />
                <rect x={frame.x + frame.width - 12 / size.width} y={frame.y + frame.height - 12 / size.height} width={24 / size.width} height={24 / size.height} fill="transparent" stroke="none" pointerEvents="all" className="oval-resize" aria-label="拖动调整原文框大小" onPointerDown={(event) => beginOvalDrag(event, mark, index, frame, 'resize')} /></>}
            </>}
            {mark.type === 'delete' && index === mark.rects.length - 1 && frame && (() => {
              const segments = deletionTailSegments(frame, size.width, size.height, mark.tailEnd);
              const tip = segments.at(-1)!.end;
              return <><path d={svgCubicPath(segments)} {...common} />{editMode && active && <>
                <rect x={tip.x - 5 / size.width} y={tip.y - 5 / size.height} width={10 / size.width} height={10 / size.height} rx={1 / size.width} fill="#fff" stroke={mark.color} strokeWidth=".002" pointerEvents="none" />
                <rect x={tip.x - 14 / size.width} y={tip.y - 14 / size.height} width={28 / size.width} height={28 / size.height} fill="transparent" pointerEvents="all" className="tail-handle" aria-label="拖动调整删除尾巴方向" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); onCalloutDragStart(); tailDragRef.current = { id: mark.id, pointerId: event.pointerId }; event.currentTarget.setPointerCapture(event.pointerId); }} />
              </>}</>;
            })()}
            {mark.type === 'insert' && index === (mark.insertionSide === 'before' ? 0 : mark.rects.length - 1) && (() => {
              const fork = insertionFork(rect, size.width, size.height, resolveCallout(mark), mark.textMetrics?.linePitch, mark.insertionSide, mark.textMetrics?.glyphHeight);
              const d = `M ${fork.leftWing.x} ${fork.leftWing.y} L ${fork.tip.x} ${fork.tip.y} L ${fork.rightWing.x} ${fork.rightWing.y} M ${fork.tip.x} ${fork.tip.y} L ${fork.base.x} ${fork.base.y}`;
              return <><path d={d} {...common} />{editMode && <path d={d} stroke="transparent" strokeWidth={Math.max(.014, 12 / size.width)} fill="none" pointerEvents="stroke" className="insert-hit" aria-label="选中增补标注" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); onFocusMark(mark.id); }} />}</>;
            })()}
            {(mark.type === 'join' || mark.type === 'newParagraph') && index === 0 && positionMarkStrokes(mark, size.width, size.height).map((stroke, strokeIndex) => {
              const d = svgCubicPath(stroke);
              return <g key={`${mark.id}-position-${strokeIndex}`}><path d={d} {...common} pointerEvents="none" />{editMode && <path d={d} stroke="transparent" strokeWidth={Math.max(.014, 12 / size.width)} fill="none" pointerEvents="stroke" className={mark.type === 'newParagraph' ? 'position-hit' : 'insert-hit'} aria-label={mark.type === 'newParagraph' ? '拖动调整另起段符号位置' : `选中${MARK_LABEL[mark.type]}标注`} onPointerDown={(event) => { if (mark.type === 'newParagraph') beginPositionDrag(event, mark); else { event.preventDefault(); event.stopPropagation(); onFocusMark(mark.id); } }} />}</g>;
            })}
          </g>;
        }))}
        {marks.filter((mark) => (mark.type === 'correct' || mark.type === 'insert' || mark.type === 'comment') && mark.rects.length).map((mark) => {
          const callout = resolveCallout(mark);
          const leader = leaderEndpoints(mark, callout, size.width, size.height);
          return <line key={`${mark.id}-leader`} x1={leader.x1} y1={leader.y1} x2={leader.x2} y2={leader.y2} stroke={mark.color} strokeWidth={focusedId === mark.id ? .0027 : .002} />;
        })}
      </svg>
      {(() => {
        const active = marks.find((mark) => mark.id === focusedId);
        if (!editMode || !active || !active.rects.length) return null;
        const anchor = active.type === 'insert' ? insertionAnchor(active.rects, active.insertionSide)
          : active.type === 'newParagraph' ? { ...active.rects.at(-1)!,
            x: active.rects.at(-1)!.x + active.rects.at(-1)!.width + (active.positionOffset?.x ?? 0),
            y: active.rects.at(-1)!.y + (active.positionOffset?.y ?? 0) }
          : active.type === 'join' ? active.rects[0] : sourceFrames(active, size.width, size.height).at(-1)!;
        const left = anchor.x > 50 / size.width ? anchor.x - 43 / size.width : anchor.x + anchor.width + 5 / size.width;
        return <button type="button" className="page-mark-delete" style={{ left: `${clamp(left, 4 / size.width, 1 - 42 / size.width) * 100}%`, top: `${clamp(anchor.y + anchor.height / 2 - 19 / size.height, 4 / size.height, 1 - 42 / size.height) * 100}%` }}
          title="删除整条标注（可撤销）" aria-label="删除已选标注" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onDeleteMark(active.id); }}><Trash2 size={15} /></button>;
      })()}
      {marks.filter((mark) => (mark.type === 'correct' || mark.type === 'insert' || mark.type === 'comment') && mark.rects.length).map((mark) => {
        const box = resolveCallout(mark);
        return <div key={`${mark.id}-callout`} className={`mark-callout ${mark.type} ${focusedId === mark.id ? 'focused' : ''}`}
          role="button" tabIndex={0} title="拖动调整页内批注位置" aria-label={`拖动${MARK_LABEL[mark.type]}文字`}
          style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.width * 100}%`, height: `${box.height * 100}%`, color: mark.textColor ?? mark.color, borderColor: mark.type === 'comment' ? 'transparent' : mark.color, fontSize: `${fontSizeOf(mark) * zoom}px`, padding: mark.type === 'comment' ? `${1 * zoom}px ${2 * zoom}px` : box.height * size.height > 32 * zoom ? `${4 * zoom}px ${16 * zoom}px` : `${2 * zoom}px ${6 * zoom}px` }}
          onClick={() => onFocusMark(mark.id)}
          onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); onFocusMark(mark.id); onCalloutDragStart(); dragRef.current = { id: mark.id, pointerId: event.pointerId, x: event.clientX, y: event.clientY, start: box }; event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={(event) => { const drag = dragRef.current; if (!drag || drag.pointerId !== event.pointerId) return; onCalloutMove(drag.id, { ...drag.start, x: clamp(drag.start.x + (event.clientX - drag.x) / size.width, .008, 1 - drag.start.width - .008), y: clamp(drag.start.y + (event.clientY - drag.y) / size.height, .008, 1 - drag.start.height - .008) }); }}
          onPointerUp={() => { dragRef.current = null; }} onPointerCancel={() => { dragRef.current = null; }}>
          {calloutLines(mark.type === 'comment' ? mark.note : mark.replacement, mark.type, size.width / zoom, fontSizeOf(mark)).join('\n')}
          {(mark.type === 'correct' || mark.type === 'insert') && editMode && focusedId === mark.id && <span className="callout-resize" role="button" tabIndex={0} title="拖动调整文字圆圈大小" aria-label="拖动调整文字圆圈大小"
            onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); onCalloutDragStart(); calloutResizeRef.current = { id: mark.id, pointerId: event.pointerId, x: event.clientX, y: event.clientY, start: box }; event.currentTarget.setPointerCapture(event.pointerId); }}
            onPointerMove={(event) => { const drag = calloutResizeRef.current; if (!drag || drag.pointerId !== event.pointerId) return; event.preventDefault(); event.stopPropagation(); const fit = calloutSize(mark.replacement, mark.type, size.width / zoom, size.height / zoom, fontSizeOf(mark)); onCalloutResize(drag.id, { ...drag.start, width: clamp(drag.start.width + (event.clientX - drag.x) / size.width, Math.max(22 / size.width, fit.width * .75), 1 - drag.start.x - .008), height: clamp(drag.start.height + (event.clientY - drag.y) / size.height, Math.max(22 / size.height, fit.height * .75), 1 - drag.start.y - .008) }); }}
            onPointerUp={(event) => { event.stopPropagation(); calloutResizeRef.current = null; }} onPointerCancel={() => { calloutResizeRef.current = null; }} />}
        </div>;
      })}
    </div>
  </div>;
}

function Thumbnail({ pdf, number, current, onClick }: { pdf: PDFDocumentProxy; number: number; current: boolean; onClick: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const holderRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const holder = holderRef.current;
    if (!holder) return;
    let disposed = false;
    let task: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | null = null;
    const observer = new IntersectionObserver((entries) => {
      if (!entries[0].isIntersecting) return;
      observer.disconnect();
      (async () => {
        const page = await pdf.getPage(number);
        if (disposed) return;
        const view = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: 104 / view.width });
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        task = page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport });
        await task.promise;
      })().catch(() => undefined);
    }, { rootMargin: '300px' });
    observer.observe(holder);
    return () => { disposed = true; observer.disconnect(); task?.cancel(); };
  }, [pdf, number]);
  return <button ref={holderRef} className={`thumbnail ${current ? 'is-current' : ''}`} onClick={onClick} title={`跳转到第 ${number} 页`}>
    <div className="thumb-paper"><canvas ref={canvasRef} /></div><span>{pageLabel(number)}</span>
  </button>;
}

export default function App() {
  const [project, setProject] = useState<ProjectData | null>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1.15);
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [draftType, setDraftType] = useState<MarkType | null>(null);
  const [draftValue, setDraftValue] = useState('');
  const [draftInsertionSide, setDraftInsertionSide] = useState<InsertionSide>('after');
  const [activeColor, setActiveColor] = useState(COLORS[0].value);
  const [author, setAuthor] = useState('编辑');
  const [round, setRound] = useState('初校');
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [recent, setRecent] = useState<ProjectMeta[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [saved, setSaved] = useState(true);
  const [mobileTab, setMobileTab] = useState<'pdf' | 'list'>('pdf');
  const [listOpen, setListOpen] = useState(false);
  const [filter, setFilter] = useState('全部');
  const [sort, setSort] = useState<'page' | 'time'>('page');
  const [showHelp, setShowHelp] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const pageRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);
  const valueInputRef = useRef<HTMLInputElement>(null);
  const historyRef = useRef<ProofMark[][]>([]);
  const pageMetricsRef = useRef<Map<number, PageTextMetrics>>(new Map());
  const receivePageMetrics = useCallback((pageNumber: number, metrics: PageTextMetrics) => { pageMetricsRef.current.set(pageNumber, metrics); }, []);

  useEffect(() => { listProjects().then(setRecent).catch(() => undefined); }, []);
  useEffect(() => {
    if (!project) return;
    setSaved(false);
    const timer = window.setTimeout(async () => {
      try {
        await saveProject(project);
        setSaved(true);
        setRecent((previous) => [project.meta, ...previous.filter((item) => item.id !== project.meta.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
      } catch {
        setError('浏览器本地保存失败。请导出工程文件备份。');
      }
    }, 500);
    return () => window.clearTimeout(timer);
  }, [project]);
  useEffect(() => {
    if (draftType) window.setTimeout(() => valueInputRef.current?.focus(), 20);
  }, [draftType]);

  const openData = useCallback(async (data: ProjectData) => {
    setBusy('正在打开 PDF…');
    try {
      const bytes = new Uint8Array(await data.pdf.arrayBuffer());
      const document = await getDocument({ data: bytes, useSystemFonts: true }).promise;
      data.meta.pageCount = document.numPages;
      const sizes = new Map<number, { width: number; height: number }>();
      for (const number of new Set(data.marks.map((mark) => mark.page))) {
        if (number < 1 || number > document.numPages) continue;
        const markedPage = await document.getPage(number);
        const viewport = markedPage.getViewport({ scale: 1 });
        sizes.set(number, { width: viewport.width, height: viewport.height });
      }
      const normalizedData = { ...data, marks: data.marks.map((mark) => {
        const size = sizes.get(mark.page);
        if (!size) return mark;
        const rects = mergeSelectionRects(mark.rects, size.width, size.height);
        if (mark.type === 'delete' || mark.type === 'join' || mark.type === 'newParagraph') return { ...mark, rects };
        const text = mark.type === 'comment' ? mark.note : mark.replacement;
        const previous = mark.callout ?? placeCallout(rects, text, mark.type, [], size.width, size.height);
        const fitted = mark.calloutManualSize && mark.callout ? { width: mark.callout.width, height: mark.callout.height } : calloutSize(text, mark.type, size.width, size.height, fontSizeOf(mark));
        return { ...mark, rects, callout: {
          x: clamp(previous.x + (previous.width - fitted.width) / 2, .008, 1 - fitted.width - .008),
          y: clamp(previous.y + (previous.height - fitted.height) / 2, .008, 1 - fitted.height - .008),
          ...fitted,
        } };
      }) };
      setPdf((old) => { old?.destroy(); return document; });
      pageMetricsRef.current.clear();
      setProject(normalizedData);
      setPage(1);
      setSelection(null);
      setFocusedId(null);
      setEditMode(false);
      setMobileTab('pdf');
      setError('');
      historyRef.current = [];
    } catch (cause) {
      setError(`无法打开 PDF：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally { setBusy(''); }
  }, []);

  const openFile = useCallback(async (file: File) => {
    if (!/\.pdf$/i.test(file.name) && !/\.zhupi$/i.test(file.name)) { setError('请选择 PDF 或 .zhupi 工程文件'); return; }
    try {
      if (/\.zhupi$/i.test(file.name)) { await openData(await importProject(file)); return; }
      const data: ProjectData = { meta: { id: crypto.randomUUID(), name: file.name, pageCount: 0, updatedAt: new Date().toISOString(), markCount: 0 }, pdf: file, marks: [] };
      await openData(data);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '文件导入失败'); }
  }, [openData]);

  const updateProject = useCallback((nextMarks: ProofMark[]) => {
    setProject((old) => old ? { ...old, marks: nextMarks, meta: { ...old.meta, markCount: nextMarks.length, updatedAt: new Date().toISOString() } } : null);
  }, []);
  const mutateMarks = useCallback((operation: (marks: ProofMark[]) => ProofMark[]) => {
    setProject((old) => {
      if (!old) return old;
      historyRef.current.push(old.marks);
      if (historyRef.current.length > 50) historyRef.current.shift();
      const marks = operation(old.marks);
      return { ...old, marks, meta: { ...old.meta, markCount: marks.length, updatedAt: new Date().toISOString() } };
    });
  }, []);
  const undo = useCallback(() => {
    const previous = historyRef.current.pop();
    if (previous) updateProject(previous);
  }, [updateProject]);

  const captureSelection = useCallback((point?: { x: number; y: number }) => {
    if (editMode || draftType) return;
    const browserSelection = window.getSelection();
    const surface = pageRef.current;
    if (!browserSelection || !surface) return;
    if (browserSelection.isCollapsed && point) selectPdfGlyphAtPoint(surface, point.x, point.y);
    const selected = readPdfTextSelection(browserSelection, surface);
    if (!selected) return;
    const { quote, rects } = selected;
    const last = browserSelection.getRangeAt(0).getBoundingClientRect();
    const endNode = selected.endNode;
    const endSpan = (endNode.nodeType === Node.ELEMENT_NODE ? endNode as Element : endNode.parentElement)?.closest('.pdf-text-layer span');
    const fontSize = endSpan ? Number.parseFloat(window.getComputedStyle(endSpan).fontSize) : NaN;
    const pageMetrics = pageMetricsRef.current.get(page) ?? pageTextMetrics(rects);
    const textMetrics = Number.isFinite(fontSize) && fontSize > 0
      ? { ...pageMetrics, glyphHeight: fontSize / surface.getBoundingClientRect().height }
      : pageMetrics;
    setSelection({ quote, rects, textMetrics, x: Math.min(window.innerWidth - 274, Math.max(8, last.left)), y: Math.max(12, Math.min(window.innerHeight - 170, last.bottom + 10)) });
    setDraftType(null);
    setDraftValue('');
    setDraftInsertionSide('after');
  }, [page, editMode, draftType]);

  useEffect(() => {
    let timer: number | undefined;
    const onSelectionChange = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(captureSelection, 180);
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => { document.removeEventListener('selectionchange', onSelectionChange); window.clearTimeout(timer); };
  }, [captureSelection]);

  const addMark = useCallback((type: MarkType, value = '') => {
    if (!selection) return;
    const surface = pageRef.current;
    const bounds = surface?.getBoundingClientRect();
    const occupied: NormalizedRect[] = bounds ? Array.from(surface!.querySelectorAll('.pdf-text-layer span')).map((span) => {
      const rect = span.getBoundingClientRect();
      return { x: (rect.left - bounds.left) / bounds.width, y: (rect.top - bounds.top) / bounds.height, width: rect.width / bounds.width, height: rect.height / bounds.height };
    }).filter((rect) => rect.width > 0 && rect.height > 0) : [];
    occupied.push(...(project?.marks.filter((mark) => mark.page === page && (mark.type === 'correct' || mark.type === 'insert' || mark.type === 'comment')).map(resolveCallout) ?? []));
    const mark: ProofMark = {
      id: crypto.randomUUID(), page, type, color: activeColor, quote: selection.quote,
      replacement: type === 'comment' ? '' : value.trim(), note: type === 'comment' ? value.trim() : '', author: author.trim() || '未署名', round: round.trim() || '未指定校次',
      status: '待处理', createdAt: new Date().toISOString(), rects: selection.rects, textMetrics: selection.textMetrics,
      insertionSide: type === 'insert' ? draftInsertionSide : undefined,
      calloutManualPosition: type === 'insert' ? false : undefined,
      callout: type === 'delete' || type === 'join' || type === 'newParagraph' ? undefined : placeCallout(type === 'insert' ? [insertionAnchor(selection.rects, draftInsertionSide)] : selection.rects, value.trim(), type, occupied, bounds ? bounds.width / zoom : 595, bounds ? bounds.height / zoom : 842),
    };
    mutateMarks((marks) => [...marks, mark]);
    setFocusedId(null);
    setEditMode(false);
    setSelection(null);
    setDraftType(null);
    setDraftValue('');
    window.getSelection()?.removeAllRanges();
  }, [selection, page, activeColor, author, round, project, mutateMarks, zoom, draftInsertionSide]);

  const chooseType = useCallback((type: MarkType) => {
    if (!selection) { setError('先在 PDF 页面选中要校对的文字'); return; }
    if (type === 'join' && selection.rects.length !== 2) { setError('接排需要恰好跨相邻两行选择文字'); return; }
    if (type === 'delete' || type === 'join' || type === 'newParagraph') addMark(type);
    else { setDraftType(type); setDraftValue(''); if (type === 'insert') setDraftInsertionSide('after'); }
  }, [selection, addMark]);

  const toggleEditMode = useCallback(() => {
    setEditMode((current) => !current);
    setFocusedId(null);
    setSelection(null);
    setDraftType(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  const deleteMark = useCallback((id: string) => {
    mutateMarks((marks) => marks.filter((mark) => mark.id !== id));
    setFocusedId((current) => current === id ? null : current);
  }, [mutateMarks]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.key === 'Escape') { setSelection(null); setDraftType(null); setFocusedId(null); setEditMode(false); return; }
      if (target.matches('input,textarea,select,[contenteditable="true"]')) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); undo(); return; }
      if ((event.key === 'Delete' || event.key === 'Backspace') && focusedId && !selection) { event.preventDefault(); deleteMark(focusedId); return; }
      if (!event.ctrlKey && !event.metaKey && !event.altKey) {
        const key = event.key.toLowerCase();
        if (!editMode && key === 'd') chooseType('delete');
        if (!editMode && key === 'i') chooseType('insert');
        if (!editMode && key === 'r') chooseType('correct');
        if (!editMode && key === 'c') chooseType('comment');
        if (!editMode && key === 'j') chooseType('join');
        if (!editMode && key === 'p') chooseType('newParagraph');
        if (key === 'arrowleft') setPage((p) => Math.max(1, p - 1));
        if (key === 'arrowright') setPage((p) => Math.min(pdf?.numPages ?? p, p + 1));
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [chooseType, undo, pdf, focusedId, selection, deleteMark, editMode]);

  const runExport = async (label: string, action: (data: ProjectData) => Promise<void> | void) => {
    if (!project) return;
    setBusy(`正在导出${label}…`);
    try { await action(project); setError(''); }
    catch (cause) { setError(`${label}导出失败：${cause instanceof Error ? cause.message : String(cause)}`); }
    finally { setBusy(''); }
  };

  const selectedMark = project?.marks.find((mark) => mark.id === focusedId) ?? null;
  const moveCallout = useCallback((id: string, callout: NormalizedRect) => {
    setProject((old) => old ? { ...old, marks: old.marks.map((mark) => mark.id === id ? { ...mark, callout, calloutManualPosition: true } : mark), meta: { ...old.meta, updatedAt: new Date().toISOString() } } : null);
  }, []);
  const updateInsertionSide = useCallback((id: string, side: InsertionSide) => {
    const bounds = pageRef.current?.getBoundingClientRect();
    const pageWidth = bounds ? bounds.width / zoom : 595;
    const pageHeight = bounds ? bounds.height / zoom : 842;
    const textRects: NormalizedRect[] = bounds ? Array.from(pageRef.current!.querySelectorAll('.pdf-text-layer span')).map((span) => {
      const rect = span.getBoundingClientRect();
      return { x: (rect.left - bounds.left) / bounds.width, y: (rect.top - bounds.top) / bounds.height, width: rect.width / bounds.width, height: rect.height / bounds.height };
    }).filter((rect) => rect.width > 0 && rect.height > 0) : [];
    mutateMarks((marks) => marks.map((mark) => {
      if (mark.id !== id || mark.type !== 'insert' || mark.insertionSide === side) return mark;
      const box = resolveCallout(mark);
      if (mark.calloutManualPosition !== false) return { ...mark, insertionSide: side };
      const occupied = [...textRects, ...marks.filter((other) => other.id !== id && other.page === mark.page && (other.type === 'correct' || other.type === 'insert' || other.type === 'comment')).map(resolveCallout)];
      const placed = placeCallout([insertionAnchor(mark.rects, side)], mark.replacement, 'insert', occupied, pageWidth, pageHeight);
      return { ...mark, insertionSide: side, callout: { ...box,
        x: clamp(placed.x, .008, 1 - box.width - .008),
        y: clamp(placed.y, .008, 1 - box.height - .008),
      } };
    }));
  }, [mutateMarks, zoom]);
  const resizeCallout = useCallback((id: string, callout: NormalizedRect) => {
    setProject((old) => old ? { ...old, marks: old.marks.map((mark) => mark.id === id ? { ...mark, callout, calloutManualSize: true } : mark), meta: { ...old.meta, updatedAt: new Date().toISOString() } } : null);
  }, []);
  const moveOutline = useCallback((id: string, index: number, oval: NormalizedRect) => {
    setProject((old) => old ? { ...old, marks: old.marks.map((mark) => {
      if (mark.id !== id) return mark;
      const bounds = pageRef.current?.getBoundingClientRect();
      const previous = sourceFrames(mark, bounds ? bounds.width / zoom : 595, bounds ? bounds.height / zoom : 842);
      const moved = previous[index];
      const outlines = previous.map((item, itemIndex) => itemIndex === index ? oval : item);
      const tailEnd = mark.type === 'delete' && mark.tailEnd && index === previous.length - 1
        ? { x: clamp(mark.tailEnd.x + oval.x - moved.x, .003, .997), y: clamp(mark.tailEnd.y + oval.y - moved.y, .003, .997) }
        : mark.tailEnd;
      return { ...mark, outlines, tailEnd };
    }), meta: { ...old.meta, updatedAt: new Date().toISOString() } } : null);
  }, [zoom]);
  const moveTail = useCallback((id: string, tailEnd: MarkPoint) => {
    setProject((old) => old ? { ...old, marks: old.marks.map((mark) => mark.id === id ? { ...mark, tailEnd } : mark), meta: { ...old.meta, updatedAt: new Date().toISOString() } } : null);
  }, []);
  const movePosition = useCallback((id: string, positionOffset: MarkPoint) => {
    setProject((old) => old ? { ...old, marks: old.marks.map((mark) => mark.id === id ? { ...mark, positionOffset } : mark), meta: { ...old.meta, updatedAt: new Date().toISOString() } } : null);
  }, []);
  const beginCalloutDrag = useCallback(() => { if (project) historyRef.current.push(project.marks); }, [project]);
  const updateMarkText = useCallback((id: string, field: 'replacement' | 'note', text: string) => {
    mutateMarks((marks) => marks.map((mark) => {
      if (mark.id !== id) return mark;
      const box = resolveCallout(mark);
      const bounds = pageRef.current?.getBoundingClientRect();
      const size = mark.calloutManualSize ? { width: box.width, height: box.height } : calloutSize(text, mark.type, bounds ? bounds.width / zoom : 595, bounds ? bounds.height / zoom : 842, fontSizeOf(mark));
      return { ...mark, [field]: text, callout: {
        x: clamp(box.x + (box.width - size.width) / 2, .008, 1 - size.width - .008),
        y: clamp(box.y + (box.height - size.height) / 2, .008, 1 - size.height - .008),
        ...size,
      } };
    }));
  }, [mutateMarks, zoom]);
  const updateFontSize = useCallback((id: string, fontSize: number) => {
    mutateMarks((marks) => marks.map((mark) => {
      if (mark.id !== id) return mark;
      const nextFontSize = clamp(fontSize || 10.5, 8, 32);
      if (mark.type === 'delete') return { ...mark, fontSize: nextFontSize };
      const bounds = pageRef.current?.getBoundingClientRect();
      const box = resolveCallout(mark);
      const text = mark.type === 'comment' ? mark.note : mark.replacement;
      const size = mark.calloutManualSize ? { width: box.width, height: box.height } : calloutSize(text, mark.type, bounds ? bounds.width / zoom : 595, bounds ? bounds.height / zoom : 842, nextFontSize);
      return { ...mark, fontSize: nextFontSize, callout: {
        x: clamp(box.x + (box.width - size.width) / 2, .008, 1 - size.width - .008),
        y: clamp(box.y + (box.height - size.height) / 2, .008, 1 - size.height - .008),
        ...size,
      } };
    }));
  }, [mutateMarks, zoom]);
  const filteredMarks = useMemo(() => {
    const marks = project?.marks.filter((mark) => filter === '全部' || mark.status === filter || mark.color === filter || mark.author === filter || mark.round === filter) ?? [];
    return [...marks].sort((a, b) => sort === 'page' ? a.page - b.page || a.createdAt.localeCompare(b.createdAt) : b.createdAt.localeCompare(a.createdAt));
  }, [project, filter, sort]);
  const filters = useMemo(() => ['全部', '待处理', '已采纳', '已驳回', ...new Set(project?.marks.map((mark) => mark.author) ?? []), ...new Set(project?.marks.map((mark) => mark.round) ?? [])], [project]);

  const renderList = () => <aside className={`annotation-panel ${listOpen ? 'tablet-open' : ''} ${mobileTab === 'list' ? 'mobile-open' : ''}`}>
    <div className="panel-heading"><div><span className="eyebrow">ANNOTATIONS</span><h2>批注清单 <em>{project?.marks.length ?? 0}</em></h2></div><button className="icon-button tablet-close" onClick={() => setListOpen(false)} aria-label="关闭批注栏"><X size={18} /></button></div>
    <div className="filter-row"><div className="select-wrap"><ListFilter size={15} /><select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="筛选批注">{filters.map((option) => <option key={option}>{option}</option>)}{COLORS.map((item) => <option key={item.value} value={item.value}>{item.name}</option>)}</select><ChevronDown size={13} /></div><div className="select-wrap"><select value={sort} onChange={(e) => setSort(e.target.value as 'page' | 'time')} aria-label="排序"><option value="page">按页码</option><option value="time">按时间</option></select><ChevronDown size={13} /></div></div>
    <div className="annotation-scroll">{!filteredMarks.length ? <div className="empty-list"><Highlighter size={27} /><strong>还没有批注</strong><span>在 PDF 中选中文字，开始第一处校对。</span></div> : filteredMarks.map((mark) => <article key={mark.id} className={`annotation-card ${mark.id === focusedId ? 'selected' : ''}`} style={{ ['--mark-color' as string]: mark.color }} onClick={() => { setPage(mark.page); setEditMode(true); setSelection(null); setFocusedId(mark.id); setMobileTab('pdf'); setListOpen(false); }}>
      <div className="card-top"><span className="card-page">P{pageLabel(mark.page)}</span><span className="card-type">{MARK_LABEL[mark.type]}{mark.type === 'insert' ? ` · 文字${mark.insertionSide === 'before' ? '前' : '后'}` : ''}</span><span className="card-status">{mark.status}</span></div>
      <p className="card-quote">“{mark.quote}”</p>
      {mark.replacement && <p className="card-change"><ArrowRight size={14} /> {mark.replacement}</p>}
      {mark.note && <p className="card-note">{mark.note}</p>}
      <div className="card-meta"><span>{mark.author} · {mark.round}</span><span>{new Date(mark.createdAt).toLocaleDateString('zh-CN')}</span></div>
    </article>)}</div>
    {selectedMark && <div className="mark-editor"><div className="editor-title"><strong>编辑批注</strong><button className="icon-button" onClick={() => { setFocusedId(null); setEditMode(false); }} aria-label="收起编辑"><X size={16} /></button></div><div className="editor-fields">
      {(selectedMark.type === 'correct' || selectedMark.type === 'insert') && <label>页内修正文字<input value={selectedMark.replacement} onChange={(e) => updateMarkText(selectedMark.id, 'replacement', e.target.value)} placeholder="输入建议文字" /></label>}
      {selectedMark.type === 'insert' && <label>增补位置<select value={selectedMark.insertionSide ?? 'after'} onChange={(e) => updateInsertionSide(selectedMark.id, e.target.value as InsertionSide)}><option value="before">选中文字前</option><option value="after">选中文字后</option></select></label>}
      <label>{selectedMark.type === 'comment' ? '页内批注文字' : '说明'}<textarea value={selectedMark.note} onChange={(e) => selectedMark.type === 'comment' ? updateMarkText(selectedMark.id, 'note', e.target.value) : mutateMarks((marks) => marks.map((mark) => mark.id === selectedMark.id ? { ...mark, note: e.target.value } : mark))} placeholder="输入批注内容" rows={2} /></label>
      <div className="editor-grid"><label>状态<select value={selectedMark.status} onChange={(e) => mutateMarks((marks) => marks.map((mark) => mark.id === selectedMark.id ? { ...mark, status: e.target.value as ProofMark['status'] } : mark))}><option>待处理</option><option>已采纳</option><option>已驳回</option></select></label><label>符号颜色<input type="color" value={selectedMark.color} onChange={(e) => mutateMarks((marks) => marks.map((mark) => mark.id === selectedMark.id ? { ...mark, color: e.target.value } : mark))} /></label></div>
      {(selectedMark.type === 'correct' || selectedMark.type === 'insert' || selectedMark.type === 'comment') && <div className="editor-grid"><label>文字颜色<input type="color" value={selectedMark.textColor ?? selectedMark.color} onChange={(e) => mutateMarks((marks) => marks.map((mark) => mark.id === selectedMark.id ? { ...mark, textColor: e.target.value } : mark))} /></label><label>文字字号（pt）<input type="number" min="8" max="32" step="0.5" value={fontSizeOf(selectedMark)} onChange={(e) => updateFontSize(selectedMark.id, Number(e.target.value))} /></label></div>}
      {(selectedMark.type === 'correct' || selectedMark.type === 'delete' || selectedMark.type === 'comment') && <small className="editor-hint">选标注模式下，拖原文方框边线移动，拖右下角手柄调整大小。</small>}
      {(selectedMark.type === 'correct' || selectedMark.type === 'insert') && <small className="editor-hint">拖页内文字圆圈移动，拖右下角方形手柄调整大小。</small>}
      {selectedMark.type === 'delete' && <small className="editor-hint">选中删除符号，拖尾巴末端方形手柄可调整方向。</small>}
      <button className="text-danger" onClick={() => deleteMark(selectedMark.id)}><Trash2 size={15} /> 删除此标注</button>
    </div></div>}
  </aside>;

  return <div className={`app ${project ? 'has-project' : 'no-project'}`} onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); }} onDrop={(e) => { e.preventDefault(); setDragOver(false); const file = e.dataTransfer.files[0]; if (file) openFile(file); }}>
    <header className="topbar"><div className="brand" onClick={() => { setProject(null); setPdf(null); }} role="button" tabIndex={0}><span className="brand-mark">朱</span><span className="brand-name">朱批<span className="brand-dot">.</span></span><span className="brand-sub">PDF 编校工作台</span></div>
      <div className="topbar-center">{project && <><span className="document-dot" /><span className="document-name" title={project.meta.name}>{project.meta.name}</span><span className="topbar-separator" /><span className="save-status"><CloudOff size={14} /> {saved ? '已保存至本机' : '正在保存…'}</span></>}</div>
      <div className="topbar-actions">{project && <><button className="header-button hide-phone" onClick={() => fileInputRef.current?.click()}><FolderOpen size={16} /> 打开文件</button><div className={`export-menu ${exportOpen ? 'is-open' : ''}`}><button className="primary-button" onClick={() => runExport('带痕迹 PDF', exportMarkedPdf)} disabled={!!busy}><Download size={17} /> <span>导出校样</span></button><button className="export-more" onClick={() => setExportOpen((open) => !open)} aria-label="更多导出格式"><ChevronDown size={15} /></button><div className="export-popover"><button onClick={() => { setExportOpen(false); runExport('干净 PDF', exportCleanPdf); }}><FileDown size={16} /> 干净 PDF</button><button onClick={() => { setExportOpen(false); runExport('Excel 清单', exportExcel); }}><FileSpreadsheet size={16} /> Excel 清单</button><button onClick={() => { setExportOpen(false); runExport('Word 清单', exportWord); }}><FileText size={16} /> Word 清单</button><button onClick={() => { setExportOpen(false); runExport('工程文件', exportProject); }}><FileArchive size={16} /> 工程文件</button></div></div></>}
      <button className="icon-button help-button" onClick={() => setShowSettings(true)} aria-label="标注设置"><Settings2 size={18} /></button><button className="icon-button help-button" onClick={() => setShowHelp(true)} aria-label="使用帮助"><CircleHelp size={19} /></button></div></header>
    <input ref={fileInputRef} type="file" accept="application/pdf,.pdf,.zhupi" hidden onChange={(e) => { const file = e.target.files?.[0]; if (file) openFile(file); e.target.value = ''; }} />
    <input ref={projectInputRef} type="file" accept=".zhupi" hidden onChange={(e) => { const file = e.target.files?.[0]; if (file) openFile(file); e.target.value = ''; }} />
    {error && <div className="toast-error" role="alert">{error}<button onClick={() => setError('')} aria-label="关闭"><X size={15} /></button></div>}
    {busy && <div className="busy-indicator">{busy}</div>}
    {dragOver && <div className="drop-overlay"><UploadCloud size={44} /><strong>松开即可导入</strong><span>PDF 或 .zhupi 工程文件</span></div>}
    {!project && <main className="welcome"><div className="welcome-copy"><span className="eyebrow">THE PROOFREADER'S DESK</span><h1>把校样摊开，<br /><em>认真改好每一处。</em></h1><p>选中文字，落下朱批。原稿始终完整，批注独立保存。<br className="hide-phone" />从第一处校正，到最后一份清单，都在这里完成。</p><div className="welcome-features"><span><Check size={15} /> 原文不改动</span><span><Check size={15} /> 文件留在本机</span><span><Check size={15} /> 三端续改</span></div></div><div className="welcome-action"><div className="drop-card" onClick={() => fileInputRef.current?.click()} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') fileInputRef.current?.click(); }}><span className="drop-icon"><UploadCloud size={31} /></span><strong>拖入一份 PDF 校样</strong><span>或点击选择文件，立即开始编校</span><button className="primary-button"><Plus size={18} /> 选择 PDF 文件</button><small>支持可选中文字的 PDF · 文件默认不上传</small></div><div className="recent-block"><div className="recent-heading"><span><Clock3 size={15} /> 最近打开</span><button onClick={() => projectInputRef.current?.click()}>导入工程 <ArrowRight size={14} /></button></div>{recent.length ? recent.slice(0, 4).map((item) => <button className="recent-item" key={item.id} onClick={async () => { const data = await loadProject(item.id); if (data) openData(data); else setError('本地文件已不可用，请重新导入工程文件'); }}><FileText size={18} /><span><strong>{item.name}</strong><small>{item.pageCount} 页 · {item.markCount} 条批注</small></span><ChevronRight size={16} /></button>) : <p className="recent-empty">你的校样会出现在这里。</p>}</div></div></main>}
    {project && pdf && <><div className="workspace"><aside className="thumb-rail"><div className="rail-heading"><span>页面</span><span>{pdf.numPages}</span></div><div className="thumb-scroll">{Array.from({ length: pdf.numPages }, (_, index) => <Thumbnail key={index + 1} pdf={pdf} number={index + 1} current={page === index + 1} onClick={() => { setPage(index + 1); setSelection(null); }} />)}</div></aside>
      <main className={`document-area ${mobileTab === 'list' ? 'mobile-hidden' : ''}`}><div className="workspace-toolbar"><div className="tool-group"><span className="toolbar-caption">常用符号</span><button className="symbol-button" onClick={() => chooseType('correct')} title="改正 · R"><MarkIcon type="correct" /><span>改正</span></button><button className="symbol-button" onClick={() => chooseType('delete')} title="删除 · D"><MarkIcon type="delete" /><span>删除</span></button><button className="symbol-button" onClick={() => chooseType('insert')} title="增补 · I"><MarkIcon type="insert" /><span>增补</span></button><button className="symbol-button" onClick={() => chooseType('comment')} title="批注项 · C"><MarkIcon type="comment" /><span>批注项</span></button><button className="symbol-button" onClick={() => chooseType('join')} title="跨两行选字后接排 · J"><MarkIcon type="join" /><span>接排</span></button><button className="symbol-button" onClick={() => chooseType('newParagraph')} title="选中文字，在末尾另起一段 · P"><MarkIcon type="newParagraph" /><span>另起段</span></button></div><span className="tool-divider" /><div className="color-tools"><span className="toolbar-caption">批注颜色</span>{COLORS.map((item) => <button key={item.value} className={`color-dot ${activeColor === item.value ? 'active' : ''}`} style={{ background: item.value }} title={item.name} aria-label={item.name} onClick={() => setActiveColor(item.value)} />)}<label className="custom-color" title="自定义颜色"><Plus size={14} /><input type="color" value={activeColor} onChange={(e) => setActiveColor(e.target.value)} aria-label="自定义颜色" /></label></div><span className="tool-divider secondary-divider" /><button className={`mark-mode-button ${editMode ? 'active' : ''}`} onClick={toggleEditMode} aria-pressed={editMode} title={editMode ? '返回选字模式 · Esc' : '点选已有标注并拖动、缩放或删除'}><MousePointer2 size={16} /> {editMode ? '返回选字' : '选标注'}</button><button className="icon-button undo-button" onClick={undo} title="撤销 · Ctrl+Z"><RotateCcw size={18} /></button><button className="icon-button tablet-list-button" onClick={() => setListOpen(true)} title="批注列表"><Menu size={18} /></button></div>
        <div className="reading-area"><div className="reading-topline"><span>第 {page} 页 / 共 {pdf.numPages} 页</span><span>{editMode ? '点选已有圈线或增补符号 · 拖动调整 · 点击垃圾桶删除 · Esc 返回选字' : '选中文字即可显示校对符号 · 点“选标注”可调整已有符号'}</span></div><div className="paper-scroll"><PdfPage pdf={pdf} pageNumber={page} zoom={zoom} marks={project.marks.filter((mark) => mark.page === page)} focusedId={focusedId} editMode={editMode} pageRef={pageRef} onSelection={captureSelection} onFocusMark={setFocusedId} onCalloutMove={moveCallout} onCalloutResize={resizeCallout} onOutlineMove={moveOutline} onTailMove={moveTail} onPositionMove={movePosition} onDeleteMark={deleteMark} onPageMetrics={receivePageMetrics} onCalloutDragStart={beginCalloutDrag} /></div></div>
        <div className="page-controls"><div className="page-nav"><button className="icon-button" onClick={() => setPage(Math.max(1, page - 1))} disabled={page === 1} aria-label="上一页"><ChevronLeft size={20} /></button><input type="number" min={1} max={pdf.numPages} value={page} onChange={(e) => setPage(Math.max(1, Math.min(pdf.numPages, Number(e.target.value) || 1)))} aria-label="页码" /><span>/ {pdf.numPages}</span><button className="icon-button" onClick={() => setPage(Math.min(pdf.numPages, page + 1))} disabled={page === pdf.numPages} aria-label="下一页"><ChevronRight size={20} /></button></div><div className="zoom-controls"><button className="icon-button" onClick={() => setZoom((old) => Math.max(.5, Number((old - .15).toFixed(2))))} aria-label="缩小"><ZoomOut size={18} /></button><span>{Math.round(zoom * 100)}%</span><button className="icon-button" onClick={() => setZoom((old) => Math.min(2.5, Number((old + .15).toFixed(2))))} aria-label="放大"><ZoomIn size={18} /></button></div></div>
      </main>{renderList()}</div>
      <div className="mobile-nav"><button className={mobileTab === 'pdf' ? 'active' : ''} onClick={() => setMobileTab('pdf')}><FileText size={19} /> 校样</button><button className={mobileTab === 'list' ? 'active' : ''} onClick={() => setMobileTab('list')}><ListFilter size={19} /> 批注 <span>{project.marks.length}</span></button></div>
      <div className="mobile-tools"><button className={editMode ? 'active' : ''} onClick={toggleEditMode} aria-pressed={editMode}><MousePointer2 size={20} />{editMode ? '返回选字' : '选标注'}</button><button onClick={() => chooseType('correct')}><MarkIcon type="correct" />改正</button><button onClick={() => chooseType('delete')}><MarkIcon type="delete" />删除</button><button onClick={() => chooseType('insert')}><MarkIcon type="insert" />增补</button><button onClick={() => chooseType('comment')}><MarkIcon type="comment" />批注项</button><button onClick={() => chooseType('join')}><MarkIcon type="join" />接排</button><button onClick={() => chooseType('newParagraph')}><MarkIcon type="newParagraph" />另起段</button><button onClick={undo}><RotateCcw size={18} />撤销</button><button onClick={() => runExport('工程文件', exportProject)}><FileArchive size={18} />工程</button><button onClick={() => runExport('Excel 清单', exportExcel)}><FileSpreadsheet size={18} />清单</button></div>
    </>}
    {selection && <div className="selection-popover" style={{ left: selection.x, top: draftType === 'insert' ? Math.min(selection.y, Math.max(8, window.innerHeight - 230)) : selection.y }} onMouseDown={(e) => e.preventDefault()}><div className="selected-preview">已选“{selection.quote.length > 18 ? `${selection.quote.slice(0, 18)}…` : selection.quote}”<button onClick={() => { setSelection(null); setDraftType(null); }} aria-label="取消选区"><X size={14} /></button></div>{draftType ? <div className="draft-form"><label>{draftType === 'correct' ? '改成' : draftType === 'comment' ? '批注内容' : '增补内容'}<input ref={valueInputRef} value={draftValue} onChange={(e) => setDraftValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && draftValue.trim()) addMark(draftType, draftValue); }} placeholder={draftType === 'comment' ? '输入批注文字' : '输入建议文字'} /></label>{draftType === 'insert' && <div className="insert-position"><span>增补位置</span><div role="group" aria-label="增补位置"><button type="button" aria-pressed={draftInsertionSide === 'before'} onClick={() => setDraftInsertionSide('before')}>文字前</button><button type="button" aria-pressed={draftInsertionSide === 'after'} onClick={() => setDraftInsertionSide('after')}>文字后</button></div></div>}<button className="primary-button" disabled={!draftValue.trim()} onClick={() => addMark(draftType, draftValue)}>保存标注</button><button className="back-link" onClick={() => setDraftType(null)}><ArrowLeft size={13} /> 返回符号</button></div> : <div className="popover-actions"><button onClick={() => chooseType('correct')}><MarkIcon type="correct" /> 改正</button><button onClick={() => chooseType('delete')}><MarkIcon type="delete" /> 删除</button><button onClick={() => chooseType('insert')}><MarkIcon type="insert" /> 增补</button><button onClick={() => chooseType('comment')}><MarkIcon type="comment" /> 批注项</button><button onClick={() => chooseType('join')}><MarkIcon type="join" /> 接排</button><button onClick={() => chooseType('newParagraph')}><MarkIcon type="newParagraph" /> 另起段</button></div>}</div>}
    {showHelp && <div className="modal-backdrop" onClick={() => setShowHelp(false)}><div className="help-modal" onClick={(e) => e.stopPropagation()}><button className="icon-button modal-close" onClick={() => setShowHelp(false)} aria-label="关闭"><X size={19} /></button><span className="eyebrow">QUICK GUIDE</span><h2>像在纸样上一样校对。</h2><ol><li>导入可选中文字的 PDF，拖选文字；单击一个字或标点可直接选中完整字符。</li><li>在悬浮条选择改正、删除、增补或批注项；增补可选在文字前或文字后。</li><li>接排：跨相邻两行选择需要接在一起的文字。另起段：选中分段点前的文字，符号从选区末尾向右起笔；在“选标注”模式可拖动调整。</li><li>要修改已有标注，点“选标注”，再点页上的原文方框、增补符号或页内文字；也可从批注清单定位。</li><li>在选标注模式拖动原文方框移动，拖右下角手柄缩放；改正和增补的文字圆圈也可拖动与缩放，删除尾巴可拖末端手柄改方向。</li><li>选中标注后点页内垃圾桶或按 Delete 删除整条标注，可撤销。</li><li>点“返回选字”或按 Esc 后可继续选择 PDF 文字。</li><li>导出带痕迹 PDF、Excel/Word 修改清单，或导出工程文件续改。</li></ol><div className="shortcut-box"><strong>键盘快捷键</strong><span>R 改正 · D 删除 · I 增补 · C 批注项 · J 接排 · P 另起段 · Delete 删除已选标注 · Esc 返回选字 · Ctrl/⌘ + Z 撤销</span></div><p>所有稿件与批注默认保存在当前浏览器本机。跨设备续改请导出并导入 .zhupi 工程文件。</p></div></div>}
    {showSettings && <div className="modal-backdrop" onClick={() => setShowSettings(false)}><div className="help-modal settings-modal" onClick={(e) => e.stopPropagation()}><button className="icon-button modal-close" onClick={() => setShowSettings(false)} aria-label="关闭"><X size={19} /></button><span className="eyebrow">MARKING PROFILE</span><h2>当前标注身份</h2><p>之后新建的标注会记录以下信息，已有标注不受影响。</p><label>标注人<input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="如：责任编辑" /></label><label>校次<input value={round} onChange={(e) => setRound(e.target.value)} placeholder="如：二校" /></label><button className="primary-button" onClick={() => setShowSettings(false)}>完成</button></div></div>}
  </div>;
}
