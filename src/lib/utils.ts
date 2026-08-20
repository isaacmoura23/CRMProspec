import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function uid(prefix = ""): string {
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  return prefix ? `${prefix}_${rand}` : rand;
}

/** Páginas institucionais/técnicas do Instagram que não são perfis */
const IG_NOT_PROFILES = new Set([
  "p", "reel", "reels", "tv", "stories", "explore", "accounts", "share",
  "about", "developer", "legal", "web", "direct", "embed", "embed.js",
  "static", "graphql", "api", "oauth", "invites", "challenge", "blog",
  "press", "privacy", "terms", "session", "emails", "business", "lite",
  "download", "directory", "linkinbio",
]);

/**
 * Normaliza um handle de Instagram vindo de qualquer fonte (com @, com
 * query string, com caminho colado…). Retorna null quando o valor não
 * parece um perfil válido — nesse caso a UI não deve renderizar o link.
 */
export function instagramHandle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let h = raw.trim();
  const fromUrl = /instagram\.com\/([^/?#\s]+)/i.exec(h);
  if (fromUrl) h = fromUrl[1]!;
  h = h.replace(/^@+/, "").split(/[/?#\s]/)[0]!.replace(/\.+$/, "");
  if (h.length < 2 || h.length > 30) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._]*$/.test(h) || h.includes("..")) return null;
  if (/\.(js|php|html?|css|png|jpe?g|gif|svg|webp)$/i.test(h)) return null;
  if (IG_NOT_PROFILES.has(h.toLowerCase())) return null;
  return h;
}

/** URL do perfil do Instagram, ou null se o handle não for válido */
export function instagramUrl(raw: string | null | undefined): string | null {
  const h = instagramHandle(raw);
  return h ? `https://www.instagram.com/${h}/` : null;
}
