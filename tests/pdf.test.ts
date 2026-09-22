import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, PDFName, PDFString, StandardFonts } from "pdf-lib";
import { extractResume, validatePdfBytes } from "@/services/career/pdf";

async function textualPdf(withLinkAnnotation: boolean): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  const lines = ["Maria Silva", "Desenvolvedora Front-end", "maria@exemplo.com  +55 11 91234-5678", "Perfil: linkedin.com/in/maria-silva", "Experiencia", "Desenvolvedora | Loja X - 2021 - atual", "Reduzi o tempo de carregamento em 40%."];
  lines.forEach((l, i) => page.drawText(l, { x: 50, y: 790 - i * 18, size: 12, font }));
  page.drawText("GitHub", { x: 50, y: 600, size: 12, font });
  if (withLinkAnnotation) {
    const annot = doc.context.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [50, 595, 120, 612],
      Border: [0, 0, 0],
      A: { Type: "Action", S: "URI", URI: PDFString.of("https://github.com/maria/app") },
    });
    page.node.set(PDFName.of("Annots"), doc.context.obj([doc.context.register(annot)]));
  }
  return doc.save();
}

describe("PDF: validação e extração", () => {
  it("recusa arquivo sem assinatura, vazio e acima do limite", () => {
    assert.equal(validatePdfBytes(new Uint8Array()).ok, false);
    assert.equal(validatePdfBytes(new TextEncoder().encode("<html>oi</html>")).ok, false);
    assert.equal(validatePdfBytes(new TextEncoder().encode("%PDF-1.4 x"), 5).ok, false);
    assert.equal(validatePdfBytes(new TextEncoder().encode("%PDF-1.4 x")).ok, true);
  });

  it("extrai texto por página e links tanto do texto quanto das anotações", async () => {
    const bytes = await textualPdf(true);
    const r = await extractResume(bytes);
    assert.equal(r.text_status, "ok");
    assert.equal(r.page_count, 1);
    assert.match(r.pages[0]!.text, /Maria Silva/);
    assert.match(r.pages[0]!.text, /40%/);
    const urls = r.links.map((l) => l.url).sort();
    assert.deepEqual(urls, ["https://github.com/maria/app", "https://linkedin.com/in/maria-silva"]);
    assert.equal(r.links.find((l) => l.url.includes("github"))?.origin, "anotacao");
    assert.equal(r.links.find((l) => l.url.includes("linkedin"))?.origin, "texto");
  });

  it("PDF sem texto (digitalizado) pede OCR; bytes corrompidos são reportados", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([595, 842]);
    const blank = await extractResume(await doc.save());
    assert.equal(blank.text_status, "ocr_pendente");

    const broken = new TextEncoder().encode("%PDF-1.7\n%garbage garbage garbage");
    const r = await extractResume(broken);
    assert.equal(r.text_status, "corrompido");
    assert.ok(r.text_note);
  });
});
