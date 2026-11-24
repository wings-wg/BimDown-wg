import JSZip from 'jszip';
import type { SheetRow } from './check-import.js';

const WORKBOOK = 'xl/workbook.xml';
const RELATIONSHIPS = 'xl/_rels/workbook.xml.rels';
const entries = (xml: Document | Element, name: string) => [...xml.getElementsByTagNameNS('*', name)];
const cellText = (xml: Element) => entries(xml, 't').map(node => node.textContent).join('');

async function readXml(zip: JSZip, path: string) {
  const file = zip.file(path);
  if (!file) throw new Error('Excel 工作簿缺少必要的工作表文件。');
  // Limit inflated XML as well as the size of the uploaded ZIP.
  const xml = await new Promise<string>((resolve, reject) => {
    // ZipObject.internalStream is documented by JSZip but missing from its types.
    const streamed = file as typeof file & { internalStream(type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array> };
    const stream = streamed.internalStream('uint8array');
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    let bytes = 0;
    stream.on('data', (chunk: Uint8Array) => {
      bytes += chunk.byteLength;
      if (bytes > 4 * 1024 * 1024) {
        stream.pause();
        reject(new Error('Excel 工作表内容过大，请拆分规则表。'));
      } else {
        chunks.push(decoder.decode(chunk, { stream: true }));
      }
    });
    stream.on('error', reject);
    stream.on('end', () => resolve(chunks.join('') + decoder.decode()));
    stream.resume();
  });
  if (/<!DOCTYPE/i.test(xml)) throw new Error('Excel XML 格式不受支持。');
  const parsed = new DOMParser().parseFromString(xml, 'application/xml');
  if (entries(parsed, 'parsererror').length) throw new Error('Excel 内容无法解析。');
  return parsed;
}

export async function readClauseWorkbook(buffer: ArrayBuffer): Promise<{ sheet: string; rows: SheetRow[] }> {
  const zip = await JSZip.loadAsync(buffer);
  const [workbook, relations, shared] = await Promise.all([readXml(zip, WORKBOOK), readXml(zip, RELATIONSHIPS),
    zip.file('xl/sharedStrings.xml') ? readXml(zip, 'xl/sharedStrings.xml') : undefined]);
  const sheets = entries(workbook, 'sheet');
  const sheet = sheets.find(node => node.getAttribute('name') === '强条规则表') ?? sheets[0];
  const sheetName = sheet?.getAttribute('name');
  if (!sheetName || !sheet) throw new Error('Excel 工作簿中没有规则工作表。');
  const relationshipId = [...sheet.attributes].find(attribute => attribute.localName === 'id')?.value;
  const relation = entries(relations, 'Relationship').find(node => node.getAttribute('Id') === relationshipId);
  const target = relation?.getAttribute('Target');
  if (!target || relation?.getAttribute('TargetMode') === 'External') throw new Error('找不到 Excel 内部规则工作表。');
  const resolved = new URL(target, 'https://xlsx.invalid/xl/workbook.xml');
  const path = resolved.pathname.slice(1);
  if (resolved.origin !== 'https://xlsx.invalid' || !/^xl\/worksheets\/[\w.-]+\.xml$/.test(path))
    throw new Error('规则工作表路径不受支持。');
  const worksheet = await readXml(zip, path);
  const strings = shared ? entries(shared, 'si').map(cellText) : [];
  const rows = entries(worksheet, 'row').map((node, index): SheetRow => {
    const cells = new Map<number, string>();
    const formulaColumns = new Set<number>();
    for (const cell of entries(node, 'c')) {
      const letters = /^([A-Z]+)\d+$/.exec(cell.getAttribute('r') ?? '')?.[1];
      if (!letters || letters.length > 3) continue;
      const column = Array.from(letters).reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
      const type = cell.getAttribute('t');
      const raw = entries(cell, 'v')[0]?.textContent ?? '';
      if (entries(cell, 'f').length) formulaColumns.add(column);
      const value = type === 's' ? strings[Number(raw)] : type === 'inlineStr' ? cellText(cell) : raw;
      if (value?.trim()) cells.set(column, value.trim());
    }
    return { number: Number(node.getAttribute('r')) || index + 1, cells, formulaColumns };
  });
  return { sheet: sheetName, rows };
}
