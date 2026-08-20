import type { Lead, RawLead } from "@/types";

/**
 * Detecção de duplicidade: telefone, e-mail, domínio, Instagram
 * e nome + localização.
 */

function normPhone(p: string | null | undefined): string | null {
  if (!p) return null;
  const digits = p.replace(/\D/g, "");
  return digits.length >= 8 ? digits.slice(-9) : digits || null;
}

function normDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url.startsWith("http") ? url : `https://${url}`).hostname;
    return host.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function normHandle(h: string | null | undefined): string | null {
  if (!h) return null;
  return h.replace(/^@/, "").trim().toLowerCase() || null;
}

function normName(n: string): string {
  return n
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export interface DuplicateMatch {
  lead: Lead;
  reason: string;
}

export function findDuplicate(candidate: RawLead, existing: Lead[]): DuplicateMatch | null {
  const cPhones = [normPhone(candidate.phone), normPhone(candidate.whatsapp)].filter(Boolean);
  const cEmail = candidate.email?.toLowerCase() ?? null;
  const cDomain = normDomain(candidate.website);
  const cInsta = normHandle(candidate.instagram);
  const cName = normName(candidate.company_name);
  const cCity = candidate.city.toLowerCase();

  for (const lead of existing) {
    if (lead.archived) continue;

    const lPhones = [normPhone(lead.phone), normPhone(lead.whatsapp)].filter(Boolean);
    if (cPhones.length && lPhones.some((p) => cPhones.includes(p))) {
      return { lead, reason: "mesmo telefone" };
    }
    if (cEmail && lead.email && lead.email.toLowerCase() === cEmail) {
      return { lead, reason: "mesmo e-mail" };
    }
    if (cDomain && normDomain(lead.website) === cDomain) {
      return { lead, reason: "mesmo domínio" };
    }
    if (cInsta && normHandle(lead.instagram) === cInsta) {
      return { lead, reason: "mesmo Instagram" };
    }
    if (cName && normName(lead.company_name) === cName && lead.city.toLowerCase() === cCity) {
      return { lead, reason: "mesmo nome e localização" };
    }
  }
  return null;
}
