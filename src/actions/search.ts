"use server";

import { getDb } from "@/lib/store";
import { getCurrentUser } from "@/lib/auth";

export interface SearchResult {
  id: string;
  company: string;
  segment: string;
  city: string;
  score: number | null;
  match: string;
}

/** Busca global: empresa, contato, telefone, e-mail, Instagram, cidade */
export async function globalSearch(query: string): Promise<SearchResult[]> {
  await getCurrentUser();
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const db = getDb();
  return db.leads
    .filter((l) => !l.archived)
    .map((l) => {
      const fields: Array<[string, string | null]> = [
        ["empresa", l.company_name],
        ["contato", l.contact_name],
        ["telefone", l.phone],
        ["whatsapp", l.whatsapp],
        ["e-mail", l.email],
        ["instagram", l.instagram],
        ["cidade", l.city],
      ];
      const hit = fields.find(([, v]) => v?.toLowerCase().includes(q));
      if (!hit) return null;
      return {
        id: l.id,
        company: l.company_name,
        segment: l.segment,
        city: l.city,
        score: l.lead_score,
        match: hit[0] === "empresa" ? "" : `${hit[0]}: ${hit[1]}`,
      };
    })
    .filter((r): r is SearchResult => r !== null)
    .slice(0, 8);
}
