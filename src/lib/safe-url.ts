import net from "node:net";

/**
 * Regras de URL/endereço para requisições que o servidor faz a partir de
 * conteúdo não confiável (links de currículo, anúncios de vaga).
 *
 * Puro (sem I/O) para ser testável: a resolução de DNS fica no cliente
 * HTTP (`services/career/safe-fetch.ts`), que chama `isBlockedAddress` em
 * cada IP resolvido e em cada redirecionamento.
 */

const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
  "instance-data",
]);

const BLOCKED_SUFFIXES = [".localhost", ".internal", ".local", ".lan", ".home", ".arpa"];

/** Erros devolvidos como texto para a interface explicar o bloqueio. */
export function validatePublicUrl(raw: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "URL inválida" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `Esquema não permitido (${url.protocol.replace(":", "")})` };
  }
  if (url.username || url.password) return { ok: false, reason: "URL com credenciais embutidas" };
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return { ok: false, reason: "URL sem host" };
  if (BLOCKED_HOSTS.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    return { ok: false, reason: "Endereço interno não permitido" };
  }
  const literal = host.startsWith("[") ? host.slice(1, -1) : host;
  if (net.isIP(literal) && isBlockedAddress(literal)) {
    return { ok: false, reason: "Endereço IP reservado não permitido" };
  }
  if (url.port && !["", "80", "443", "8080", "8443"].includes(url.port)) {
    return { ok: false, reason: `Porta ${url.port} não permitida` };
  }
  return { ok: true, url };
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return ((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!;
}

function inCidr(ip: number, base: string, bits: number): boolean {
  const b = ipv4ToInt(base)!;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ip & mask) >>> 0 === (b & mask) >>> 0;
}

const BLOCKED_V4: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local + metadados de nuvem
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reservado + broadcast
];

/**
 * IP privado, loopback, link-local, metadados de nuvem, multicast, reservado.
 * Cobre IPv4, IPv6 e IPv4 mapeado em IPv6 (::ffff:10.0.0.1).
 */
export function isBlockedAddress(address: string): boolean {
  const ip = address.trim().toLowerCase();
  if (net.isIPv4(ip)) {
    const n = ipv4ToInt(ip);
    if (n === null) return true;
    return BLOCKED_V4.some(([base, bits]) => inCidr(n, base, bits));
  }
  if (net.isIPv6(ip)) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
    if (mapped) return isBlockedAddress(mapped[1]!);
    if (ip === "::" || ip === "::1") return true;
    if (ip.startsWith("fe80:") || ip.startsWith("fe9") || ip.startsWith("fea") || ip.startsWith("feb")) return true; // link-local
    if (ip.startsWith("fc") || ip.startsWith("fd")) return true; // ULA
    if (ip.startsWith("ff")) return true; // multicast
    if (ip.startsWith("2001:db8:")) return true; // documentação
    if (ip.startsWith("64:ff9b:")) return true; // NAT64 — pode mapear IPv4 privado
    return false;
  }
  return true; // não é IP: quem chama deveria ter resolvido antes
}

/** Normaliza para comparação/dedupe: sem fragmento, sem utm, host minúsculo, sem barra final. */
export function canonicalUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref$|source$|trk$)/i.test(key)) u.searchParams.delete(key);
    }
    let s = u.toString();
    if (s.endsWith("/") && u.pathname === "/") s = s.slice(0, -1);
    return s;
  } catch {
    return raw.trim();
  }
}
