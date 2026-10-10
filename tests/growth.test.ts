import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getDb } from "@/lib/store";
import { registerAgentHandlers } from "@/agents/registry";
import { AGENT_TOOLS, HUMAN_ONLY_TOOLS, agentHasTool } from "@/agents/tools";
import { socialMedia, templateCaption, topicsFrom } from "@/agents/social/agent";
import { trafficManager } from "@/agents/traffic/agent";
import { CAMPAIGN_TRANSITIONS, canMoveCampaign, checkCampaign, evaluateSpendCaps, increasesSpend, remainingDaysInMonth, type CampaignDraft } from "@/lib/ads-policy";
import { POST_TRANSITIONS, canMovePost, checkCaption, checkImageUrl, publishable, withHashtags } from "@/lib/social-policy";
import { formatBrl } from "@/lib/money";
import { decideApproval } from "@/services/agents/approvals";
import { enqueueAgentTask, runAgentQueue } from "@/services/agents/queue";
import { agentRepo, getAgentData, resetAgentRepoForTests } from "@/services/agents/repository";
import { saveSettings } from "@/services/agents/settings";
import { activateCampaign, applyBudgetChange, approveCampaignDraft, pauseCampaign, proposeBudgetChange, proposeCampaign, recordReport, setCampaignBudget, spendSummary } from "@/services/ads/campaigns";
import { InstagramError, createInstagramReader, instagramConfig } from "@/services/social/instagram";
import { createInstagramPublisher, type InstagramPublisher } from "@/services/social/instagram-publisher";
import { approveAndPublish, editPost, expireStalePosts, markNotPublished, proposePost, reconcileStuckPublishing, reconcileUncertainPost, reopenFailedPost } from "@/services/social/posts";
import { emptyAgentData, type AdCampaign } from "@/types/agents";
import { installCreativeFakes } from "./creative-fakes";

const NOW = new Date("2026-10-12T15:00:00Z");
const TODAY = "2026-10-12";
const CAPTION = "Limpeza de pele: como a Clínica Aurora faz na prática.\n\nProcedimentos faciais e corporais com avaliação individual.\n\nQuer saber mais? Chama a gente no direct.";
const IMG = "https://cdn.exemplo.com.br/aurora/limpeza.jpg";

function reset() {
  resetAgentRepoForTests();
  Object.assign(getAgentData(), emptyAgentData());
  const db = getDb();
  db.notifications.splice(0);
}

const original = { ...getDb().company_profile };
function setProfile(over: Partial<typeof original> = {}) {
  Object.assign(getDb().company_profile, {
    company_name: "Clínica Aurora",
    what_we_sell: "Clínica de estética com procedimentos faciais e corporais.",
    main_services: ["Limpeza de pele", "Depilação a laser"],
    differentiators: ["Atendimento com avaliação individual"],
    problems_we_solve: ["Pele sem viço no dia a dia"],
    target_customers: "Mulheres de 25 a 50 anos em Curitiba",
    communication_style: "próximo e profissional",
    never_say: [],
    ...over,
  });
}

let undoFakes: () => void;
beforeEach(() => {
  registerAgentHandlers();
  reset();
  setProfile();
  // Navegador e ffmpeg simulados: os agentes geram a arte junto da proposta, e nenhum teste abre o Chrome de verdade.
  undoFakes = installCreativeFakes();
});
afterEach(() => {
  undoFakes();
  Object.assign(getDb().company_profile, original);
  delete process.env.INSTAGRAM_ACCESS_TOKEN;
  delete process.env.INSTAGRAM_BUSINESS_ID;
});

const draft = (over: Partial<CampaignDraft> = {}): CampaignDraft & { objective: AdCampaign["objective"] } => ({
  name: "Limpeza de pele — mensagens",
  headline: "Limpeza de pele",
  body: "Clínica de estética com procedimentos faciais e corporais, com avaliação individual.",
  cta: "Fale conosco pelo WhatsApp",
  audience: "Mulheres de 25 a 50 anos em Curitiba",
  daily_budget_cents: 1_000,
  start_date: "2026-10-13",
  end_date: null,
  landing_url: null,
  objective: "mensagens",
  ...over,
});

/* ------------------------------------------------------------------ */

