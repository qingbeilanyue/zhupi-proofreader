import { PDFDocument } from 'pdf-lib';
import JSZip from 'jszip';
import type { ProjectData, ProofMark } from './model';
import { MARK_LABEL } from './model';
import { downloadBlob } from './storage';
import { drawMarks } from './pdfMarks';

function filenameBase(name: string): string {
  return name.replace(/\.pdf$/i, '').replace(/[<>:"/\\|?*]/g, '_');
}

export async function exportMarkedPdf(data: ProjectData): Promise<void> {
  const pdf = await PDFDocument.load(await data.pdf.arrayBuffer());
  await drawMarks(pdf, data.marks);
  const bytes = await pdf.save();
  downloadBlob(new Blob([Uint8Array.from(bytes).buffer], { type: 'application/pdf' }), `${filenameBase(data.meta.name)}-带批注.pdf`);
}

export function exportCleanPdf(data: ProjectData): void {
  downloadBlob(data.pdf, `${filenameBase(data.meta.name)}-原样.pdf`);
}

export async function exportProject(data: ProjectData): Promise<void> {
  const zip = new JSZip();
  zip.file('source.pdf', data.pdf);
  zip.file('project.json', JSON.stringify({ version: 1, meta: data.meta, marks: data.marks }, null, 2));
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  downloadBlob(blob, `${filenameBase(data.meta.name)}.zhupi`);
}

export async function importProject(file: File): Promise<ProjectData> {
  const zip = await JSZip.loadAsync(file);
  const pdfEntry = zip.file('source.pdf');
  const jsonEntry = zip.file('project.json');
  if (!pdfEntry || !jsonEntry) throw new Error('工程文件缺少 PDF 或批注数据');
  const parsed = JSON.parse(await jsonEntry.async('string')) as { version: number; meta: ProjectData['meta']; marks: ProofMark[] };
  if (parsed.version !== 1 || !parsed.meta?.name || !Array.isArray(parsed.marks)) throw new Error('不支持此工程文件格式');
  return {
    meta: { ...parsed.meta, id: crypto.randomUUID(), updatedAt: new Date().toISOString(), markCount: parsed.marks.length },
    pdf: new Blob([Uint8Array.from(await pdfEntry.async('uint8array')).buffer], { type: 'application/pdf' }),
    marks: parsed.marks,
  };
}

function rows(marks: ProofMark[]) {
  return [...marks].sort((a, b) => a.page - b.page || a.createdAt.localeCompare(b.createdAt)).map((mark) => ({
    page: mark.page,
    error: mark.quote,
    type: mark.type === 'insert' ? `增补（文字${mark.insertionSide === 'before' ? '前' : '后'}）` : MARK_LABEL[mark.type],
    correction: mark.type === 'join' ? '接排相邻两行' : mark.type === 'newParagraph' ? '从所选文字末尾另起一段' : mark.replacement,
    status: mark.status,
    note: mark.note,
    author: mark.author,
    round: mark.round,
    time: new Date(mark.createdAt).toLocaleString('zh-CN'),
  }));
}

export async function exportExcel(data: ProjectData): Promise<void> {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('修改清单');
  sheet.columns = [
    { header: '错误页码', key: 'page', width: 12 },
    { header: '具体错误', key: 'error', width: 36 },
    { header: '错误类型', key: 'type', width: 15 },
    { header: '修正', key: 'correction', width: 36 },
    { header: '状态', key: 'status', width: 14 },
    { header: '批注', key: 'note', width: 42 },
    { header: '标注人', key: 'author', width: 16 },
    { header: '校次', key: 'round', width: 14 },
    { header: '时间', key: 'time', width: 24 },
  ];
  rows(data.marks).forEach((row) => sheet.addRow(row));
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF9E3832' } };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: 'A1', to: 'I1' };
  const buffer = await workbook.xlsx.writeBuffer();
  downloadBlob(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${filenameBase(data.meta.name)}-修改清单.xlsx`);
}

export async function exportWord(data: ProjectData): Promise<void> {
  const { Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun, HeadingLevel } = await import('docx');
  const headers = ['错误页码', '具体错误', '错误类型', '修正', '状态'];
  const tableRows = [
    new TableRow({ children: headers.map((value) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: value, bold: true })] })] })) }),
    ...rows(data.marks).map((row) => new TableRow({ children: [row.page, row.error, row.type, row.correction, row.status].map((value) => new TableCell({ children: [new Paragraph(String(value || '—'))] })) })),
  ];
  const doc = new Document({ sections: [{ children: [
    new Paragraph({ text: `${filenameBase(data.meta.name)} · 修改清单`, heading: HeadingLevel.HEADING_1 }),
    new Paragraph(`共 ${data.marks.length} 条批注`),
    new Table({ rows: tableRows }),
    ...rows(data.marks).map((row, index) => new Paragraph({ children: [
      new TextRun({ text: `#${index + 1} 第 ${row.page} 页 ${row.type}：`, bold: true }),
      new TextRun({ text: `${row.note || '无补充说明'}（${row.author || '未署名'} · ${row.round || '未指定校次'}）` }),
    ] })),
  ] }] });
  downloadBlob(await Packer.toBlob(doc), `${filenameBase(data.meta.name)}-修改清单.docx`);
}
