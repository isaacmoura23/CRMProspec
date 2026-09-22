/**
 * Regras de rota da autenticação — puras, para serem testadas sem servidor.
 */

/** Rotas alcançáveis sem sessão. O worker e o webhook têm autenticação própria. */
export const PUBLIC_PATHS = ["/login", "/auth", "/api/webhooks", "/api/career/worker"];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Destino pós-login vindo da URL.
 *
 * Só caminho interno: um destino absoluto (`https://…`) ou protocolo-relativo
 * (`//host`) viraria redirect aberto — o golpe clássico é mandar a vítima de
 * volta para um domínio parecido logo depois do login.
 */
export function safeNextPath(raw: string | null | undefined, fallback = "/dashboard"): string {
  if (!raw) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return fallback;
  if (raw.includes("\\") || /[\r\n]/.test(raw)) return fallback;
  return raw;
}