describe("a regra central: o que os agentes NÃO podem tocar", () => {
  const AGENTS_DIR = path.join(process.env.CRM_ROOT ?? process.cwd(), "src", "agents");
  const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []));

  it("nenhuma ferramenta só-humana está na lista de nenhum agente", () => {
    assert.ok(HUMAN_ONLY_TOOLS.includes("instagram.publish_media"));
    for (const [agent, tools] of Object.entries(AGENT_TOOLS)) {
      for (const human of HUMAN_ONLY_TOOLS) assert.ok(!tools.includes(human), `${agent} recebeu ${human}`);
    }
    assert.equal(agentHasTool("social-media", "instagram.publish_media"), false);
    assert.equal(agentHasTool("social-media", "instagram.list_media"), true);
    assert.equal(agentHasTool("traffic-manager", "ads.activate_campaign"), false);
  });

  it("o código dos agentes não importa nem cita publicar, ativar, pausar nem mexer em orçamento", () => {
    const forbidden = /instagram-publisher|publish_media|schedule_media|publishMedia|publishImage|approveAndPublish|approveAndSchedule|publishDueScheduled|runSocialMaintenance|cancelSchedule|approveCreative|approveCampaignCreative|activateCampaign|pauseCampaign|setCampaignBudget|endCampaign|approveCampaignDraft|applyBudgetChange|claimStatus/;
    const offenders: string[] = [];
    for (const file of files(AGENTS_DIR)) {
      if (file.endsWith("tools.ts")) continue; // a própria lista cita os nomes para proibi-los
      if (forbidden.test(fs.readFileSync(file, "utf-8"))) offenders.push(path.relative(AGENTS_DIR, file));
    }
    assert.deepEqual(offenders, []);
  });

  it("a ferramenta de publicar mora num arquivo à parte, que só o serviço da ação do botão importa", () => {
    const root = path.join(process.env.CRM_ROOT ?? process.cwd(), "src");
    const importers = files(root).filter((f) => /from "@\/services\/social\/instagram-publisher"/.test(fs.readFileSync(f, "utf-8"))).map((f) => path.relative(root, f).replace(/\\/g, "/"));
    assert.deepEqual(importers, ["services/social/posts.ts"]);
    const readerSource = fs.readFileSync(path.join(root, "services", "social", "instagram.ts"), "utf-8");
    assert.doesNotMatch(readerSource, /media_publish|publishMedia|publishImage/, "o arquivo de leitura não sabe publicar");
  });
});

describe("rodando os agentes: eles só propõem (prova em tempo de execução)", () => {
  it("em modo automático, com o Instagram configurado e campanha aprovada, nada é publicado nem ativado", async () => {
    process.env.INSTAGRAM_ACCESS_TOKEN = "token-de-teste-longo";
    process.env.INSTAGRAM_BUSINESS_ID = "17841400000000";
    await saveSettings("social-media", { mode: "automatico" });
    await saveSettings("traffic-manager", { mode: "automatico" });

    const posts: Array<{ method: string; url: string }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
      posts.push({ method: init?.method ?? "GET", url: String(url) });
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;
    try {
      await enqueueAgentTask({ agent: "social-media", kind: "social.propose", dedupeKey: "t:s" });
      await enqueueAgentTask({ agent: "traffic-manager", kind: "ads.propose", dedupeKey: "t:a" });
      await runAgentQueue({ agents: ["social-media", "traffic-manager"], budgetMs: 15_000 });
    } finally {
      globalThis.fetch = realFetch;
    }

    const tasks = await agentRepo().list("tasks");
    assert.ok(tasks.every((t) => t.status === "concluido"), JSON.stringify(tasks.map((t) => [t.kind, t.status, t.last_error])));
    assert.equal(posts.filter((p) => p.method !== "GET").length, 0, "nenhuma chamada de escrita ao Instagram");
    assert.ok(!posts.some((p) => /media_publish|\/media(\?|$)/.test(p.url) && p.method === "POST"));
    const [post] = getAgentData().social_posts;
    assert.equal(post!.status, "pendente");
    const [campaign] = getAgentData().ad_campaigns;
    assert.equal(campaign!.status, "pendente");
    assert.equal(getAgentData().ad_campaigns.filter((c) => c.status === "ativa").length, 0);
    assert.equal(getAgentData().approvals.filter((a) => a.status === "pendente").length, 2, "dois pedidos esperando o clique");
  });

  it("aprovar um post pela fila genérica de aprovação NÃO publica: manda usar 'Aprovar e publicar'", async () => {
    const post = await proposePost({ topic: "Limpeza de pele", caption: CAPTION, imageIdea: "foto", imageUrl: IMG });
    const r = await decideApproval(post.approval_id!, true, "user_owner");
    assert.equal(r.ok, false);
    assert.equal((await agentRepo().get("social_posts", post.id))!.status, "pendente");
  });

  it("recusar na fila genérica encerra a coisa por trás (post recusado, campanha recusada)", async () => {
    const post = await proposePost({ topic: "Limpeza de pele", caption: CAPTION, imageIdea: "foto" });
    const camp = await proposeCampaign(draft(), NOW);
    assert.equal((await decideApproval(post.approval_id!, false, "u")).ok, true);
    assert.equal((await decideApproval(camp.approval_id!, false, "u")).ok, true);
    assert.equal((await agentRepo().get("social_posts", post.id))!.status, "recusado");
    assert.equal((await agentRepo().get("ad_campaigns", camp.id))!.status, "recusada");
  });
});

