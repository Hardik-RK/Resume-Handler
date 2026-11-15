/**
 * Tiny dependency-free PDF writer for tests: text lines (Helvetica), optional raw RGB image,
 * optional URI link annotations. Output is a valid single- or multi-page PDF.
 */
export interface PdfPageSpec {
  lines?: string[];
  image?: { width: number; height: number };
  links?: string[];
}

function esc(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

export function makePdf(pages: PdfPageSpec[]): Buffer {
  const objects: Buffer[] = [];
  const add = (body: string | Buffer): number => {
    objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body, "latin1"));
    return objects.length;
  };
  const catalogId = add(""); // placeholder, filled later
  const pagesId = add("");
  const fontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const pageIds: number[] = [];
  for (const page of pages) {
    let y = 760;
    let content = "";
    for (const line of page.lines ?? []) {
      content += `BT /F1 10 Tf 60 ${y} Td (${esc(line)}) Tj ET\n`;
      y -= 14;
    }
    let xobject = "";
    if (page.image) {
      const { width, height } = page.image;
      const data = Buffer.alloc(width * height * 3);
      for (let i = 0; i < data.length; i += 3) {
        data[i] = 40 + ((i / 3) % 200);
        data[i + 1] = 80;
        data[i + 2] = 160;
      }
      const head = `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${data.length} >>\nstream\n`;
      const imgId = add(Buffer.concat([Buffer.from(head, "latin1"), data, Buffer.from("\nendstream", "latin1")]));
      xobject = `/XObject << /Im1 ${imgId} 0 R >>`;
      content += `q 300 0 0 300 60 300 cm /Im1 Do Q\n`;
    }
    const contentId = add(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}endstream`);
    const annotIds = (page.links ?? []).map((uri) =>
      add(`<< /Type /Annot /Subtype /Link /Rect [60 700 200 720] /Border [0 0 0] /A << /S /URI /URI (${esc(uri)}) >> >>`),
    );
    const annots = annotIds.length ? `/Annots [${annotIds.map((i) => `${i} 0 R`).join(" ")}]` : "";
    const pageId = add(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> ${xobject} >> ${annots} >>`,
    );
    pageIds.push(pageId);
  }
  objects[catalogId - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`, "latin1");
  objects[pagesId - 1] = Buffer.from(
    `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(" ")}] /Count ${pageIds.length} >>`,
    "latin1",
  );
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1")];
  const offsets: number[] = [];
  let pos = parts[0]!.length;
  objects.forEach((body, i) => {
    offsets.push(pos);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, "latin1"), body, Buffer.from("\nendobj\n", "latin1")]);
    parts.push(chunk);
    pos += chunk.length;
  });
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
  parts.push(Buffer.from(xref, "latin1"));
  return Buffer.concat(parts);
}

/** The standard synthetic résumé used across tests (fictional person, example.com address). */
export function resumeLines(candidate: string, email: string, phone: string, extra = ""): string[] {
  return [
    `Candidate: ${candidate}`,
    `${email}   ${phone}   Bengaluru, India`,
    "Education: B.Tech 2021, Example Institute of Technology",
    "Skills: Python, SQL, data analysis and reporting with dashboards and automation.",
    "Experience: built ETL pipelines and automated weekly reports for the operations team.",
    "Projects: inventory forecasting service and an internal resume screening tool.",
    extra,
  ];
}
