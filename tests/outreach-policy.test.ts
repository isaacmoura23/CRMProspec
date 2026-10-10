import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  OPT_OUT_FOOTER,
  checkMessage,
  dailyCap,
  gapSeconds,
  isBrazilianMobile,
  isStaleCycle,
  isWithinWindow,
  localParts,
  nextWindowOpen,
  normalizeBrazilianPhone,
  phoneKey,
  touchDelayDays,
  withOptOutFooter,
  type SendWindow,
} from "@/lib/outreach-policy";
import { contactablePhone, leadEligibility, leadForMessage, type EligibilityInput } from "@/lib/outreach-eligibility";
import { normalizeSellerConfig, SELLER_DEFAULTS } from "@/agents/config";
import type { Lead } from "@/types";
import type { Approval, OutreachCycle } from "@/types/agents";

/**
 * 12/10/2026 é uma segunda-feira. São Paulo está em UTC-3 (sem horário de verão):
 * 12:00Z = 09:00 em São Paulo.
 */
const WINDOW: SendWindow = { days: [1, 2, 3, 4, 5], startHour: 9, endHour: 18 };
const at = (iso: string) => new Date(iso);

describe("janela de envio (fuso de São Paulo)", () => {
  it("lê dia, hora e dia da semana no fuso, não em UTC", () => {
    const p = localParts(at("2026-10-12T02:30:00Z")); // domingo 23:30 em São Paulo
    assert.deepEqual(p, { weekday: 7, hour: 23, minute: 30, day: "2026-10-11" });
  });

  it("abre às 9h e fecha às 18h (o fim é exclusivo), só em dia útil", () => {
    assert.equal(isWithinWindow(at("2026-10-12T11:59:00Z"), WINDOW), false, "08:59");
    assert.equal(isWithinWindow(at("2026-10-12T12:00:00Z"), WINDOW), true, "09:00");
    assert.equal(isWithinWindow(at("2026-10-12T20:59:00Z"), WINDOW), true, "17:59");
    assert.equal(isWithinWindow(at("2026-10-12T21:00:00Z"), WINDOW), false, "18:00");
    assert.equal(isWithinWindow(at("2026-10-10T15:00:00Z"), WINDOW), false, "sábado");
    assert.equal(isWithinWindow(at("2026-10-11T15:00:00Z"), WINDOW), false, "domingo");
  });

  it("calcula a próxima abertura: sexta à noite vale segunda de manhã; dentro da janela vale agora", () => {
    const friNight = at("2026-10-09T22:00:00Z"); // sexta 19:00
    assert.equal(nextWindowOpen(friNight, WINDOW)?.toISOString(), "2026-10-12T12:00:00.000Z");
    const inside = at("2026-10-13T15:07:00Z");
    assert.equal(nextWindowOpen(inside, WINDOW)?.toISOString(), inside.toISOString());
    assert.equal(nextWindowOpen(inside, { ...WINDOW, days: [] }), null, "sem dias não há janela");
    assert.equal(nextWindowOpen(inside, { ...WINDOW, startHour: 18, endHour: 9 }), null);
  });
});

describe("teto diário com aquecimento", () => {
  it("sobe por semana de uso até o máximo do dono e nunca passa dele", () => {
    assert.equal(dailyCap(null, 40, true), 10, "número que nunca enviou");
    assert.equal(dailyCap(0, 40, true), 10);
    assert.equal(dailyCap(6.9, 40, true), 10);
    assert.equal(dailyCap(7, 40, true), 20);
    assert.equal(dailyCap(14, 40, true), 30);
    assert.equal(dailyCap(21, 40, true), 40, "depois do aquecimento vale o máximo");
    assert.equal(dailyCap(400, 40, true), 40);
    assert.equal(dailyCap(0, 5, true), 5, "o máximo do dono vale mesmo abaixo do degrau");
    assert.equal(dailyCap(0, 40, false), 40, "sem aquecimento começa no máximo");
  });
});

describe("intervalo entre envios", () => {
  it("fica dentro do intervalo, é estável para a mesma semente e varia entre sementes", () => {
    const values = new Set<number>();
    for (let i = 0; i < 50; i++) {
      const g = gapSeconds(`msg-${i}`, 60, 180);
      assert.ok(g >= 60 && g <= 180, `fora do intervalo: ${g}`);
      values.add(g);
    }
    assert.ok(values.size > 20, "intervalos irregulares, não fixos");
    assert.equal(gapSeconds("abc", 60, 180), gapSeconds("abc", 60, 180));
    assert.equal(gapSeconds("qualquer", 90, 90), 90);
    assert.equal(gapSeconds("qualquer", 180, 60) >= 60, true, "min e max invertidos não quebram");
  });
});