describe("Instagram: regras da legenda e do estado", () => {
  it("a máquina de estados só deixa chegar a 'publicando' a partir de 'aprovado' ou 'agendado' (que só um clique produz)", () => {
    for (const [from, tos] of Object.entries(POST_TRANSITIONS)) {
      if (tos.includes("publicando")) assert.ok(from === "aprovado" || from === "agendado", from);
    }
    // agendado só se alcança de pendente (o clique de "Aprovar e agendar"); nada o alcança por conta própria
    for (const [from, tos] of Object.entries(POST_TRANSITIONS)) {
      if (tos.includes("agendado")) assert.equal(from, "pendente");
    }
    assert.ok(!canMovePost("pendente", "publicando"));
    assert.ok(!canMovePost("rascunho", "agendado"));
    assert.ok(!canMovePost("falhou", "agendado"));
    assert.ok(canMovePost("agendado", "pendente"), "cancelar o agendamento");
    assert.ok(!canMovePost("publicado", "pendente"));
    assert.ok(!canMovePost("recusado", "aprovado"));
    assert.ok(canMovePost("falhou", "pendente"));
    assert.equal(POST_TRANSITIONS.publicado.length + POST_TRANSITIONS.recusado.length + POST_TRANSITIONS.expirado.length, 0);
  });

  it("legenda: tamanho, link, promessa, variável solta, hashtags demais, frase proibida e spam", () => {
    assert.equal(checkCaption(CAPTION), null);
    assert.ok(checkCaption("curta"));
    assert.ok(checkCaption("x".repeat(2300)));
    assert.ok(checkCaption("Veja em https://exemplo.com.br tudo o que preparamos para você hoje"));
    assert.ok(checkCaption("Resultado garantido em sete dias para todo mundo que vier aqui"));
    assert.ok(checkCaption("Olá {{nome}}, venha conhecer o nosso trabalho de perto hoje"));
    assert.ok(checkCaption("Venha conhecer " + Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(" ")));
    assert.match(checkCaption("Aqui temos o melhor preço do mercado para você", ["melhor preço do mercado"]) ?? "", /frase proibida/);
    assert.ok(checkCaption("COMPRE AGORA ESTA OFERTA INCRÍVEL QUE NUNCA MAIS VAI ACONTECER NA SUA VIDA"));
  });

  it("imagem: só endereço público em https; sem imagem não publica", () => {
    assert.equal(checkImageUrl(IMG), null);
    assert.ok(checkImageUrl(null));
    assert.ok(checkImageUrl("http://cdn.exemplo.com/a.jpg"));
    assert.ok(checkImageUrl("https://127.0.0.1/a.jpg"));
    assert.ok(checkImageUrl("javascript:alert(1)"));
    const base = { status: "pendente" as const, caption: CAPTION, image_url: IMG, expires_at: new Date(NOW.getTime() + 3_600_000).toISOString() };
    assert.equal(publishable(base, [], NOW).ok, true);
    assert.equal(publishable({ ...base, image_url: null }, [], NOW).ok, false);
    assert.equal(publishable({ ...base, status: "publicado" }, [], NOW).ok, false);
    assert.equal(publishable({ ...base, expires_at: NOW.toISOString() }, [], NOW).ok, false);
  });

  it("hashtags configuradas entram no fim sem repetir as que a legenda já tem", () => {
    assert.equal(withHashtags("Oi #Estetica", ["estetica", "curitiba"]), "Oi #Estetica\n\n#curitiba");
    assert.equal(withHashtags("Oi", []), "Oi");
  });
});

