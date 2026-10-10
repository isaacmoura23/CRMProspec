import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getDb } from "@/lib/store";
import { registerAgentHandlers } from "@/agents/registry";
import { AGENT_TOOLS, HUMAN_ONLY_TOOLS } from "@/agents/tools";
import { SOCIAL_DEFAULTS } from "@/agents/config";
import { calendarSlots, missingSlots, slotAt, socialMedia, spDay, spWeekday, weekdayPattern } from "@/agents/social/agent";
import { trafficManager } from "@/agents/traffic/agent";
import { parseBrasiliaLocal, toBrasiliaLocal, formatBrasilia } from "@/lib/brasilia-time";
import { checkSchedule, dueState, postDigest } from "@/lib/social-policy";
import { creativeDir, creativeTestHooks, publicCreativeFile } from "@/services/creatives/engine";
import { setGloballyEnabled, saveSettings } from "@/services/agents/settings";
import { enqueueAgentTask, runAgentQueue } from "@/services/agents/queue";
import { agentRepo, getAgentData, resetAgentRepoForTests } from "@/services/agents/repository";
import { runnerTick } from "@/services/agents/runner";
import { activateCampaign, approveCampaignCreative, approveCampaignDraft, proposeCampaign, regenerateCampaignCreative, rejectCampaignCreative, rejectCampaignDraft } from "@/services/ads/campaigns";
import { InstagramError, type FetchLike } from "@/services/social/instagram";
import { containerParams, createInstagramPublisher, type InstagramPublisher } from "@/services/social/instagram-publisher";
import { approveAndPublish, approveAndSchedule, cancelSchedule, expireStalePosts, proposePost, publishDueScheduled, regeneratePostCreative, rejectPost, reopenFailedPost, resolveMedia, runSocialMaintenance } from "@/services/social/posts";
import { emptyAgentData, type PostFormat, type SocialPost } from "@/types/agents";
import { fakeBrowser, installCreativeFakes } from "./creative-fakes";

const NOW = new Date("2026-10-12T15:00:00Z"); // segunda-feira, 12:00 em Brasília
const BASE = "https://crm.exemplo.com";
const CAPTION = "Limpeza de pele: como a Clínica Aurora faz na prática.\n\nProcedimentos faciais e corporais com avaliação individual.\n\nQuer saber mais? Chama a gente no direct.";
const at = (minutes: number, from: Date = NOW) => new Date(from.getTime() + minutes * 60_000);
const original = { ...getDb().company_profile };

let n = 0;
let undoFakes: () => void;
let envBefore: Record<string, string | undefined>;