describe("toques e etapa obsoleta", () => {
  it("espera depois de cada toque conforme a configuração e repete o último valor", () => {
    assert.equal(touchDelayDays(1, [3, 4]), 3);
    assert.equal(touchDelayDays(2, [3, 4]), 4);
    assert.equal(touchDelayDays(3, [3, 4]), 4);
    assert.equal(touchDelayDays(1, []), 3);
  });

  it("etapa de ontem é obsoleta; a de hoje não, mesmo horas antes", () => {
    const now = at("2026-10-13T15:00:00Z"); // terça 12:00
    assert.equal(isStaleCycle(at("2026-10-12T20:00:00Z"), now), true);
    assert.equal(isStaleCycle(at("2026-10-13T12:00:00Z"), now), false);
    // virada do dia em São Paulo, não em UTC: 02:00Z de terça ainda é segunda à noite
    assert.equal(isStaleCycle(at("2026-10-13T02:00:00Z"), now), true);
  });
});

describe("telefone", () => {
  it("normaliza os formatos brasileiros e recusa o que não é número plausível", () => {
    for (const raw of ["(41) 99999-8888", "041 99999 8888", "+55 41 99999-8888", "5541999998888", "0055 41 99999-8888", "41999998888"]) {
      assert.equal(normalizeBrazilianPhone(raw), "+5541999998888", raw);
    }
    assert.equal(normalizeBrazilianPhone("(41) 3333-4444"), "+554133334444");
    for (const bad of [null, undefined, "", "abc", "12345", "+351 912 345 678", "+55 04 99999-8888", "999998888"]) {
      assert.equal(normalizeBrazilianPhone(bad as string), null, String(bad));
    }
  });

  it("só celular (começa em 9) segue; fixo nem gasta uma consulta", () => {
    assert.equal(isBrazilianMobile("+5541999998888"), true);
    assert.equal(isBrazilianMobile("+554133334444"), false);
    assert.equal(contactablePhone({ whatsapp: null, phone: "(41) 3333-4444" }), null);
    assert.equal(contactablePhone({ whatsapp: "+55 41 99999-8888", phone: "(41) 3333-4444" }), "+5541999998888", "prefere o WhatsApp publicado");
    assert.equal(contactablePhone({ whatsapp: null, phone: "(41) 99999-8888" }), "+5541999998888");
  });

  it("a mesma pessoa em formatos diferentes tem uma chave só", () => {
    assert.equal(phoneKey("+55 (41) 99999-8888"), "5541999998888");
  });
});

describe("texto da mensagem", () => {
  const ok = "Oi, tudo bem? Vi o trabalho de vocês e percebi uma coisa que posso ajudar. Quer que eu te explique rapidinho?";

  it("aceita um texto normal e acrescenta o aviso de saída uma única vez", () => {
    assert.equal(checkMessage(ok), null);
    const once = withOptOutFooter(ok);
    assert.ok(once.endsWith(OPT_OUT_FOOTER));
    assert.equal(withOptOutFooter(once), once, "idempotente");
    assert.equal(checkMessage(once), null);
  });

  it("recusa o inequívoco: link, promessa, maiúsculas, variável solta, curto e longo demais", () => {
    assert.match(checkMessage(`${ok} Veja https://exemplo.com.br`) ?? "", /link/);
    assert.match(checkMessage(`${ok} Veja www.exemplo.com`) ?? "", /link/);
    assert.match(checkMessage(`${ok} Veja exemplo.com.br`) ?? "", /link/);
    assert.match(checkMessage(`${ok} Resultado garantido em 30 dias.`) ?? "", /Promessa/);
    assert.match(checkMessage(`${ok} Você vai ter 100% de retorno`) ?? "", /Promessa/);
    assert.match(checkMessage("OLÁ, PERCEBI QUE VOCÊS NÃO TÊM SITE E POSSO AJUDAR AGORA MESMO COM UMA PROPOSTA") ?? "", /maiúsculas/);
    assert.match(checkMessage(`Oi {{nome}}, ${ok}`) ?? "", /variável/);
    assert.match(checkMessage("Oi!") ?? "", /curta/);
    assert.match(checkMessage(ok.repeat(12)) ?? "", /longa/);
  });
});