describe("Instagram: propor, editar e publicar só com o clique", () => {
  const publisher = (impl?: InstagramPublisher["publishMedia"]) => {
    const calls: Array<Parameters<InstagramPublisher["publishMedia"]>[0]> = [];
    const p: InstagramPublisher = {
      publishMedia: async (i) => {
        calls.push(i);
        return impl ? impl(i) : { id: "17900000000001", permalink: "https://www.instagram.com/p/ABC/" };
      },
      quota: async () => null,
    };
    return { p, calls };
  };

  it("propor cria o post pendente e o pedido, sem publicar; legenda reprovada nem é criada", async () => {
    const post = await proposePost({ topic: "Limpeza de pele", caption: CAPTION, imageIdea: "foto da sala", imageUrl: null }, NOW);
    assert.equal(post.status, "pendente");
    assert.equal(post.platform, "instagram");
    assert.equal(getAgentData().approvals.filter((a) => a.kind === "social_post" && a.status === "pendente").length, 1);
    await assert.rejects(() => proposePost({ topic: "x", caption: "Veja https://golpe.example agora mesmo, é imperdível para você", imageIdea: "y" }));
    assert.equal(getAgentData().social_posts.length, 1);
  });

  it("'Aprovar e publicar': aprova, publica uma vez com a chave de idempotência e registra o resultado", async () => {
    const post = await proposePost({ topic: "Limpeza de pele", caption: CAPTION, imageIdea: "foto", imageUrl: IMG }, NOW);
    const { p, calls } = publisher();
    const r = await approveAndPublish(post.id, "user_owner", { now: () => NOW, publisher: p });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.idempotencyKey, post.idempotency_key);
    assert.equal(calls[0]!.caption, CAPTION);
    const done = (await agentRepo().get("social_posts", post.id))!;
    assert.equal(done.status, "publicado");
    assert.equal(done.approved_by, "user_owner");
    assert.equal(done.external_id, "17900000000001");
    assert.equal((await agentRepo().get("approvals", post.approval_id!))!.status, "aprovado");
  });

  it("dois cliques ao mesmo tempo publicam UMA vez só", async () => {
    const post = await proposePost({ topic: "Limpeza de pele", caption: CAPTION, imageIdea: "foto", imageUrl: IMG }, NOW);
    const { p, calls } = publisher(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { id: "1", permalink: null };
    });
    const [a, b] = await Promise.all([approveAndPublish(post.id, "u1", { now: () => NOW, publisher: p }), approveAndPublish(post.id, "u2", { now: () => NOW, publisher: p })]);
    assert.equal(calls.length, 1);
    assert.equal([a, b].filter((x) => x.ok).length, 1);
    assert.equal([a, b].filter((x) => !x.ok).length, 1);
  });

  it("sem imagem, sem Instagram configurado, legenda editada com link ou proposta expirada: não publica nada", async () => {
    const { p, calls } = publisher();
    const noImage = await proposePost({ topic: "A", caption: CAPTION, imageIdea: "f" }, NOW);
    assert.equal((await approveAndPublish(noImage.id, "u", { now: () => NOW, publisher: p })).ok, false);

    const withImage = await proposePost({ topic: "B", caption: CAPTION, imageIdea: "f", imageUrl: IMG }, NOW);
    assert.equal((await approveAndPublish(withImage.id, "u", { now: () => NOW, publisher: null })).ok, false, "Instagram não configurado");

    const late = new Date(NOW.getTime() + 10 * 86_400_000);
    assert.equal((await approveAndPublish(withImage.id, "u", { now: () => late, publisher: p })).ok, false, "expirada");
    assert.equal((await agentRepo().get("social_posts", withImage.id))!.status, "expirado");
    assert.equal(calls.length, 0);

    const edit = await proposePost({ topic: "C", caption: CAPTION, imageIdea: "f", imageUrl: IMG }, NOW);
    assert.equal((await editPost(edit.id, { caption: "Veja https://golpe.example e compre agora mesmo" })).ok, false);
    const ok = await editPost(edit.id, { caption: CAPTION + " Marque um horário.", image_url: IMG });
    assert.equal(ok.ok && ok.post.edited, true);
  });

  it("falha definitiva volta a 'pendente' só por ação do botão (reabrir); nunca republica sozinha", async () => {
    const post = await proposePost({ topic: "Limpeza de pele", caption: CAPTION, imageIdea: "foto", imageUrl: IMG }, NOW);
    const bad = publisher(async () => {
      throw new InstagramError("AUTH", "Token expirado");
    });
    const r = await approveAndPublish(post.id, "u", { now: () => NOW, publisher: bad.p });
    assert.equal(r.ok, false);
    const failed = (await agentRepo().get("social_posts", post.id))!;
    assert.equal(failed.status, "falhou");
    assert.equal(failed.uncertain, false);
    assert.ok(getDb().notifications.some((n) => n.title.includes("Não foi possível publicar")));
    assert.equal(await reopenFailedPost(post.id, NOW), true);
    assert.equal((await agentRepo().get("social_posts", post.id))!.status, "pendente");
  });

  it("sem confirmação (timeout) fica 'incerta': não reabre, e a conferência acha o post ou o libera", async () => {
    const post = await proposePost({ topic: "Limpeza de pele", caption: CAPTION, imageIdea: "foto", imageUrl: IMG }, NOW);
    const slow = publisher(async () => {
      throw new InstagramError("TIMEOUT", "Sem resposta do Instagram");
    });
    await approveAndPublish(post.id, "u", { now: () => NOW, publisher: slow.p });
    const stuck = (await agentRepo().get("social_posts", post.id))!;
    assert.equal(stuck.status, "falhou");
    assert.equal(stuck.uncertain, true);
    assert.equal(await reopenFailedPost(post.id, NOW), false, "incerta não reabre");

    const notFound = await reconcileUncertainPost(post.id, { reader: { profile: async () => ({ username: "x", name: null, followers: null, mediaCount: null, biography: null }), recentMedia: async () => [] } });
    assert.equal(notFound.ok, false);
    const found = await reconcileUncertainPost(post.id, {
      reader: {
        profile: async () => ({ username: "x", name: null, followers: null, mediaCount: null, biography: null }),
        recentMedia: async () => [{ id: "179", caption: CAPTION, mediaType: "IMAGE", permalink: "https://www.instagram.com/p/XYZ/", timestamp: new Date(NOW.getTime() + 60_000).toISOString(), likes: 0, comments: 0 }],
      },
    });
    assert.equal(found.ok, true);
    assert.equal((await agentRepo().get("social_posts", post.id))!.status, "publicado");

    const other = await proposePost({ topic: "B", caption: CAPTION + " 2", imageIdea: "f", imageUrl: IMG }, NOW);
    await approveAndPublish(other.id, "u", { now: () => NOW, publisher: slow.p });
    assert.equal(await markNotPublished(other.id), true);
    assert.equal(await reopenFailedPost(other.id, NOW), true, "depois de conferir que não saiu, pode reabrir");
  });

  it("proposta sem decisão expira; post preso em 'publicando' vira falha incerta", async () => {
    const post = await proposePost({ topic: "Limpeza de pele", caption: CAPTION, imageIdea: "foto" }, NOW);
    assert.equal(await expireStalePosts(new Date(NOW.getTime() + 5 * 86_400_000)), 1);
    assert.equal((await agentRepo().get("social_posts", post.id))!.status, "expirado");
    assert.equal((await agentRepo().get("approvals", post.approval_id!))!.status, "expirado");

    const p2 = await proposePost({ topic: "B", caption: CAPTION + " 3", imageIdea: "f", imageUrl: IMG }, NOW);
    await agentRepo().update("social_posts", p2.id, { status: "publicando", updated_at: NOW.toISOString() });
    assert.equal(await reconcileStuckPublishing(new Date(NOW.getTime() + 11 * 60_000)), 1);
    const s = (await agentRepo().get("social_posts", p2.id))!;
    assert.equal(s.status, "falhou");
    assert.equal(s.uncertain, true);
  });
});

