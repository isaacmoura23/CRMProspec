/**
 * Regras de rota da autenticação — puras, para serem testadas sem servidor.
 */

/** Rotas alcançáveis sem sessão. O worker e o webhook têm autenticação própria. */
export const PUBLIC_PATHS = ["/login", "/auth", "/api/webhooks", "/api/career/worker", "/previa", "/midia"];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Destino pós-login vindo da URL.
 *
 * Só caminho interno: um destino absoluto (`https://…`) ou protocolo-relativo
 * (`//host`) viraria redirect aberto — o golpe clássico é mandar a vítima de
 * volta para um domínio parecido logo depois do login.
 *
 * Conferir prefixos não basta: o parser de URL **descarta** tabulação, quebra
 * de linha e outros controles antes de interpretar o endereço, então
 * `"/\t/evil.com"` passava pelas checagens de prefixo e `new URL()` resolvia
 * para `//evil.com` — outro domínio. Por isso a decisão final é tomada depois
 * de resolver contra uma base conhecida: se a origem mudou, o destino não é
 * interno, qualquer que seja o truque.
 */
export function safeNextPath(raw: string | null | undefined, fallback = "/dashboard"): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return fallback;
  // Controles, espaço e barra invertida: ou somem no parser, ou viram barra.
  if (/[\u0000- \u007F\\]/.test(raw)) return fallback;

  const base = "https://local.invalid";
  try {
    const url = new URL(raw, base);
    if (url.origin !== base) return fallback;
    return `${url.pathname}${url.search}`;
  } catch {
    return fallback;
  }
}