beforeEach(() => {
  registerAgentHandlers();
  resetAgentRepoForTests();
  Object.assign(getAgentData(), emptyAgentData());
  getDb().notifications.splice(0);
  Object.assign(getDb().company_profile, {
    company_name: "Clínica Aurora",
    what_we_sell: "Clínica de estética com procedimentos faciais e corporais.",
    main_services: ["Limpeza de pele", "Depilação a laser"],
    differentiators: ["Atendimento com avaliação individual"],
    problems_we_solve: ["Pele sem viço no dia a dia"],
    target_customers: "Mulheres de 25 a 50 anos em Curitiba",
    communication_style: "próximo e profissional",
    never_say: [],
  });
  envBefore = { PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL, IG_T: process.env.INSTAGRAM_ACCESS_TOKEN, IG_B: process.env.INSTAGRAM_BUSINESS_ID };
  process.env.PUBLIC_BASE_URL = BASE;
  undoFakes = installCreativeFakes();
});
afterEach(() => {
  undoFakes();
  Object.assign(getDb().company_profile, original);
  for (const [k, v] of [["PUBLIC_BASE_URL", envBefore.PUBLIC_BASE_URL], ["INSTAGRAM_ACCESS_TOKEN", envBefore.IG_T], ["INSTAGRAM_BUSINESS_ID", envBefore.IG_B]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Publicador simulado: guarda cada chamada, devolve o que o teste pedir. */
function fakePublisher(over: Partial<InstagramPublisher> = {}) {
  const calls: Array<Parameters<InstagramPublisher["publishMedia"]>[0]> = [];
  const p: InstagramPublisher = {
    publishMedia: async (i) => {
      calls.push(i);
      await new Promise((r) => setTimeout(r, 5));
      return { id: `179${calls.length}`, permalink: "https://www.instagram.com/p/ABC/" };
    },
    quota: async () => null,
    ...over,
  };
  return { p, calls };
}

async function proposed(format: PostFormat = "feed", over: { image?: string | null; now?: Date; suggestedAt?: string } = {}): Promise<SocialPost> {
  n++;
  return proposePost(
    {
      topic: `Pauta ${n}`,
      caption: `${CAPTION} ${n}`,
      imageIdea: "arte em código",
      format,
      imageUrl: over.image ?? null,
      suggestedAt: over.suggestedAt ?? at(24 * 60).toISOString(),
      creative: over.image ? undefined : { headline: "Limpeza de pele", body: "Procedimentos faciais e corporais.", cta: "Chame no direct" },
    },
    over.now ?? NOW
  );
}

const get = async (id: string) => (await agentRepo().get("social_posts", id))!;
const creativeOf = async (post: SocialPost) => (await agentRepo().get("creatives", (await get(post.id)).creative_id!))!;

/* ------------------------------------------------------------------ */

describe("horário de Brasília e calendário (funções puras)", () => {
  it("converte o campo datetime-local e formata sem depender do fuso da máquina", () => {
    assert.equal(parseBrasiliaLocal("2026-10-13T12:00")!.toISOString(), "2026-10-13T15:00:00.000Z");
    assert.equal(parseBrasiliaLocal("2026-10-13 12:00"), null);
    assert.equal(parseBrasiliaLocal("2026-13-40T99:99"), null);
    assert.equal(toBrasiliaLocal("2026-10-13T15:00:00.000Z"), "2026-10-13T12:00");
    assert.equal(formatBrasilia("2026-10-13T02:30:00.000Z"), "12/10 às 23:30");
    assert.equal(spDay(new Date("2026-10-13T02:30:00Z")), "2026-10-12", "23:30 de Brasília ainda é dia 12");
    assert.equal(spWeekday("2026-10-12"), 0, "12/10/2026 é segunda-feira");
    assert.equal(slotAt("2026-10-12", 12).toISOString(), "2026-10-12T15:00:00.000Z");
  });

  it("espalha n posts por semana nos dias da semana", () => {
    assert.deepEqual(weekdayPattern(0), []);
    assert.deepEqual(weekdayPattern(1), [3]);
    assert.deepEqual(weekdayPattern(2), [1, 5]);
    assert.deepEqual(weekdayPattern(3), [1, 3, 5]);
    assert.deepEqual(weekdayPattern(7), [0, 1, 2, 3, 4, 5, 6]);
    assert.equal(new Set(weekdayPattern(5)).size, 5, "sem dia repetido");
    assert.equal(weekdayPattern(99).length, 7, "limitado a 7");
  });

  it("a semana padrão tem 3 Feed, 1 Reels e 2 Stories, só no futuro, nos horários configurados", () => {
    const slots = calendarSlots(SOCIAL_DEFAULTS, NOW);
    const by = (f: string) => slots.filter((s) => s.format === f);
    assert.deepEqual([by("feed").length, by("reel").length, by("story").length], [3, 1, 2]);
    assert.deepEqual(by("feed").map((s) => s.day), ["2026-10-13", "2026-10-15", "2026-10-17"], "terça, quinta e sábado");
    assert.equal(by("feed")[0]!.at, "2026-10-13T15:00:00.000Z", "12h em Brasília");
    assert.equal(by("reel")[0]!.at, "2026-10-15T21:00:00.000Z", "18h em Brasília");
    assert.equal(by("story")[0]!.at, "2026-10-13T12:00:00.000Z", "9h em Brasília");
    assert.ok(slots.every((s) => Date.parse(s.at) >= NOW.getTime() + 3_600_000));
    assert.deepEqual(slots.map((s) => s.at), [...slots.map((s) => s.at)].sort());
    assert.deepEqual(calendarSlots({ ...SOCIAL_DEFAULTS, weekly_feed: 0, weekly_reel: 0, weekly_story: 0 }, NOW), []);
    assert.equal(calendarSlots({ ...SOCIAL_DEFAULTS, weekly_feed: 0, weekly_reel: 0, weekly_story: 14 }, NOW).length, 13, "14 stories por semana são dois por dia; a vaga das 9h de hoje já passou");
    assert.equal(calendarSlots({ ...SOCIAL_DEFAULTS, calendar_days: 14 }, NOW).length, 12);
  });

  it("um post de qualquer estado cobre a vaga do seu formato e dia (o recusado não volta)", () => {
    const slots = calendarSlots(SOCIAL_DEFAULTS, NOW);
    assert.equal(missingSlots(slots, []).length, 6);
    const covered = missingSlots(slots, [{ format: "feed", suggested_at: "2026-10-13T15:00:00.000Z" }, { format: "reel", suggested_at: "2026-10-15T21:00:00.000Z" }, { format: "story", suggested_at: null }]);
    assert.equal(covered.length, 4, "dois cobertos; o sem data não cobre nada");
    assert.ok(!covered.some((s) => s.format === "reel"));
  });

  it("agenda: antecedência de 5 minutos a 30 dias; a hora chega, passa da janela ou ainda espera", () => {
    assert.match(checkSchedule(at(2), NOW)!, /5 minutos/);
    assert.equal(checkSchedule(at(6), NOW), null);
    assert.match(checkSchedule(at(31 * 24 * 60), NOW)!, /30 dias/);
    assert.match(checkSchedule(new Date("x"), NOW)!, /inválida/);
    const iso = at(0).toISOString();
    assert.equal(dueState(iso, at(-1), 3), "wait");
    assert.equal(dueState(iso, at(60), 3), "go");
    assert.equal(dueState(iso, at(181), 3), "late");
    assert.equal(dueState("lixo", NOW, 3), "wait");
  });

  it("o resumo do que foi aprovado muda com qualquer detalhe", () => {
    const base = { format: "feed" as PostFormat, caption: "Oi", media: "abc", scheduledAt: "2026-10-13T15:00:00.000Z" };
    const d = postDigest(base);
    assert.equal(d.length, 64);
    assert.equal(postDigest({ ...base, caption: "Oi " }), d, "espaço nas pontas não conta");
    for (const diff of [{ format: "reel" as PostFormat }, { caption: "Olá" }, { media: "abd" }, { scheduledAt: "2026-10-13T15:01:00.000Z" }]) assert.notEqual(postDigest({ ...base, ...diff }), d);
  });
});

describe("o plano do agente de mídias sociais", () => {
  it("uma tarefa por vaga livre, com formato e horário; respeita o teto de pendentes e o perfil", async () => {
    await saveSettings("social-media", { config: { max_pending_posts: 20 } });
    // O plano usa o relógio real: o esperado vem das mesmas funções puras, com o mesmo relógio.
    const all = calendarSlots({ ...SOCIAL_DEFAULTS, max_pending_posts: 20 }, new Date());
    const planned = await socialMedia.plan();
    assert.equal(planned.length, all.length);
    assert.ok(all.length >= 4 && all.length <= 6, "uma semana padrão tem de 4 a 6 vagas futuras, conforme o dia e a hora em que o teste roda");
    assert.equal(new Set(planned.map((p) => p.dedupeKey)).size, all.length, "chaves únicas por vaga");
    assert.ok(planned.every((p) => /^social\.propose:(feed|reel|story):\d{4}-\d{2}-\d{2}:\d$/.test(p.dedupeKey)));
    assert.deepEqual(Object.keys(planned[0]!.payload as object).sort(), ["format", "slot_at"]);

    const first = all[0]!;
    await proposed(first.format, { suggestedAt: first.at, now: new Date() });
    await rejectPost((await agentRepo().list("social_posts"))[0]!.id, "u");
    assert.equal((await socialMedia.plan()).length, all.length - 1, "o post recusado continua cobrindo a vaga do dia");

    await saveSettings("social-media", { config: { max_pending_posts: 1 } });
    assert.equal((await socialMedia.plan()).length, 1);
    Object.assign(getDb().company_profile, { main_services: [], differentiators: [], problems_we_solve: [], what_we_sell: "" });
    assert.deepEqual(await socialMedia.plan(), [], "sem assunto, nada a propor");
  });

  it("rodar a tarefa propõe o post do formato pedido, com a arte e a sugestão de horário", async () => {
    await saveSettings("social-media", { mode: "automatico" });
    for (const [i, format] of (["feed", "reel", "story"] as PostFormat[]).entries()) {
      await enqueueAgentTask({ agent: "social-media", kind: "social.propose", payload: { format, slot_at: at(1440 * (i + 1)).toISOString() }, dedupeKey: `t:${format}` });
    }
    await runAgentQueue({ agents: ["social-media"], budgetMs: 30_000 });
    const tasks = await agentRepo().list("tasks");
    assert.ok(tasks.every((t) => t.status === "concluido"), JSON.stringify(tasks.map((t) => [t.status, t.last_error])));
    const posts = await agentRepo().list("social_posts", { orderBy: "created_at" });
    assert.deepEqual(posts.map((p) => p.format).sort(), ["feed", "reel", "story"]);
    assert.ok(posts.every((p) => p.status === "pendente" && p.suggested_at && p.creative_id && p.scheduled_at === null));
    const kinds = await Promise.all(posts.map(async (p) => [p.format, (await agentRepo().get("creatives", p.creative_id!))!.kind]));
    assert.deepEqual(Object.fromEntries(kinds), { feed: "imagem", reel: "video", story: "imagem" });
  });
});

describe("o post com arte: publicar agora", () => {
  it("o endereço da mídia é o do criativo no PUBLIC_BASE_URL; o clique aprova a arte e a serve, e o formato vai ao Instagram", async () => {
    const { p, calls } = fakePublisher();
    const feed = await proposed("feed");
    assert.equal(await publicCreativeFile((await creativeOf(feed)).token, "creative.png", NOW), null, "antes do clique não é servida");
    const r = await approveAndPublish(feed.id, "u1", { now: () => NOW, publisher: p });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const c = await creativeOf(feed);
    assert.equal(c.status, "aprovado");
    assert.equal(calls[0]!.mediaUrl, `${BASE}/midia/${c.token}/creative.png`);
    assert.equal(calls[0]!.format, "feed");
    assert.ok(await publicCreativeFile(c.token, "creative.png", NOW));

    const reel = await proposed("reel");
    await approveAndPublish(reel.id, "u1", { now: () => NOW, publisher: p });
    const rc = await creativeOf(reel);
    assert.equal(calls[1]!.format, "reel");
    assert.equal(calls[1]!.mediaUrl, `${BASE}/midia/${rc.token}/creative.mp4`);
    assert.equal(rc.kind, "video");
  });

  it("sem hospedagem pública (PUBLIC_BASE_URL) não dá para publicar: avisa o que falta e nada é aprovado", async () => {
    const post = await proposed("feed");
    delete process.env.PUBLIC_BASE_URL;
    const { p, calls } = fakePublisher();
    const m = await resolveMedia(await get(post.id));
    assert.equal(m.url, null);
    assert.match(m.reason ?? "", /Sem hospedagem pública/);
    const r = await approveAndPublish(post.id, "u", { now: () => NOW, publisher: p });
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /hospedagem/);
    assert.equal((await get(post.id)).status, "pendente");
    assert.equal((await creativeOf(post)).status, "pendente");
    assert.equal(calls.length, 0);
    process.env.PUBLIC_BASE_URL = "http://inseguro.example.com";
    assert.equal((await resolveMedia(await get(post.id))).url, null, "http não serve");
  });

  it("arte que não saiu (sem navegador) bloqueia; a imagem informada à mão vale no lugar da arte", async () => {
    creativeTestHooks.render = { browser: null };
    const post = await proposed("feed");
    const c = await creativeOf(post);
    assert.equal(c.status, "falhou");
    const { p, calls } = fakePublisher();
    const blocked = await approveAndPublish(post.id, "u", { now: () => NOW, publisher: p });
    assert.match(!blocked.ok ? blocked.error : "", /A arte não foi gerada/);
    assert.equal(calls.length, 0);

    const manual = "https://cdn.exemplo.com.br/aurora/limpeza.jpg";
    const { editPost } = await import("@/services/social/posts");
    assert.equal((await editPost(post.id, { image_url: manual }, NOW)).ok, true);
    const ok = await approveAndPublish(post.id, "u", { now: () => NOW, publisher: p });
    assert.equal(ok.ok, true, ok.ok ? "" : ok.error);
    assert.equal(calls[0]!.mediaUrl, manual);
  });

  it("dois cliques ao mesmo tempo publicam UMA vez e aprovam a arte uma vez", async () => {
    const post = await proposed("feed");
    const { p, calls } = fakePublisher();
    const [a, b] = await Promise.all([approveAndPublish(post.id, "u1", { now: () => NOW, publisher: p }), approveAndPublish(post.id, "u2", { now: () => NOW, publisher: p })]);
    assert.equal(calls.length, 1);
    assert.equal([a, b].filter((x) => x.ok).length, 1);
    assert.equal((await creativeOf(post)).status, "aprovado");
    assert.ok(await publicCreativeFile((await creativeOf(post)).token, "creative.png", NOW), "o segundo clique recusado não derruba a mídia da primeira");
  });

  it("arte adulterada depois da verificação não é publicada", async () => {
    const post = await proposed("feed");
    const c = await creativeOf(post);
    fs.writeFileSync(path.join(creativeDir(c.token), "creative.png"), Buffer.from("outra coisa"));
    const { p, calls } = fakePublisher();
    const r = await approveAndPublish(post.id, "u", { now: () => NOW, publisher: p });
    assert.match(!r.ok ? r.error : "", /mudou depois da verificação/);
    assert.equal(calls.length, 0);
  });

  it("a cota diária da API (content_publishing_limit) segura a publicação, sem incerteza", async () => {
    const post = await proposed("feed");
    const { p, calls } = fakePublisher({ quota: async () => ({ used: 100, total: 100 }) });
    const r = await approveAndPublish(post.id, "u", { now: () => NOW, publisher: p });
    assert.equal(r.ok, false);
    const after = await get(post.id);
    assert.equal(after.status, "falhou");
    assert.equal(after.uncertain, false);
    assert.match(after.error ?? "", /100 de 100/);
    assert.equal(calls.length, 0);
  });

  it("outro visual troca a arte (a anterior vai embora); recusar e expirar descartam a arte", async () => {
    const a = await proposed("feed");
    const first = await creativeOf(a);
    const r = await regeneratePostCreative(a.id, { now: () => NOW });
    assert.ok(r.ok);
    const second = await creativeOf(a);
    assert.notEqual(second.id, first.id);
    assert.equal((await agentRepo().get("creatives", first.id))!.status, "recusado");
    assert.equal(fs.existsSync(creativeDir(first.token)), false);
    assert.equal(await rejectPost(a.id, "u", NOW), true);
    assert.equal((await agentRepo().get("creatives", second.id))!.status, "recusado");
    assert.equal(fs.existsSync(creativeDir(second.token)), false);

    const b = await proposed("feed");
    assert.equal(await expireStalePosts(at(10 * 24 * 60)), 1);
    assert.equal((await creativeOf(b)).status, "recusado");
    assert.equal((await regeneratePostCreative(b.id)).ok, false, "post que não está pendente não troca de arte");
  });
});

describe("Aprovar e agendar: um post por clique", () => {
  const schedule = async (post: SocialPost, minutes = 60, over: Record<string, unknown> = {}) => approveAndSchedule(post.id, "user_owner", at(minutes), { now: () => NOW, ...over });

  it("recusa data inválida, sem hospedagem e sem mídia; nada muda no post", async () => {
    const post = await proposed("feed");
    assert.equal((await schedule(post, 2)).ok, false);
    assert.equal((await schedule(post, 31 * 24 * 60)).ok, false);
    delete process.env.PUBLIC_BASE_URL;
    const noHost = await schedule(post, 60);
    assert.match(!noHost.ok ? noHost.error : "", /hospedagem/);
    process.env.PUBLIC_BASE_URL = BASE;
    assert.equal((await get(post.id)).status, "pendente");
    assert.equal((await schedule({ ...post, id: "nao-existe" })).ok, false);
  });

  it("agenda: aprova a arte e o pedido, guarda o resumo do aprovado e não publica nada agora", async () => {
    const post = await proposed("reel");
    const { p, calls } = fakePublisher();
    const r = await schedule(post, 60);
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const s = await get(post.id);
    assert.equal(s.status, "agendado");
    assert.equal(s.scheduled_at, at(60).toISOString());
    assert.equal(s.approved_by, "user_owner");
    assert.equal(s.approved_digest?.length, 64);
    const c = await creativeOf(post);
    assert.equal(c.status, "aprovado");
    assert.ok(c.expires_at > at(60).toISOString(), "a mídia fica no ar até depois da hora marcada");
    assert.equal((await agentRepo().get("approvals", post.approval_id!))!.status, "aprovado");
    const early = await publishDueScheduled({ now: () => at(30), publisher: p });
    assert.deepEqual(early, { published: 0, failed: 0, late: 0, waiting: 1 });
    assert.equal(calls.length, 0);
    assert.equal((await schedule(post, 90)).ok, false, "já decidido: não agenda de novo");
  });

  it("na hora marcada o publicador publica UMA vez, com o formato e a mídia certos", async () => {
    const post = await proposed("story");
    await schedule(post, 60);
    const { p, calls } = fakePublisher();
    const due = at(61);
    const [a, b] = await Promise.all([publishDueScheduled({ now: () => due, publisher: p }), publishDueScheduled({ now: () => due, publisher: p })]);
    assert.equal(a.published + b.published, 1, "duas rodadas ao mesmo tempo, uma publicação");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.format, "story");
    assert.equal(calls[0]!.mediaUrl, `${BASE}/midia/${(await creativeOf(post)).token}/creative.png`);
    const done = await get(post.id);
    assert.equal(done.status, "publicado");
    assert.equal(done.idempotency_key, calls[0]!.idempotencyKey);
    assert.deepEqual(await publishDueScheduled({ now: () => at(120), publisher: p }), { published: 0, failed: 0, late: 0, waiting: 0 });
    assert.equal(calls.length, 1);
  });

  it("passou da janela de atraso: não publica fora de hora, avisa, e reabrir revoga a aprovação da arte", async () => {
    const post = await proposed("feed");
    await schedule(post, 60);
    const { p, calls } = fakePublisher();
    const report = await publishDueScheduled({ now: () => at(60 + 4 * 60), publisher: p });
    assert.equal(report.late, 1);
    assert.equal(calls.length, 0);
    const failed = await get(post.id);
    assert.equal(failed.status, "falhou");
    assert.equal(failed.uncertain, false);
    assert.match(failed.error ?? "", /janela de 3 h/);
    assert.ok(getDb().notifications.some((x) => x.title.includes("Post agendado não saiu")));
    assert.equal(await reopenFailedPost(post.id, NOW), true);
    assert.equal((await get(post.id)).status, "pendente");
    assert.equal((await get(post.id)).scheduled_at, null);
    assert.equal((await creativeOf(post)).status, "pendente");
    assert.equal(await publicCreativeFile((await creativeOf(post)).token, "creative.png", NOW), null, "voltou a não ser servida");
  });

  describe("o publicador reconfere tudo antes de sair", () => {
    const refused = async (tamper: (post: SocialPost) => Promise<void> | void, expected: RegExp, over: { noPublisher?: boolean; quotaFull?: boolean } = {}) => {
      const post = await proposed("feed");
      assert.ok((await schedule(post, 60)).ok);
      await tamper(post);
      const { p, calls } = fakePublisher(over.quotaFull ? { quota: async () => ({ used: 100, total: 100 }) } : {});
      const report = await publishDueScheduled({ now: () => at(61), publisher: over.noPublisher ? null : p });
      assert.equal(report.published, 0);
      assert.equal(report.failed, 1);
      assert.equal(calls.length, 0, "nada foi enviado ao Instagram");
      const after = await get(post.id);
      assert.equal(after.status, "falhou");
      assert.equal(after.uncertain, false);
      assert.match(after.error ?? "", expected);
    };

    it("legenda mudou depois da aprovação", () => refused(async (p) => void (await agentRepo().update("social_posts", p.id, { caption: `${p.caption} Compre já.` })), /mudou depois da sua aprovação/));
    it("data mudou depois da aprovação", () => refused(async (p) => void (await agentRepo().update("social_posts", p.id, { scheduled_at: at(30).toISOString() })), /mudou depois da sua aprovação/));
    it("o arquivo da arte mudou", () => refused(async (p) => fs.writeFileSync(path.join(creativeDir((await creativeOf(p)).token), "creative.png"), Buffer.from("adulterado")), /arquivo da arte mudou/));
    it("a arte deixou de estar aprovada", () => refused(async (p) => void (await agentRepo().update("creatives", (await creativeOf(p)).id, { status: "pendente" })), /deixou de estar aprovada/));
    it("a legenda passou a violar uma frase proibida do perfil", () => refused(() => void (getDb().company_profile.never_say = ["avaliação individual"]), /barreiras/));
    it("a hospedagem pública sumiu", () => refused(() => void delete process.env.PUBLIC_BASE_URL, /Sem hospedagem/));
    it("o Instagram deixou de estar configurado", () => refused(() => undefined, /não está configurado/, { noPublisher: true }));
    it("a cota diária da API acabou", () => refused(() => undefined, /100 de 100/, { quotaFull: true }));
  });

  it("cancelar o agendamento devolve o post ao 'pendente', revoga a arte e o publicador não o encontra; dá para agendar de novo", async () => {
    const post = await proposed("feed");
    await schedule(post, 60);
    assert.equal(await cancelSchedule(post.id, NOW), true);
    const back = await get(post.id);
    assert.deepEqual([back.status, back.scheduled_at, back.approved_by, back.approved_digest], ["pendente", null, null, null]);
    assert.equal((await agentRepo().get("approvals", post.approval_id!))!.status, "pendente");
    assert.equal((await creativeOf(post)).status, "pendente");
    const { p, calls } = fakePublisher();
    assert.deepEqual(await publishDueScheduled({ now: () => at(120), publisher: p }), { published: 0, failed: 0, late: 0, waiting: 0 });
    assert.equal(calls.length, 0);
    assert.equal(await cancelSchedule(post.id, NOW), false, "já não está agendado");
    assert.ok((await schedule(post, 90)).ok, "agenda de novo");
  });

  it("cancelar depois de o publicador reivindicar o post não vale (já está saindo)", async () => {
    const post = await proposed("feed");
    await schedule(post, 60);
    await agentRepo().update("social_posts", post.id, { status: "publicando" });
    assert.equal(await cancelSchedule(post.id, NOW), false);
  });

  it("agendar um post não toca nos outros: nunca em lote", async () => {
    const a = await proposed("feed");
    const b = await proposed("feed");
    await schedule(a, 60);
    assert.equal((await get(b.id)).status, "pendente");
    assert.equal((await creativeOf(b)).status, "pendente");
    assert.equal((await agentRepo().get("approvals", b.approval_id!))!.status, "pendente");
    const actions = fs.readFileSync(path.join(process.env.CRM_ROOT ?? process.cwd(), "src", "actions", "growth.ts"), "utf-8");
    const exported = [...actions.matchAll(/export async function (\w+)/g)].map((m) => m[1]!);
    assert.ok(exported.includes("scheduleSocialPost") && exported.includes("approveAndPublishPost"));
    assert.deepEqual(exported.filter((f) => /(Batch|Lote|Varios|Todos|All|Many|Bulk)/i.test(f)), [], "não existe ação em lote");
    assert.match(actions, /export async function scheduleSocialPost\(postId: string, when: string\)/, "recebe UM id e UMA data");
  });
});

describe("o runner só publica o agendado com o agente liberado", () => {
  const fetchLog: Array<{ method: string; url: string }> = [];
  let realFetch: typeof fetch;
  const state = () => ({ ticking: false, lastPlanAt: Date.now(), lastHousekeepingAt: Date.now() });

  beforeEach(() => {
    fetchLog.length = 0;
    process.env.INSTAGRAM_ACCESS_TOKEN = "token-de-teste-longo";
    process.env.INSTAGRAM_BUSINESS_ID = "17841400000000";
    realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
      const u = String(url);
      fetchLog.push({ method: init?.method ?? "GET", url: u });
      if (u.includes("content_publishing_limit")) return new Response(JSON.stringify({ data: [{ quota_usage: 1, config: { quota_total: 100 } }] }), { status: 200 });
      if (u.includes("/media_publish")) return new Response(JSON.stringify({ id: "9001" }), { status: 200 });
      if (u.endsWith("/media")) return new Response(JSON.stringify({ id: "creation-1" }), { status: 200 });
      return new Response(JSON.stringify({ permalink: "https://www.instagram.com/p/AA/" }), { status: 200 });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** Agenda um post de modo que, no relógio real, a hora já chegou (agendado 10 min atrás, há 5 min de tolerância mínima). */
  async function dueNow(): Promise<SocialPost> {
    const t0 = new Date(Date.now() - 20 * 60_000);
    const post = await proposePost({ topic: "Runner", caption: `${CAPTION} runner`, imageIdea: "arte", format: "feed", creative: { headline: "Limpeza de pele", body: "Procedimentos faciais.", cta: "Chame no direct" } }, t0);
    const r = await approveAndSchedule(post.id, "user_owner", new Date(t0.getTime() + 10 * 60_000), { now: () => t0 });
    assert.ok(r.ok, r.ok ? "" : r.error);
    return post;
  }
  const publishes = () => fetchLog.filter((c) => c.method === "POST" && /media_publish/.test(c.url)).length;

  it("modo 'pausado' e interruptor geral desligado seguram o agendado; liberado, ele sai uma vez", async () => {
    const post = await dueNow();

    await saveSettings("social-media", { mode: "pausado" });
    await runnerTick(state());
    assert.equal((await get(post.id)).status, "agendado", "agente pausado");
    assert.equal(publishes(), 0);

    await saveSettings("social-media", { mode: "aprovacao" });
    await setGloballyEnabled(false);
    await runnerTick(state());
    assert.equal((await get(post.id)).status, "agendado", "interruptor geral desligado");
    assert.equal(publishes(), 0);

    await setGloballyEnabled(true);
    await runnerTick(state());
    assert.equal((await get(post.id)).status, "publicado", "o seu clique de agendar já foi a aprovação");
    assert.equal(publishes(), 1);
    await runnerTick(state());
    assert.equal(publishes(), 1, "não repete");
  });

  it("a manutenção também expira propostas e reconcilia o que ficou preso", async () => {
    const stale = await proposed("feed", { now: new Date(Date.now() - 10 * 86_400_000) });
    const stuck = await proposed("feed", { now: NOW });
    await agentRepo().update("social_posts", stuck.id, { status: "publicando", updated_at: new Date(Date.now() - 30 * 60_000).toISOString() });
    const r = await runSocialMaintenance();
    assert.equal(r.expired >= 1, true);
    assert.equal(r.stuck, 1);
    assert.equal((await get(stale.id)).status, "expirado");
    const s = await get(stuck.id);
    assert.deepEqual([s.status, s.uncertain], ["falhou", true]);
  });
});

describe("publicador do Instagram: Feed, Reels e Stories", () => {
  const cfg = { token: "tok-secreto-123", businessId: "17841400000000", version: "v21.0" };

  it("cada formato monta o contêiner certo; Stories não levam legenda", () => {
    const base = { mediaUrl: "https://x.example.com/m", caption: "legenda" };
    assert.deepEqual(containerParams({ ...base, format: "feed" }), { image_url: base.mediaUrl, caption: "legenda" });
    assert.deepEqual(containerParams({ ...base, format: "reel" }), { media_type: "REELS", video_url: base.mediaUrl, caption: "legenda", share_to_feed: "true" });
    assert.deepEqual(containerParams({ ...base, format: "story" }), { media_type: "STORIES", image_url: base.mediaUrl });
  });

  function graph(statuses: string[], extra: Partial<Record<"publish" | "container", () => Response>> = {}) {
    const log: string[] = [];
    let polled = 0;
    const f = (async (url: URL | string, init?: RequestInit) => {
      const u = new URL(String(url));
      log.push(`${init?.method ?? "GET"} ${u.pathname}${u.searchParams.get("fields") ? `?${u.searchParams.get("fields")}` : ""}`);
      if (u.pathname.endsWith("/media_publish")) return extra.publish?.() ?? new Response(JSON.stringify({ id: "9001" }), { status: 200 });
      if (u.pathname.endsWith("/media")) return extra.container?.() ?? new Response(JSON.stringify({ id: "creation-1" }), { status: 200 });
      if (u.pathname.endsWith("/creation-1")) return new Response(JSON.stringify({ status_code: statuses[Math.min(polled++, statuses.length - 1)] }), { status: 200 });
      return new Response(JSON.stringify({ permalink: "https://www.instagram.com/reel/AA/" }), { status: 200 });
    }) as unknown as FetchLike;
    return { f, log };
  }
  const reel = { format: "reel" as const, mediaUrl: "https://x.example.com/v.mp4", caption: "legenda", idempotencyKey: "k" };

  it("Reels: espera o vídeo ficar FINISHED antes de publicar", async () => {
    const { f, log } = graph(["IN_PROGRESS", "IN_PROGRESS", "FINISHED"]);
    const sleeps: number[] = [];
    const res = await createInstagramPublisher(cfg, f, { pollMs: 7, sleep: async (ms) => void sleeps.push(ms) })!.publishMedia(reel);
    assert.deepEqual(res, { id: "9001", permalink: "https://www.instagram.com/reel/AA/" });
    assert.deepEqual(sleeps, [7, 7]);
    assert.equal(log.filter((l) => l.includes("creation-1")).length, 3);
    assert.ok(log.indexOf("POST /v21.0/17841400000000/media_publish") > log.lastIndexOf("GET /v21.0/creation-1?status_code,status"), "publica só depois de FINISHED");
  });

  it("Reels: vídeo recusado ou que não termina de processar NÃO publica e NÃO é incerteza", async () => {
    const bad = graph(["ERROR"]);
    await assert.rejects(() => createInstagramPublisher(cfg, bad.f, { sleep: async () => undefined })!.publishMedia(reel), (e: unknown) => e instanceof InstagramError && e.kind === "PERMANENT" && /não aceitou o vídeo/.test(e.message) && !e.uncertain);
    assert.ok(!bad.log.some((l) => l.includes("media_publish")));

    const slow = graph(["IN_PROGRESS"]);
    await assert.rejects(() => createInstagramPublisher(cfg, slow.f, { pollMs: 1, maxWaitMs: 30, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) })!.publishMedia(reel), (e: unknown) => e instanceof InstagramError && e.kind === "TEMPORARY" && !e.uncertain);
    assert.ok(!slow.log.some((l) => l.includes("media_publish")), "nada foi publicado");
  });

  it("só o timeout da publicação em si é incerto; Stories publicam sem esperar vídeo", async () => {
    const timeout = () => {
      const e = new Error("t");
      e.name = "TimeoutError";
      throw e;
    };
    const t = graph(["FINISHED"], { publish: timeout as unknown as () => Response });
    await assert.rejects(() => createInstagramPublisher(cfg, t.f, { sleep: async () => undefined })!.publishMedia(reel), (e: unknown) => e instanceof InstagramError && e.uncertain);
    const s = graph(["FINISHED"]);
    await createInstagramPublisher(cfg, s.f)!.publishMedia({ format: "story", mediaUrl: "https://x.example.com/i.png", caption: "x", idempotencyKey: "k" });
    assert.ok(!s.log.some((l) => l.includes("creation-1?")), "Stories não consultam o processamento");
  });

  it("lê a cota de publicações da API e devolve null quando não consegue", async () => {
    const ok = (async () => new Response(JSON.stringify({ data: [{ quota_usage: 12, config: { quota_total: 100 } }] }), { status: 200 })) as unknown as FetchLike;
    assert.deepEqual(await createInstagramPublisher(cfg, ok)!.quota(), { used: 12, total: 100 });
    const empty = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as FetchLike;
    assert.equal(await createInstagramPublisher(cfg, empty)!.quota(), null);
    const err = (async () => new Response(JSON.stringify({ error: { message: "x", code: 190 } }), { status: 400 })) as unknown as FetchLike;
    assert.equal(await createInstagramPublisher(cfg, err)!.quota(), null);
  });
});

describe("anúncios: a campanha só ativa com a imagem aprovada", () => {
  const draft = () => ({
    name: "Limpeza de pele — mensagens",
    headline: "Limpeza de pele",
    body: "Clínica de estética com procedimentos faciais e corporais, com avaliação individual.",
    cta: "Fale conosco pelo WhatsApp",
    audience: "Mulheres de 25 a 50 anos em Curitiba",
    daily_budget_cents: 1_000,
    start_date: "2026-10-13",
    end_date: null,
    landing_url: null,
    objective: "mensagens" as const,
  });
  const campaignWithArt = async () => {
    const c = await proposeCampaign(draft(), NOW, { builder: "modelos" });
    assert.ok(c.creative_id);
    await approveCampaignDraft(c.id, "u", NOW);
    return c;
  };

  it("proposta nasce com a imagem (1080×1080) pendente; ativar fica barrado até aprovar a imagem; depois é outro clique", async () => {
    const c = await campaignWithArt();
    const art = (await agentRepo().get("creatives", c.creative_id!))!;
    assert.deepEqual([art.format, art.width, art.height, art.status, art.owner_kind], ["anuncio", 1080, 1080, "pendente", "campaign"]);

    const blocked = await activateCampaign(c.id, "u", { now: NOW });
    assert.equal(blocked.ok, false);
    assert.match(!blocked.ok ? blocked.error : "", /Aprove o criativo/);
    assert.equal((await agentRepo().get("ad_campaigns", c.id))!.status, "aprovado", "nada ativou, nada gastou");
    assert.ok(getAgentData().events.some((e) => e.type === "campaign.blocked" && /criativo/.test(e.message)));

    assert.equal((await approveCampaignCreative(c.id, "u", NOW)).ok, true);
    assert.equal((await agentRepo().get("ad_campaigns", c.id))!.status, "aprovado", "aprovar a imagem NÃO ativa a campanha");
    const act = await activateCampaign(c.id, "u", { now: NOW });
    assert.equal(act.ok, true, act.ok ? "" : act.error);
  });

  it("imagem recusada, trocada por outra pendente, adulterada ou expirada barra a ativação", async () => {
    const c = await campaignWithArt();
    assert.equal(await rejectCampaignCreative(c.id, NOW), true);
    const rejected = await activateCampaign(c.id, "u", { now: NOW });
    assert.match(!rejected.ok ? rejected.error : "", /recusado/);

    const re = await regenerateCampaignCreative(c.id);
    assert.ok(re.ok);
    const pending = await activateCampaign(c.id, "u", { now: NOW });
    assert.match(!pending.ok ? pending.error : "", /Aprove o criativo/);
    await approveCampaignCreative(c.id, "u", NOW);

    const art = (await agentRepo().get("creatives", (await agentRepo().get("ad_campaigns", c.id))!.creative_id!))!;
    fs.writeFileSync(path.join(creativeDir(art.token), "creative.png"), Buffer.from("adulterado"));
    const tampered = await activateCampaign(c.id, "u", { now: NOW });
    assert.match(!tampered.ok ? tampered.error : "", /mudou depois da verificação/);
    assert.equal((await agentRepo().get("ad_campaigns", c.id))!.status, "aprovado");
  });

  it("campanha sem imagem (criada antes) não é afetada; recusar o rascunho descarta a imagem", async () => {
    const plain = await proposeCampaign(draft(), NOW);
    assert.equal(plain.creative_id, null);
    await approveCampaignDraft(plain.id, "u", NOW);
    assert.equal((await activateCampaign(plain.id, "u", { now: NOW })).ok, true);

    const c = await proposeCampaign({ ...draft(), name: "Outra campanha" }, NOW, { builder: "modelos" });
    const art = (await agentRepo().get("creatives", c.creative_id!))!;
    assert.equal(await rejectCampaignDraft(c.id, "u", NOW), true);
    assert.equal(fs.existsSync(creativeDir(art.token)), false);
    assert.equal((await approveCampaignCreative(c.id, "u", NOW)).ok, false, "campanha recusada não aprova imagem");
  });

  it("o agente propõe a campanha já com a imagem, sem ativar nada", async () => {
    await saveSettings("traffic-manager", { mode: "automatico" });
    await enqueueAgentTask({ agent: "traffic-manager", kind: "ads.propose", dedupeKey: "t:ads" });
    await runAgentQueue({ agents: ["traffic-manager"], budgetMs: 30_000 });
    const [campaign] = getAgentData().ad_campaigns;
    assert.ok(campaign?.creative_id, "a campanha nasceu com a imagem");
    assert.equal(campaign!.status, "pendente");
    assert.equal(getAgentData().creatives.filter((c) => c.status === "pendente").length, 1);
    assert.equal(trafficManager.direct, true);
  });
});

describe("a fronteira de ferramentas com criativos e agendamento", () => {
  it("agendar e aprovar o que sai da casa são só humanos; gerar arte é permitido (só renderiza dentro do CRM)", () => {
    assert.ok(HUMAN_ONLY_TOOLS.includes("instagram.schedule_media"));
    assert.ok(HUMAN_ONLY_TOOLS.includes("creatives.approve"));
    for (const [agent, tools] of Object.entries(AGENT_TOOLS)) for (const h of HUMAN_ONLY_TOOLS) assert.ok(!tools.includes(h), `${agent} recebeu ${h}`);
    assert.ok(AGENT_TOOLS["social-media"].includes("creatives.generate"));
    assert.ok(AGENT_TOOLS["traffic-manager"].includes("creatives.generate"));
  });

  it("só o serviço de posts importa o publicador, e o arquivo de leitura não sabe publicar nem consultar cota de publicação", () => {
    const root = path.join(process.env.CRM_ROOT ?? process.cwd(), "src");
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []));
    const importers = walk(root).filter((f) => /from "@\/services\/social\/instagram-publisher"/.test(fs.readFileSync(f, "utf-8"))).map((f) => path.relative(root, f).replace(/\\/g, "/"));
    assert.deepEqual(importers, ["services/social/posts.ts"]);
    // e quem chama publishDueScheduled/runSocialMaintenance: só o runner (que respeita o agente liberado)
    const callers = walk(root).filter((f) => /(publishDueScheduled|runSocialMaintenance)\(/.test(fs.readFileSync(f, "utf-8")) && !f.endsWith(`${path.sep}posts.ts`)).map((f) => path.relative(root, f).replace(/\\/g, "/"));
    assert.deepEqual(callers, ["services/agents/runner.ts"]);
  });
});

void fakeBrowser;