describe("Instagram: cliente HTTP", () => {
  const cfg = { token: "tok-secreto-123", businessId: "17841400000000", version: "v21.0" };

  it("só ativa com token e ID válidos; o token vai no cabeçalho, nunca na URL", async () => {
    assert.equal(instagramConfig({}), null);
    assert.equal(instagramConfig({ INSTAGRAM_ACCESS_TOKEN: "x", INSTAGRAM_BUSINESS_ID: "abc" }), null);
    assert.ok(instagramConfig({ INSTAGRAM_ACCESS_TOKEN: "x", INSTAGRAM_BUSINESS_ID: "17841400000000" }));
    const seen: Array<{ url: string; auth: string | null }> = [];
    const f = (async (url: URL, init?: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ username: "aurora", followers_count: 1200, media_count: 40 }), { status: 200 });
    }) as unknown as typeof fetch;
    const profile = await createInstagramReader(cfg, f)!.profile();
    assert.equal(profile.username, "aurora");
    assert.equal(profile.followers, 1200);
    assert.ok(!seen[0]!.url.includes("tok-secreto"));
    assert.equal(seen[0]!.auth, "Bearer tok-secreto-123");
  });

  it("publicar são dois passos (contêiner e publicação) e classifica os erros da API", async () => {
    const calls: string[] = [];
    const f = (async (url: URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${new URL(String(url)).pathname}`);
      if (String(url).includes("/media_publish")) return new Response(JSON.stringify({ id: "9001" }), { status: 200 });
      if (String(url).endsWith("/media")) return new Response(JSON.stringify({ id: "creation-1" }), { status: 200 });
      return new Response(JSON.stringify({ permalink: "https://www.instagram.com/p/AA/" }), { status: 200 });
    }) as unknown as typeof fetch;
    const res = await createInstagramPublisher(cfg, f)!.publishMedia({ format: "feed", mediaUrl: IMG, caption: CAPTION, idempotencyKey: "k" });
    assert.deepEqual(res, { id: "9001", permalink: "https://www.instagram.com/p/AA/" });
    assert.deepEqual(calls.slice(0, 2), ["POST /v21.0/17841400000000/media", "POST /v21.0/17841400000000/media_publish"]);

    const err = (status: number, code: number) =>
      (async () => new Response(JSON.stringify({ error: { message: "x", code } }), { status })) as unknown as typeof fetch;
    const kind = async (f2: typeof fetch) => {
      try {
        await createInstagramPublisher(cfg, f2)!.publishMedia({ format: "feed", mediaUrl: IMG, caption: CAPTION, idempotencyKey: "k" });
        return "ok";
      } catch (e) {
        return (e as InstagramError).kind;
      }
    };
    assert.equal(await kind(err(400, 190)), "AUTH");
    assert.equal(await kind(err(429, 4)), "RATE_LIMITED");
    assert.equal(await kind(err(500, 2)), "TEMPORARY");
    assert.equal(await kind(err(400, 100)), "PERMANENT");
    const timeout = (async () => {
      const e = new Error("t");
      e.name = "TimeoutError";
      throw e;
    }) as unknown as typeof fetch;
    assert.equal(await kind(timeout), "TIMEOUT");
    assert.equal(new InstagramError("TIMEOUT", "x").uncertain, true);
    assert.equal(createInstagramPublisher(null), null);
  });
});

describe("Agente de mídias sociais: o que propõe", () => {
  it("pautas só do que o perfil sustenta; sem perfil, nada a propor", async () => {
    const topics = topicsFrom(getDb().company_profile);
    assert.deepEqual(topics.map((t) => t.kind), ["servico", "servico", "diferencial", "problema"]);
    const caption = templateCaption(topics[0]!, getDb().company_profile);
    assert.equal(checkCaption(caption), null);
    assert.match(caption, /Clínica Aurora/);
    setProfile({ main_services: [], differentiators: [], problems_we_solve: [], what_we_sell: "" });
    assert.deepEqual(await socialMedia.plan(), []);
  });

  it("planeja as vagas do calendário e respeita o limite de pendentes", async () => {
    await saveSettings("social-media", { config: { max_pending_posts: 2 } });
    const planned = await socialMedia.plan();
    assert.equal(planned.length, 2, "no máximo o que cabe entre os pendentes");
    assert.ok(planned.every((p) => p.kind === "social.propose" && ["feed", "reel", "story"].includes((p.payload as { format: string }).format)));
    for (let i = 0; i < 2; i++) await proposePost({ topic: `Pauta ${i}`, caption: CAPTION + i, imageIdea: "f" });
    assert.deepEqual(await socialMedia.plan(), [], "dois pendentes já ocupam o teto");
  });

  it("não repete a pauta de um post recente e ainda propõe quando todas já foram usadas", async () => {
    await proposePost({ topic: "Limpeza de pele", caption: CAPTION, imageIdea: "f" }, new Date(NOW.getTime() - 3 * 86_400_000));
    await enqueueAgentTask({ agent: "social-media", kind: "social.propose", dedupeKey: "t:rep" });
    await runAgentQueue({ agents: ["social-media"], budgetMs: 10_000 });
    const topicsSeen = getAgentData().social_posts.map((p) => p.topic);
    assert.ok(topicsSeen.includes("Depilação a laser"), String(topicsSeen));
  });
});

describe("campanhas: regras e tetos de gasto", () => {
  it("a máquina de estados só deixa chegar a 'ativa' a partir de aprovada ou pausada", () => {
    for (const [from, tos] of Object.entries(CAMPAIGN_TRANSITIONS)) {
      if (tos.includes("ativa")) assert.ok(from === "aprovado" || from === "pausada", from);
    }
    assert.ok(!canMoveCampaign("pendente", "ativa"));
    assert.ok(!canMoveCampaign("recusada", "ativa"));
    assert.ok(!canMoveCampaign("encerrada", "ativa"));
  });

  it("barreiras do anúncio: orçamento, datas, tamanho dos textos, promessa e destino", () => {
    assert.equal(checkCampaign(draft(), [], TODAY), null);
    assert.ok(checkCampaign(draft({ daily_budget_cents: 0 }), [], TODAY));
    assert.ok(checkCampaign(draft({ daily_budget_cents: 10.5 }), [], TODAY));
    assert.ok(checkCampaign(draft({ start_date: "2026-10-01" }), [], TODAY), "no passado");
    assert.ok(checkCampaign(draft({ end_date: "2026-10-01" }), [], TODAY));
    assert.ok(checkCampaign(draft({ headline: "x".repeat(41) }), [], TODAY));
    assert.ok(checkCampaign(draft({ body: "curto" }), [], TODAY));
    assert.ok(checkCampaign(draft({ body: "Resultado garantido em uma semana ou o seu dinheiro de volta, sem risco." }), [], TODAY));
    assert.ok(checkCampaign(draft({ landing_url: "http://exemplo.com" }), [], TODAY));
    assert.ok(checkCampaign(draft({ landing_url: "https://localhost/x" }), [], TODAY));
    assert.match(checkCampaign(draft({ body: "Aqui tem o melhor preço do mercado para você, venha conferir hoje." }), ["melhor preço do mercado"], TODAY) ?? "", /frase proibida/);
  });

  it("tetos: o gasto diário somado e o mensal previsto (gasto + dias que faltam) nunca passam", () => {
    const caps = { daily_cap_cents: 3_000, monthly_cap_cents: 60_000 };
    assert.equal(remainingDaysInMonth("2026-10-12"), 20);
    assert.equal(remainingDaysInMonth("2026-10-12", "2026-10-15"), 4, "campanha com fim");
    const base = { campaignDailyCents: 1_000, otherActiveDailyCents: 1_000, spentMonthCents: 0, today: "2026-10-12", caps };
    const okRes = evaluateSpendCaps(base);
    assert.equal(okRes.ok, true);
    assert.deepEqual(evaluateSpendCaps({ ...base, otherActiveDailyCents: 2_500 }), { ok: false, code: "diario", reason: evaluateSpendCaps({ ...base, otherActiveDailyCents: 2_500 }).ok ? "" : (evaluateSpendCaps({ ...base, otherActiveDailyCents: 2_500 }) as { reason: string }).reason });
    const monthly = evaluateSpendCaps({ ...base, spentMonthCents: 25_000 });
    assert.equal(monthly.ok, false);
    assert.equal(monthly.ok ? "" : monthly.code, "mensal");
    assert.equal(evaluateSpendCaps({ ...base, campaignDailyCents: 100, otherActiveDailyCents: 0, endDate: "2026-10-12", spentMonthCents: 59_000 }).ok, true, "um dia só de campanha cabe");
    assert.equal(formatBrl(12_345).replace(/\s/g, " "), "R$ 123,45");
  });

  it("subir orçamento ou ativar é gasto a mais; descer ou pausar não é", () => {
    assert.equal(increasesSpend({ status: "aprovado", daily_budget_cents: 1000 }, { status: "ativa" }), true);
    assert.equal(increasesSpend({ status: "ativa", daily_budget_cents: 1000 }, { daily_budget_cents: 1500 }), true);
    assert.equal(increasesSpend({ status: "ativa", daily_budget_cents: 1000 }, { daily_budget_cents: 500 }), false);
    assert.equal(increasesSpend({ status: "ativa", daily_budget_cents: 1000 }, { status: "pausada" }), false);
  });
});

describe("campanhas: do rascunho ao gasto, sempre com clique e dentro dos tetos", () => {
  it("nasce pendente com pedido; aprovar o rascunho NÃO gasta nada; ativar é outro passo", async () => {
    const c = await proposeCampaign(draft(), NOW);
    assert.equal(c.status, "pendente");
    assert.equal(c.platform, "manual");
    assert.equal(getAgentData().approvals.filter((a) => a.kind === "ad_campaign").length, 1);
    assert.equal((await activateCampaign(c.id, "u", { now: NOW })).ok, false, "pendente não ativa");

    const approved = await approveCampaignDraft(c.id, "user_owner", NOW);
    assert.equal(approved.ok && approved.campaign.status, "aprovado");
    assert.equal((await spendSummary(NOW)).activeDailyCents, 0, "aprovada ainda não conta como gasto");

    const act = await activateCampaign(c.id, "user_owner", { now: NOW, externalId: "act_123" });
    assert.equal(act.ok && act.campaign.status, "ativa");
    assert.equal(act.ok && act.campaign.external_id, "act_123");
    assert.equal((await spendSummary(NOW)).activeDailyCents, 1_000);
  });

  it("o teto diário barra a ativação e o registro diz por quê", async () => {
    await saveSettings("traffic-manager", { config: { daily_cap_cents: 1_500, monthly_cap_cents: 60_000 } });
    const a = await proposeCampaign(draft({ name: "Campanha A" }), NOW);
    const b = await proposeCampaign(draft({ name: "Campanha B" }), NOW);
    await approveCampaignDraft(a.id, "u", NOW);
    await approveCampaignDraft(b.id, "u", NOW);
    assert.equal((await activateCampaign(a.id, "u", { now: NOW })).ok, true);
    const second = await activateCampaign(b.id, "u", { now: NOW });
    assert.equal(second.ok, false);
    assert.match(second.ok ? "" : second.error, /teto de R\$\s?15,00 por dia/);
    assert.equal((await agentRepo().get("ad_campaigns", b.id))!.status, "aprovado", "continua parada");
    assert.ok(getAgentData().events.some((e) => e.type === "campaign.blocked"));
  });

  it("o teto mensal considera o que já foi gasto no mês", async () => {
    await saveSettings("traffic-manager", { config: { daily_cap_cents: 3_000, monthly_cap_cents: 30_000 } });
    const c = await proposeCampaign(draft(), NOW);
    await approveCampaignDraft(c.id, "u", NOW);
    await recordReport({ campaign_id: c.id, day: TODAY, impressions: 1000, clicks: 50, spend_cents: 15_000, conversions: 2 });
    const r = await activateCampaign(c.id, "u", { now: NOW });
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /teto de R\$\s?300,00 por mês/);
  });

  it("subir o orçamento de uma campanha ativa confere os tetos; descer sempre pode", async () => {
    await saveSettings("traffic-manager", { config: { daily_cap_cents: 2_000, monthly_cap_cents: 60_000 } });
    const c = await proposeCampaign(draft(), NOW);
    await approveCampaignDraft(c.id, "u", NOW);
    await activateCampaign(c.id, "u", { now: NOW });
    assert.equal((await setCampaignBudget(c.id, 2_500, "u", NOW)).ok, false, "estoura o teto diário");
    assert.equal((await agentRepo().get("ad_campaigns", c.id))!.daily_budget_cents, 1_000, "nada mudou");
    assert.equal((await setCampaignBudget(c.id, 1_800, "u", NOW)).ok, true);
    assert.equal((await setCampaignBudget(c.id, 500, "u", NOW)).ok, true);
    assert.equal((await setCampaignBudget(c.id, 0, "u", NOW)).ok, false);
  });

  it("dois cliques em 'ativar' ativam uma vez só", async () => {
    const c = await proposeCampaign(draft(), NOW);
    await approveCampaignDraft(c.id, "u", NOW);
    const [a, b] = await Promise.all([activateCampaign(c.id, "u1", { now: NOW }), activateCampaign(c.id, "u2", { now: NOW })]);
    assert.equal([a, b].filter((x) => x.ok).length, 1);
    assert.equal((await spendSummary(NOW)).activeDailyCents, 1_000, "o gasto previsto não dobrou");
  });

  it("pausar e a mudança proposta pelo agente: só valem com clique, e o aumento passa pelos tetos", async () => {
    const c = await proposeCampaign(draft(), NOW);
    await approveCampaignDraft(c.id, "u", NOW);
    await activateCampaign(c.id, "u", { now: NOW });
    const active = (await agentRepo().get("ad_campaigns", c.id))!;
    const id = await proposeBudgetChange({ campaign: active, action: "pausar", reason: "sem conversão" }, NOW);
    assert.ok(id);
    assert.equal(await proposeBudgetChange({ campaign: active, action: "pausar", reason: "sem conversão" }, NOW), null, "uma vez por dia");
    assert.equal((await agentRepo().get("ad_campaigns", c.id))!.status, "ativa", "propor não pausa");
    const r = await decideApproval(id!, true, "user_owner");
    assert.equal(r.ok, true);
    assert.equal((await agentRepo().get("ad_campaigns", c.id))!.status, "pausada");
    assert.equal((await pauseCampaign(c.id, "u", NOW)).ok, false, "já pausada");

    await saveSettings("traffic-manager", { config: { daily_cap_cents: 1_000, monthly_cap_cents: 60_000 } });
    await activateCampaign(c.id, "u", { now: NOW });
    const up = await applyBudgetChange({ campaign_id: c.id, action: "ajustar", to_cents: 5_000 }, "u", NOW);
    assert.equal(up.ok, false);
  });

  it("relatório: números inteiros, um por campanha por dia, e o resumo soma o mês", async () => {
    const c = await proposeCampaign(draft(), NOW);
    await assert.rejects(() => recordReport({ campaign_id: c.id, day: TODAY, impressions: 10, clicks: 20, spend_cents: 0, conversions: 0 }), /Cliques/);
    await assert.rejects(() => recordReport({ campaign_id: c.id, day: TODAY, impressions: 10, clicks: 1, spend_cents: -5, conversions: 0 }));
    await assert.rejects(() => recordReport({ campaign_id: "nao-existe", day: TODAY, impressions: 1, clicks: 0, spend_cents: 0, conversions: 0 }));
    await recordReport({ campaign_id: c.id, day: TODAY, impressions: 100, clicks: 5, spend_cents: 700, conversions: 1 });
    await recordReport({ campaign_id: c.id, day: TODAY, impressions: 120, clicks: 6, spend_cents: 900, conversions: 1 });
    await recordReport({ campaign_id: c.id, day: "2026-10-01", impressions: 100, clicks: 5, spend_cents: 400, conversions: 0 });
    assert.equal(getAgentData().ad_reports.length, 2 + 0, "o mesmo dia corrige, não duplica");
    const s = await spendSummary(NOW);
    assert.equal(s.todaySpentCents, 900);
    assert.equal(s.monthSpentCents, 1_300);
  });
});

describe("Agente de tráfego: o que propõe", () => {
  it("planeja um rascunho por semana e a revisão só quando há campanha ativa", async () => {
    const first = await trafficManager.plan();
    assert.deepEqual(first.map((t) => t.kind), ["ads.propose"]);
    const c = await proposeCampaign(draft(), new Date());
    assert.deepEqual(await trafficManager.plan(), [], "já houve proposta esta semana");
    await approveCampaignDraft(c.id, "u", new Date());
    await activateCampaign(c.id, "u");
    assert.deepEqual((await trafficManager.plan()).map((t) => t.kind), ["ads.review"]);
  });

  it("a revisão propõe pausar quem gasta sem converter e avisa quando o gasto passa do teto — sem pausar sozinha", async () => {
    await saveSettings("traffic-manager", { mode: "automatico", config: { daily_cap_cents: 3_000, monthly_cap_cents: 60_000 } });
    const c = await proposeCampaign(draft(), new Date());
    await approveCampaignDraft(c.id, "u", new Date());
    await activateCampaign(c.id, "u");
    const day = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);
    for (const d of [0, 1, 2]) await recordReport({ campaign_id: c.id, day: day(d), impressions: 500, clicks: 10, spend_cents: 1_000, conversions: 0 });
    await enqueueAgentTask({ agent: "traffic-manager", kind: "ads.review", dedupeKey: "t:review" });
    await runAgentQueue({ agents: ["traffic-manager"], budgetMs: 10_000 });
    const pending = getAgentData().approvals.filter((a) => a.kind === "ad_budget_change" && a.status === "pendente");
    assert.equal(pending.length, 1);
    assert.match(pending[0]!.detail ?? "", /sem nenhuma conversão/);
    assert.equal((await agentRepo().get("ad_campaigns", c.id))!.status, "ativa", "o agente propôs; quem pausa é o clique");

    await recordReport({ campaign_id: c.id, day: day(0), impressions: 500, clicks: 10, spend_cents: 5_000, conversions: 0 });
    await enqueueAgentTask({ agent: "traffic-manager", kind: "ads.review", dedupeKey: "t:review2" });
    await runAgentQueue({ agents: ["traffic-manager"], budgetMs: 10_000 });
    assert.ok(getDb().notifications.some((n) => n.title.includes("Gasto de anúncios acima do teto")));
    assert.equal((await agentRepo().get("ad_campaigns", c.id))!.status, "ativa");
  });

  it("o rascunho proposto sai dentro das barreiras e do teto diário; teto zerado, nada proposto", async () => {
    await saveSettings("traffic-manager", { config: { daily_cap_cents: 3_000, monthly_cap_cents: 60_000 } });
    await enqueueAgentTask({ agent: "traffic-manager", kind: "ads.propose", dedupeKey: "t:p" });
    await runAgentQueue({ agents: ["traffic-manager"], budgetMs: 10_000 });
    const [c] = getAgentData().ad_campaigns;
    assert.ok(c);
    assert.equal(c!.status, "pendente");
    assert.ok(c!.daily_budget_cents <= 3_000 && c!.daily_budget_cents >= 500);
    assert.equal(checkCampaign(c!, [], c!.start_date), null);

    reset();
    await saveSettings("traffic-manager", { config: { daily_cap_cents: 0, monthly_cap_cents: 0 } });
    await enqueueAgentTask({ agent: "traffic-manager", kind: "ads.propose", dedupeKey: "t:p2" });
    await runAgentQueue({ agents: ["traffic-manager"], budgetMs: 10_000 });
    assert.equal(getAgentData().ad_campaigns.length, 0);
  });
});
