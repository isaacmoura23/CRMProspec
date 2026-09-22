import "server-only";
import crypto from "node:crypto";
import { extractUrlsFromText, normalizeUrl } from "@/lib/resume-text";
import type { ResumeLink, ResumePage, ResumeTextStatus } from "@/types/career";

/**
 * Leitura de PDFs de currículo.
 *
 * Limites deliberados: tamanho, páginas, tempo e volume de texto. O parser
 * (pdf.js via unpdf) nunca executa JavaScript, ações ou arquivos
 * incorporados do documento — só lê texto e anotações de link.
 */

export const MAX_PDF_BYTES = 10 * 1024 * 1024;
export const MAX_PAGES = 30;
const MAX_CHARS_PER_PAGE = 20_000;
const MAX_TOTAL_CHARS = 200_000;
const PARSE_TIMEOUT_MS = 25_000;
/** Abaixo disso o PDF é tratado como digitalizado (imagem) e precisa de OCR. */
const MIN_TEXT_CHARS = 80;

export interface PdfValidation {
  ok: boolean;
  reason?: string;
}

/**
 * Valida pela assinatura e pelo tamanho — o MIME do navegador e a extensão
 * são informados pelo cliente e não contam.
 */
export function validatePdfBytes(bytes: Uint8Array, maxBytes = MAX_PDF_BYTES): PdfValidation {
  if (bytes.byteLength === 0) return { ok: false, reason: "Arquivo vazio." };
  if (bytes.byteLength > maxBytes) {
    return { ok: false, reason: `O arquivo tem ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB; o limite é ${Math.round(maxBytes / 1024 / 1024)} MB.` };
  }
  // A especificação permite lixo antes do cabeçalho, mas só nos primeiros 1024 bytes.
  const head = Buffer.from(bytes.subarray(0, 1024)).toString("latin1");
  if (!head.includes("%PDF-")) return { ok: false, reason: "O arquivo não é um PDF válido (assinatura ausente)." };
  return { ok: true };
}

export function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export interface ExtractedResume {
  page_count: number | null;
  text_status: ResumeTextStatus;
  text_note: string | null;
  pages: ResumePage[];
  links: ResumeLink[];
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label}: tempo limite de ${ms / 1000}s excedido`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

interface LinkAnnotation {
  subtype?: string;
  url?: string;
  unsafeUrl?: string;
}

export async function extractResume(bytes: Uint8Array): Promise<ExtractedResume> {
  const { getDocumentProxy } = await import("unpdf");

  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    pdf = await withTimeout(
      getDocumentProxy(new Uint8Array(bytes), { stopAtErrors: false, maxImageSize: 1 }),
      PARSE_TIMEOUT_MS,
      "Abertura do PDF"
    );
  } catch (err) {
    const name = (err as { name?: string })?.name ?? "";
    const message = err instanceof Error ? err.message : String(err);
    if (name === "PasswordException" || /password/i.test(message)) {
      return { page_count: null, text_status: "protegido", text_note: "O PDF está protegido por senha. Remova a senha e envie novamente.", pages: [], links: [] };
    }
    if (/tempo limite/.test(message)) {
      return { page_count: null, text_status: "corrompido", text_note: message, pages: [], links: [] };
    }
    return { page_count: null, text_status: "corrompido", text_note: `Não foi possível abrir o PDF: ${message}`, pages: [], links: [] };
  }

  try {
    const pageCount = pdf.numPages;
    if (pageCount > MAX_PAGES) {
      return {
        page_count: pageCount,
        text_status: "paginas_excedidas",
        text_note: `O PDF tem ${pageCount} páginas; o limite é ${MAX_PAGES}. Currículos costumam ter até 3.`,
        pages: [],
        links: [],
      };
    }

    const pages: ResumePage[] = [];
    const links = new Map<string, ResumeLink>();
    let totalChars = 0;
    let emptyPages = 0;
    let truncated = false;

    const work = (async () => {
      for (let n = 1; n <= pageCount; n++) {
        const page = await pdf.getPage(n);
        const content = await page.getTextContent();
        let text = "";
        let lastY: number | null = null;
        for (const item of content.items as Array<{ str?: string; transform?: number[]; hasEOL?: boolean }>) {
          if (typeof item.str !== "string") continue;
          const y = item.transform?.[5] ?? null;
          // Quebra de linha quando a posição vertical muda: preserva a
          // estrutura de linhas que a análise de seções depende.
          if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) text += "\n";
          else if (text && !text.endsWith("\n") && !text.endsWith(" ")) text += " ";
          text += item.str;
          if (item.hasEOL) text += "\n";
          lastY = y;
        }
        text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
        if (text.length > MAX_CHARS_PER_PAGE) { text = text.slice(0, MAX_CHARS_PER_PAGE); truncated = true; }
        if (totalChars + text.length > MAX_TOTAL_CHARS) { text = text.slice(0, Math.max(0, MAX_TOTAL_CHARS - totalChars)); truncated = true; }
        totalChars += text.length;
        if (text.replace(/\s/g, "").length < 10) emptyPages += 1;
        pages.push({ page: n, text });

        for (const url of extractUrlsFromText(text)) {
          if (!links.has(url)) links.set(url, { url, page: n, origin: "texto" });
        }
        // Hyperlinks das anotações: é aqui que ficam os links "escondidos"
        // atrás de textos como "LinkedIn" ou de ícones.
        try {
          const annots = (await page.getAnnotations()) as LinkAnnotation[];
          for (const a of annots) {
            if (a.subtype !== "Link") continue;
            const raw = a.url ?? a.unsafeUrl;
            if (!raw) continue;
            const url = normalizeUrl(raw);
            if (url && !links.has(url)) links.set(url, { url, page: n, origin: "anotacao" });
          }
        } catch {
          /* anotações ilegíveis não invalidam o texto */
        }
        page.cleanup();
        if (truncated && totalChars >= MAX_TOTAL_CHARS) break;
      }
    })();

    await withTimeout(work, PARSE_TIMEOUT_MS, "Leitura do PDF");

    let text_status: ResumeTextStatus = "ok";
    let text_note: string | null = null;
    if (totalChars < MIN_TEXT_CHARS) {
      text_status = "ocr_pendente";
      text_note = "O PDF quase não tem texto selecionável — provavelmente é digitalizado. A leitura depende de OCR.";
    } else if (emptyPages > 0 || truncated) {
      text_status = "parcial";
      text_note = truncated
        ? "O texto foi truncado por exceder o limite de leitura."
        : `${emptyPages} página(s) sem texto selecionável — podem ser imagens.`;
    }

    return { page_count: pageCount, text_status, text_note, pages, links: [...links.values()] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { page_count: pdf.numPages ?? null, text_status: "corrompido", text_note: `Falha na leitura: ${message}`, pages: [], links: [] };
  } finally {
    await pdf.loadingTask.destroy().catch(() => {});
  }
}

export function resumeFullText(pages: ResumePage[]): string {
  return pages.map((p) => p.text).join("\n\n");
}
