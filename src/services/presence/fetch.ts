import "server-only";
import { safeFetch } from "@/services/career/safe-fetch";
import type { PageFetcher, PageResult } from "@/services/presence/gather";

/**
 * Leitura de páginas públicas para o dossiê.
 *
 * Usa o cliente anti-SSRF (o endereço do site vem de dados que não controlamos,
 * como o cadastro do Google Maps ou o link de um site): resolve o DNS, confere
 * cada IP contra faixas reservadas, fixa a conexão no IP validado e revalida
 * cada redirecionamento. Identifica-se como navegador comum só porque muitos
 * sites recusam clientes sem User-Agent; não há login, cookie nem desafio
 * anti-robô contornado: se o site barrar, a fonte é "bloqueada".
 */

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
  "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.6",
};

export const publicPageFetcher: PageFetcher = async (url): Promise<PageResult> => {
  const res = await safeFetch(url, { headers: BROWSER_HEADERS, maxBytes: 600_000, timeoutMs: 10_000, maxRedirects: 4 });
  const html = !res.contentType || res.contentType.includes("html") || res.contentType.includes("xml");
  return {
    ok: res.ok && html,
    status: res.status,
    finalUrl: res.finalUrl,
    contentType: res.contentType,
    // Conteúdo que não é página (PDF, imagem) não é lido.
    body: html ? res.body : "",
    truncated: res.truncated,
    error: res.ok && !html ? "o endereço não é uma página web" : res.error,
  };
};