/* ------------------------------------------------------------------ */

function lead(over: Partial<Lead> = {}): Lead {
  return {
    id: "lead_1",
    organization_id: "org",
    company_name: "Imobiliária Horizonte",
    contact_name: null,
    legal_name: null,
    segment: "Imobiliária",
    description: null,
    phone: "(41) 99999-8888",
    whatsapp: null,
    email: null,
    website: null,
    instagram: null,
    facebook: null,
    linkedin: null,
    google_maps_url: null,
    country: "Brasil",
    state: "PR",
    city: "Curitiba",
    address: null,
    reviews_count: 10,
    rating: 4.5,
    opening_hours: null,
    source: "google_places",
    source_id: "p1",
    campaign_id: "cmp_agent",
    has_website: false,
    website_quality: "nenhum",
    has_whatsapp: false,
    instagram_active: false,
    marketing_signals: false,
    business_active: true,
    catalog_size: "desconhecido",
    status: "qualificado",
    pipeline_stage_id: null,
    stage_entered_at: null,
    lead_score: 80,
    temperature: "quente",
    potential_value: null,
    assigned_to: null,
    archived: false,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    last_contact_at: null,
    next_follow_up_at: null,
    ...over,
  };
}

const cycle = (over: Partial<OutreachCycle> = {}): OutreachCycle => ({
  id: "c1",
  organization_id: "org",
  lead_id: "lead_1",
  kind: "abordagem",
  touch: 1,
  phone: "+5541999998888",
  body: "x",
  status: "enviado",
  scheduled_for: "2026-10-01T00:00:00.000Z",
  not_before: "2026-10-01T00:00:00.000Z",
  claimed_at: null,
  attempts: 0,
  idempotency_key: "c1",
  approval_id: null,
  skip_reason: null,
  last_error: null,
  message_id: null,
  created_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-01T00:00:00.000Z",
  sent_at: "2026-10-01T00:00:00.000Z",
  ...over,
});

const approval = (touch: number, status: Approval["status"]): Approval => ({
  id: "a1",
  organization_id: "org",
  agent: "seller",
  kind: "outreach_message",
  title: "t",
  detail: null,
  payload: { lead_id: "lead_1", touch },
  dedupe_key: null,
  status,
  decided_by: null,
  decided_at: null,
  task_id: null,
  created_at: "2026-10-01T00:00:00.000Z",
  expires_at: "2026-10-04T00:00:00.000Z",
});

function input(over: Partial<EligibilityInput> = {}): EligibilityInput {
  return {
    lead: lead(),
    touch: 1,
    cfg: SELLER_DEFAULTS,
    blocked: new Set(),
    cycles: [],
    approvals: [],
    agentCampaignIds: new Set(["cmp_agent"]),
    ...over,
  };
}

