import { expect, it } from "vitest";
import { extractPdf } from "../lib/extract.js";

// A complete tiny PDF with a real cross-reference table: exercises the installed
// parser, not a mock of unpdf's API, and contains no customer document data.
function samplePdf(): Uint8Array {
  const stream = 'BT /F1 12 Tf 72 720 Td (Lares PDF extraction) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Title (Lares fixture) >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

it('extracts text and metadata through the real installed PDF parser', async () => {
  expect(await extractPdf(samplePdf(), 'https://example.org/fixture.pdf')).toEqual({
    title: 'Lares fixture', text: 'Lares PDF extraction',
  });
});
it('rejects invalid PDF bytes as a parse failure', async () => {
  await expect(extractPdf('not a PDF', 'https://example.org/invalid.pdf')).rejects.toMatchObject({ status: 502 });
});
