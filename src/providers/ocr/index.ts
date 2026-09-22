import "server-only";

/**
 * OCR para currículos digitalizados.
 *
 * Provedor: OCR.space (API REST documentada em https://ocr.space/ocrapi).
 * Configurado por `OCR_SPACE_API_KEY`. Sem a chave, o status do currículo
 * fica em `ocr_indisponivel` e a interface explica o que falta — nunca
 * finge que leu o documento.
 *
 * Limites do plano gratuito do provedor (documentados): 1 MB por arquivo e
 * 3 páginas por PDF. O worker respeita esses limites antes de chamar.
 */

export interface OcrProvider {
  id: string;
  name: string;
  isConfigured(): boolean;
  maxBytes: number;
  maxPages: number;
  /** Texto por página, na ordem. Lança em falha. */
  recognizePdf(bytes: Uint8Array, language: "por" | "eng"): Promise<string[]>;
}

const OCR_TIMEOUT_MS = 60_000;

interface OcrSpaceResponse {
  ParsedResults?: Array<{ ParsedText?: string; FileParseExitCode?: number; ErrorMessage?: string }>;
  OCRExitCode?: number;
  IsErroredOnProcessing?: boolean;
  ErrorMessage?: string | string[];
}

class OcrSpaceProvider implements OcrProvider {
  id = "ocr_space";
  name = "OCR.space";
  maxBytes = 1024 * 1024;
  maxPages = 3;

  isConfigured() {
    return Boolean(process.env.OCR_SPACE_API_KEY);
  }

  async recognizePdf(bytes: Uint8Array, language: "por" | "eng"): Promise<string[]> {
    const key = process.env.OCR_SPACE_API_KEY;
    if (!key) throw new Error("OCR não configurado");
    if (bytes.byteLength > this.maxBytes) {
      throw new Error(`O provedor de OCR aceita arquivos de até ${Math.round(this.maxBytes / 1024)} KB.`);
    }
    const form = new FormData();
    form.append("file", new Blob([bytes as BlobPart], { type: "application/pdf" }), "curriculo.pdf");
    form.append("language", language);
    form.append("filetype", "PDF");
    form.append("isOverlayRequired", "false");
    form.append("OCREngine", "2");
    form.append("scale", "true");

    const res = await fetch("https://api.ocr.space/parse/image", {
      method: "POST",
      headers: { apikey: key },
      body: form,
      signal: AbortSignal.timeout(OCR_TIMEOUT_MS),
    });
    if (res.status === 429) throw new Error("OCR: limite de requisições atingido (429)");
    if (!res.ok) throw new Error(`OCR respondeu ${res.status}`);
    const data = (await res.json()) as OcrSpaceResponse;
    if (data.IsErroredOnProcessing) {
      const msg = Array.isArray(data.ErrorMessage) ? data.ErrorMessage.join("; ") : data.ErrorMessage;
      throw new Error(`OCR falhou: ${msg ?? "erro desconhecido"}`);
    }
    return (data.ParsedResults ?? []).map((r) => (r.ParsedText ?? "").trim());
  }
}

export function getOcrProvider(): OcrProvider {
  return new OcrSpaceProvider();
}