describe("quem pode ser abordado", () => {
  it("um lead qualificado, de agente, com celular e sem histórico pode", () => {
    assert.equal(leadEligibility(input()), null);
  });

  it("recusa por estado: só quem ainda não foi tocado recebe a primeira abordagem", () => {
    for (const status of ["contatado", "respondeu", "interessado", "reuniao", "fechado", "perdido"] as const) {
      assert.match(leadEligibility(input({ lead: lead({ status }) })) ?? "", /não recebe primeira abordagem/, status);
    }
    for (const status of ["novo", "analisado", "qualificado", "pronto_contato"] as const) {
      assert.equal(leadEligibility(input({ lead: lead({ status }) })), null, status);
    }
    assert.match(leadEligibility(input({ lead: lead({ archived: true }) })) ?? "", /arquivado/);
  });

  it("recusa score baixo, lead que não é de agente (quando restrito), telefone fixo e número bloqueado", () => {
    assert.match(leadEligibility(input({ lead: lead({ lead_score: 49 }) })) ?? "", /score/);
    assert.match(leadEligibility(input({ lead: lead({ campaign_id: "outra" }) })) ?? "", /agentes/);
    assert.equal(leadEligibility(input({ lead: lead({ campaign_id: "outra" }), cfg: { ...SELLER_DEFAULTS, only_agent_leads: false } })), null);
    assert.match(leadEligibility(input({ lead: lead({ phone: "(41) 3333-4444" }) })) ?? "", /celular/);
    assert.match(leadEligibility(input({ blocked: new Set(["5541999998888"]) })) ?? "", /bloqueio/);
  });

  it("nunca duas abordagens ao mesmo tempo, nem sobre um envio incerto, nem o mesmo toque duas vezes", () => {
    assert.match(leadEligibility(input({ cycles: [cycle({ status: "agendado" })] })) ?? "", /em andamento/);
    assert.match(leadEligibility(input({ cycles: [cycle({ status: "reivindicado" })] })) ?? "", /em andamento/);
    assert.match(leadEligibility(input({ cycles: [cycle({ status: "incerto" })] })) ?? "", /conferência/);
    assert.match(leadEligibility(input({ cycles: [cycle({ status: "enviado" })] })) ?? "", /já foi enviado/);
    assert.equal(leadEligibility(input({ cycles: [cycle({ status: "pulado" }), cycle({ id: "c2", status: "falhou" })] })), null, "o que não saiu não bloqueia");
  });

  it("acompanhamento só depois do toque anterior enviado e com o lead em silêncio (contatado), até 3 toques", () => {
    const contacted = lead({ status: "contatado" });
    assert.equal(leadEligibility(input({ lead: contacted, touch: 2, cycles: [cycle()] })), null);
    assert.match(leadEligibility(input({ lead: contacted, touch: 2 })) ?? "", /anterior/);
    assert.match(leadEligibility(input({ lead: contacted, touch: 2, cycles: [cycle({ status: "falhou" })] })) ?? "", /anterior/);
    assert.match(leadEligibility(input({ lead: lead({ status: "respondeu" }), touch: 2, cycles: [cycle()] })) ?? "", /não recebe/);
    assert.equal(leadEligibility(input({ lead: contacted, touch: 3, cycles: [cycle(), cycle({ id: "c2", touch: 2 })] })), null);
    assert.match(leadEligibility(input({ lead: contacted, touch: 4, cycles: [cycle(), cycle({ id: "c2", touch: 2 }), cycle({ id: "c3", touch: 3 })] })) ?? "", /limite/);
    assert.match(leadEligibility(input({ lead: contacted, touch: 3, cfg: { ...SELLER_DEFAULTS, max_touches: 2 }, cycles: [cycle(), cycle({ id: "c2", touch: 2 })] })) ?? "", /limite/);
  });

  it("pedido pendente, aprovado ou recusado impede repetir o toque; o expirado libera", () => {
    for (const status of ["pendente", "aprovado", "recusado"] as const) {
      assert.match(leadEligibility(input({ approvals: [approval(1, status)] })) ?? "", /aprovação/, status);
    }
    assert.equal(leadEligibility(input({ approvals: [approval(1, "expirado")] })), null);
    assert.equal(leadEligibility(input({ approvals: [approval(2, "pendente")] })), null, "outro toque não interfere");
  });
});

describe("nome do contato nunca é inventado", () => {
  it("leads de fontes que já receberam nome aleatório perdem o nome; os cadastrados por gente o mantêm", () => {
    for (const source of ["google_places", "diretorio", "demo"] as const) {
      assert.equal(leadForMessage(lead({ source, contact_name: "Carlos" })).contact_name, null, source);
    }
    for (const source of ["manual", "csv", "webhook"] as const) {
      assert.equal(leadForMessage(lead({ source, contact_name: "Carlos" })).contact_name, "Carlos", source);
    }
  });
});

describe("configuração do Vendedor", () => {
  it("limita cada valor e nunca deixa a janela vazia ou o intervalo invertido", () => {
    const c = normalizeSellerConfig({ send_days: [0, 1, 1, 9, "3"], start_hour: 20, end_hour: 8, min_gap_seconds: 500, max_gap_seconds: 20, touch_spacing_days: [0, 99, 5], max_touches: 9, daily_cap_max: 9999 });
    assert.deepEqual(c.send_days, [1, 3]);
    assert.ok(c.end_hour > c.start_hour, "o fim vem depois do início");
    assert.ok(c.max_gap_seconds >= c.min_gap_seconds);
    assert.deepEqual(c.touch_spacing_days, [1, 30]);
    assert.equal(c.max_touches, 3);
    assert.equal(c.daily_cap_max, 200);
    assert.deepEqual(normalizeSellerConfig(null), SELLER_DEFAULTS);
    assert.equal(normalizeSellerConfig({ warmup: false }).warmup, false);
    assert.equal(normalizeSellerConfig({ only_agent_leads: false }).only_agent_leads, false);
  });
});
