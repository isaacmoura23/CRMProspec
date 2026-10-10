import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb } from "@/lib/store";
import {
  COPY_LIMITS,
  CREATIVE_SPECS,
  canMoveCreative,
  checkCreativeCopy,
  clipWords,
  creativeMediaUrl,
  firstSentence,
  isCreativeFile,
  isCreativeToken,
  pngSize,
  publicBaseUrl,
  servable,
  verifyCreativeHtml,
} from "@/lib/creative-policy";
import { isPublicPath } from "@/lib/auth-routes";
import { agentRepo, getAgentData, resetAgentRepoForTests } from "@/services/agents/repository";
import { approveCreative, copyFor, createCreative, creativeDir, creativeFor, creativeTestHooks, expireStaleCreatives, integrity, panelCreativeFile, publicCreativeFile, regenerateCreative, rejectCreative, retireCreative } from "@/services/creatives/engine";
import { measureArt, parseArtMeasure, renderPng } from "@/services/creatives/render";
import { parseRange } from "@/services/creatives/serve";
import { LOOKS, artHtml, artPalette, safeArea, videoScenes } from "@/services/creatives/templates";
import { buildFilterGraph, findFfmpeg, parseProbe, scenesToVideo, verifyVideoInfo, videoDuration, type ProbeInfo } from "@/services/creatives/video";
import type { BrowserRunner } from "@/services/sites/browser";
import { fakeBrowser, fakePng } from "./creative-fakes";
import { emptyAgentData, type CreativeFormat } from "@/types/agents";

const NOW = new Date("2026-10-12T12:00:00Z");
const COPY = { brand: "AtlasCode", headline: "Seu negócio no Google e no Instagram", body: "A gente cuida do site e das redes para você atender mais clientes.", cta: "Chame no direct" };
const FORMATS: CreativeFormat[] = ["feed", "story", "anuncio", "reel"];

describe("regras puras dos criativos", () => {
  it("cada formato tem as medidas do Instagram e do Meta", () => {
    assert.deepEqual(Object.fromEntries(Object.entries(CREATIVE_SPECS).map(([k, v]) => [k, [v.width, v.height, v.kind]])), {
      feed: [1080, 1350, "imagem"],
      story: [1080, 1920, "imagem"],
      reel: [1080, 1920, "video"],
      anuncio: [1080, 1080, "imagem"],
    });
    assert.deepEqual(safeArea("story"), { top: 250, bottom: 340, side: 84 }, "stories e reels deixam a interface do app livre");
    assert.equal(safeArea("feed").top, 84);
  });

  it("corta o texto em fim de palavra e pega a primeira frase", () => {
    assert.equal(clipWords("uma frase comprida que precisa ser cortada em fim de palavra", 20), "uma frase comprida");
    assert.equal(clipWords("curta", 20), "curta");
    assert.equal(firstSentence("Primeira frase. Segunda frase."), "Primeira frase.");
    assert.equal(firstSentence("Sem ponto final"), "Sem ponto final");
    const c = copyFor({ headline: "x".repeat(200), body: "Texto. Outro texto.", cta: "Fale conosco pelo WhatsApp agora mesmo hoje" }, "Empresa");
    assert.ok(c.headline.length <= COPY_LIMITS.headline && c.cta.length <= COPY_LIMITS.cta);
    assert.equal(c.body, "Texto.");
  });

  it("barra variável, link, promessa, frase proibida e texto grande", () => {
    assert.equal(checkCreativeCopy(COPY, []), null);
    assert.match(checkCreativeCopy({ ...COPY, headline: "Olá {{nome}}" })!, /variável/);
    assert.match(checkCreativeCopy({ ...COPY, body: "Veja em https://x.com" })!, /link/);
    assert.match(checkCreativeCopy({ ...COPY, headline: "Resultado garantido para você" })!, /Promessa/);
    assert.match(checkCreativeCopy({ ...COPY, cta: "Barato demais agora" }, ["barato demais"])!, /proibida/);
    assert.match(checkCreativeCopy({ ...COPY, headline: "a" })!, /título/);
    assert.match(checkCreativeCopy({ ...COPY, body: "x".repeat(COPY_LIMITS.body + 1) })!, /longo/);
  });

  it("a máquina de estados: aprovado só vem de pendente, e o resto é final", () => {
    assert.equal(canMoveCreative("pendente", "aprovado"), true);
    assert.equal(canMoveCreative("recusado", "aprovado"), false);
    assert.equal(canMoveCreative("falhou", "aprovado"), false);
    assert.equal(canMoveCreative("expirado", "aprovado"), false);
    assert.equal(canMoveCreative("aprovado", "recusado"), false);
    assert.equal(canMoveCreative("aprovado", "pendente"), true, "revogar a aprovação (cancelou o agendamento)");
  });

  it("endereço público: só https fora de faixa interna; sem ele, 'sem hospedagem'", () => {
    assert.equal(publicBaseUrl({}), null);
    assert.equal(publicBaseUrl({ PUBLIC_BASE_URL: "http://meu-site.com" }), null, "http não serve ao Instagram");
    assert.equal(publicBaseUrl({ PUBLIC_BASE_URL: "https://localhost:3000" }), null);
    assert.equal(publicBaseUrl({ PUBLIC_BASE_URL: "https://192.168.0.5" }), null);
    assert.equal(publicBaseUrl({ PUBLIC_BASE_URL: "https://user:pw@meu-site.com" }), null);
    assert.equal(publicBaseUrl({ PUBLIC_BASE_URL: "https://meu-tunel.example.com/" }), "https://meu-tunel.example.com");
    const t = "a".repeat(48);
    assert.equal(creativeMediaUrl({ token: t, kind: "imagem" }, { PUBLIC_BASE_URL: "https://x.example.com" }), `https://x.example.com/midia/${t}/creative.png`);
    assert.equal(creativeMediaUrl({ token: t, kind: "video" }, { PUBLIC_BASE_URL: "https://x.example.com" }), `https://x.example.com/midia/${t}/creative.mp4`);
    assert.equal(creativeMediaUrl({ token: t, kind: "video" }, {}), null);
  });

  it("só serve criativo aprovado e dentro do prazo; nome de arquivo e token têm formato fixo", () => {
    const future = new Date(NOW.getTime() + 1000).toISOString();
    assert.equal(servable({ status: "aprovado", expires_at: future }, NOW), true);
    assert.equal(servable({ status: "pendente", expires_at: future }, NOW), false);
    assert.equal(servable({ status: "aprovado", expires_at: NOW.toISOString() }, NOW), false);
    assert.equal(isCreativeToken("a".repeat(48)), true);
    assert.equal(isCreativeToken("../../etc/passwd"), false);
    assert.equal(isCreativeFile("creative.png"), true);
    assert.equal(isCreativeFile("../creative.png"), false);
    assert.equal(isPublicPath("/midia/abc/creative.png"), true, "o Instagram busca sem sessão");
    assert.equal(isPublicPath("/api/criativos/x/creative.png"), false, "o painel exige sessão");
  });

  it("lê o tamanho do PNG pelo cabeçalho e recusa o que não é PNG", () => {
    assert.deepEqual(pngSize(fakePng(1080, 1350)), { width: 1080, height: 1350 });
    assert.equal(pngSize(Buffer.from("não sou png, só texto comprido o bastante")), null);
    assert.equal(pngSize(Buffer.alloc(4)), null);
  });
});

describe("a verificação do HTML da arte é independente do modelo", () => {
  const spec = CREATIVE_SPECS.feed;
  const good = artHtml({ format: "feed", copy: COPY, variant: 0 });
  const failing = (html: string) => verifyCreativeHtml(html, COPY, spec).filter((c) => !c.ok).map((c) => c.name);

  it("os modelos de arte passam em todos os formatos e composições, só com o texto recebido", () => {
    for (const format of FORMATS) {
      for (let variant = 0; variant < LOOKS; variant++) {
        for (const scene of format === "reel" ? videoScenes(COPY) : (["all"] as const)) {
          const html = artHtml({ format, copy: COPY, variant, scene });
          assert.deepEqual(verifyCreativeHtml(html, COPY, CREATIVE_SPECS[format]).filter((c) => !c.ok), [], `${format}/${variant}/${scene}`);
        }
      }
    }
  });

  it("pega script, imagem, link, iframe, recurso externo, evento e palavra inventada", () => {
    assert.ok(failing(good.replace("</body>", "<script>alert(1)</script></body>")).includes("sem código nem recurso externo"));
    assert.ok(failing(good.replace("</body>", '<img src="x.png"></body>')).includes("sem código nem recurso externo"));
    assert.ok(failing(good.replace("</body>", '<iframe src="https://x"></iframe></body>')).includes("sem código nem recurso externo"));
    assert.ok(failing(good.replace("<style>", "<style>@import url(https://f.com/a.css);")).includes("sem código nem recurso externo"));
    assert.ok(failing(good.replace('<div class="art">', '<div class="art" onclick="x()">')).includes("sem código nem recurso externo"));
    assert.ok(failing(good.replace("</body>", '<a href="https://x.com">x</a></body>')).includes("sem links"));
    assert.ok(failing(good.replace("</h1>", " incrível e barato</h1>")).includes("texto só do que a empresa disse"));
    assert.ok(failing(good.split("width:1080px").join("width:900px")).includes("tamanho da tela da arte"));
    assert.deepEqual(failing(good), []);
  });

  it("gradiente SVG com url(#id) é permitido: só referência interna", () => {
    const withGradient = artHtml({ format: "feed", copy: COPY, variant: 2 });
    assert.match(withGradient, /url\(#g\)/);
    assert.deepEqual(failing(withGradient.replace(/url\(#g\)/, "url(#g)")), failing(good));
  });

  it("as cores da marca dão contraste com texto branco (mínimo 3:1) para qualquer nome", () => {
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    for (const name of ["AtlasCode", "Padaria do Zé", "Clínica Aurora", "X", "Estética & Beleza Marina", "Amarelo Ouro", "Verde Limão 99", "Oficina Mecânica Silva"]) {
      const p = artPalette(name);
      assert.ok(1.05 / (lum(p.primary) + 0.05) >= 3, `${name}: ${p.primary}`);
      assert.ok((lum(p.light) + 0.05) / (lum(p.ink) + 0.05) >= 4.5, `${name}: detalhe claro sobre fundo escuro`);
    }
  });

  it("o vídeo tem abertura, apoio (só se há texto) e chamada", () => {
    assert.deepEqual(videoScenes(COPY), ["hook", "body", "cta"]);
    assert.deepEqual(videoScenes({ ...COPY, body: "" }), ["hook", "cta"]);
    const cta = artHtml({ format: "reel", copy: COPY, variant: 0, scene: "cta" });
    assert.ok(cta.includes("Chame no direct") && !cta.includes("Seu negócio no Google"), "a cena de chamada não repete o título");
  });
});

describe("renderizar e medir a arte", () => {
  const spec = CREATIVE_SPECS.feed;
  const html = artHtml({ format: "feed", copy: COPY, variant: 0 });

  it("grava um PNG do tamanho exato e confere o arquivo", async () => {
    const log: string[][] = [];
    const r = await renderPng(html, spec, { browser: "fake", run: fakeBrowser({}, log) });
    assert.ok(r.png && r.checks.every((c) => c.ok), JSON.stringify(r.checks));
    assert.deepEqual(pngSize(r.png!), { width: 1080, height: 1350 });
    assert.ok(log[0]!.includes("--force-device-scale-factor=1") && log[0]!.includes("--window-size=1080,1350") && log[0]!.some((a) => a.startsWith("file:")), "só arquivo local, em escala 1");
  });

  it("dimensão errada ou arquivo vazio reprovam; sem navegador diz o que faltou", async () => {
    const wrong: BrowserRunner = async (_b, args) => {
      fs.writeFileSync(args.find((a) => a.startsWith("--screenshot="))!.slice(13), fakePng(800, 600));
      return { stdout: "", stderr: "", code: 0 };
    };
    const r = await renderPng(html, spec, { browser: "fake", run: wrong });
    assert.equal(r.checks.find((c) => c.name === "dimensões da arte")!.ok, false);
    const none = await renderPng(html, spec, { browser: "fake", run: async () => ({ stdout: "", stderr: "", code: 1 }) });
    assert.equal(none.png, null);
    const no = await renderPng(html, spec, { browser: null });
    assert.match(no.checks[0]!.detail, /Chrome ou Edge/);
  });

  it("a medição reprova texto fora da tela, sob a interface do app, console e contraste", async () => {
    const ok = await measureArt(html, spec, safeArea("feed"), { browser: "fake", run: fakeBrowser() });
    assert.ok(ok.every((c) => c.ok), JSON.stringify(ok.filter((c) => !c.ok)));
    const bad = await measureArt(html, spec, safeArea("feed"), { browser: "fake", run: fakeBrowser({ outside: ["h1: Seu negócio"], edge: ["p: apoio"], errors: ["boom"], lowContrast: ["span: marca"], sh: 1500 }) });
    const failed = bad.filter((c) => !c.ok).map((c) => c.name);
    for (const n of ["sem erro de console", "arte cabe na tela", "texto na margem de segurança", "texto legível (contraste)"]) assert.ok(failed.includes(n), n);
    const dead = await measureArt(html, spec, safeArea("feed"), { browser: "fake", run: async () => ({ stdout: "<html></html>", stderr: "", code: 0 }) });
    assert.equal(dead[0]!.ok, false);
    assert.equal(parseArtMeasure("<title>outra coisa</title>"), null);
  });
});

describe("vídeo (ffmpeg)", () => {
  const spec = CREATIVE_SPECS.reel;

  it("o grafo costura N cenas com zoom lento e transição suave, no tempo certo", () => {
    const g = buildFilterGraph(3, spec);
    assert.equal((g.match(/zoompan/g) ?? []).length, 3);
    assert.equal((g.match(/xfade/g) ?? []).length, 2);
    assert.match(g, /offset=3\b/, "a primeira transição começa depois de uma cena");
    assert.match(g, /offset=6\b/);
    assert.match(g, /format=yuv420p\[vout\]/);
    assert.equal(videoDuration(3), 9.5);
    assert.equal(videoDuration(2), 6.5);
  });

  it("acha o ffmpeg e o ffprobe juntos, por FFMPEG_PATH ou pelo PATH", () => {
    const exe = (n: string) => (process.platform === "win32" ? `${n}.exe` : n);
    const has = new Set([path.join("/v", exe("ffmpeg")), path.join("/v", exe("ffprobe")), path.join("/w", exe("ffmpeg"))]);
    assert.deepEqual(findFfmpeg({ FFMPEG_PATH: path.join("/v", exe("ffmpeg")) }, (p) => has.has(p)), { ffmpeg: path.join("/v", exe("ffmpeg")), ffprobe: path.join("/v", exe("ffprobe")) });
    assert.equal(findFfmpeg({ PATH: "/w" }, (p) => has.has(p)), null, "sem o ffprobe junto não serve");
    assert.equal(findFfmpeg({ PATH: "" }, () => false), null);
  });

  it("chama o ffmpeg com H.264 yuv420p, áudio mudo e o grafo inline", async () => {
    let seen: string[] = [];
    const run: BrowserRunner = async (_b, args) => {
      seen = args;
      fs.writeFileSync(args[args.length - 1]!, Buffer.alloc(50_000, 1));
      return { stdout: "", stderr: "", code: 0 };
    };
    const out = path.join(os.tmpdir(), `atlas-test-${Date.now()}.mp4`);
    const err = await scenesToVideo(["a.png", "b.png", "c.png"], spec, out, { bins: { ffmpeg: "ffmpeg", ffprobe: "ffprobe" }, run });
    fs.rmSync(out, { force: true });
    assert.equal(err, null);
    const j = seen.join(" ");
    assert.ok(seen.includes("-filter_complex") && !seen.includes("-filter_complex_script"));
    assert.ok(/-c:v libx264/.test(j) && /-pix_fmt yuv420p/.test(j) && /-movflags \+faststart/.test(j) && /anullsrc/.test(j) && /-c:a aac/.test(j));
    assert.equal(seen.filter((a) => a === "-i").length, 4, "3 cenas + a faixa muda");
    assert.match((await scenesToVideo(["a.png"], spec, out, { bins: { ffmpeg: "f", ffprobe: "p" }, run }))!, /duas cenas/);
    assert.match((await scenesToVideo(["a.png", "b.png"], spec, out, { bins: null }))!, /ffmpeg não encontrado/);
    const failRun: BrowserRunner = async () => ({ stdout: "", stderr: "Unrecognized option", code: 1 });
    assert.match((await scenesToVideo(["a.png", "b.png"], spec, out, { bins: { ffmpeg: "f", ffprobe: "p" }, run: failRun }))!, /ffmpeg falhou: Unrecognized/);
  });

  it("lê o ffprobe e confere o arquivo de fato", () => {
    const probe = JSON.stringify({ streams: [{ codec_type: "video", codec_name: "h264", width: 1080, height: 1920, pix_fmt: "yuv420p", r_frame_rate: "30/1" }, { codec_type: "audio", codec_name: "aac" }], format: { duration: "9.5" } });
    const good = parseProbe(probe, 600_000)!;
    assert.ok(verifyVideoInfo(good, spec).every((c) => c.ok));
    const bad = (over: Partial<ProbeInfo>) => verifyVideoInfo({ ...good, ...over }, spec).filter((c) => !c.ok).map((c) => c.name);
    assert.deepEqual(bad({ duration: 2 }), ["duração do vídeo"]);
    assert.deepEqual(bad({ duration: 95 }), ["duração do vídeo"]);
    assert.deepEqual(bad({ audio: null }), ["faixa de áudio"]);
    assert.deepEqual(bad({ bytes: 200 * 1024 * 1024 }), ["peso do vídeo"]);
    assert.deepEqual(bad({ video: { ...good.video!, codec: "vp9" } }), ["codec H.264"]);
    assert.deepEqual(bad({ video: { ...good.video!, width: 720 } }), ["dimensões do vídeo"]);
    assert.deepEqual(bad({ video: { ...good.video!, fps: 12 } }), ["quadros por segundo"]);
    assert.equal(verifyVideoInfo(null, spec)[0]!.ok, false);
    assert.equal(parseProbe("{quebrado", 1), null);
  });
});

/* ------------------------------------------------------------------ */
/* O motor                                                             */
/* ------------------------------------------------------------------ */

let tmp: string;
function reset() {
  resetAgentRepoForTests();
  Object.assign(getAgentData(), emptyAgentData());
  getDb().company_profile.company_name = "AtlasCode";
  getDb().company_profile.never_say = [];
}

beforeEach(() => {
  reset();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-creatives-"));
  process.env.CREATIVES_DIR = path.join(tmp, "creatives");
  process.env.CREATIVE_WORK_DIR = path.join(tmp, "work");
  creativeTestHooks.render = { browser: "fake", run: fakeBrowser() };
});
afterEach(() => {
  delete process.env.CREATIVES_DIR;
  delete process.env.CREATIVE_WORK_DIR;
  creativeTestHooks.render = undefined;
  creativeTestHooks.video = undefined;
  creativeTestHooks.claude = undefined;
  creativeTestHooks.claudeAvailable = undefined;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const input = (over: Record<string, unknown> = {}) => ({ ownerKind: "post" as const, ownerId: "spost_1", format: "feed" as CreativeFormat, headline: COPY.headline, body: COPY.body, cta: COPY.cta, ...over });

describe("criar o criativo", () => {
  it("imagem: gera, verifica, grava com resumo SHA-256 e deixa pendente (nada servido ainda)", async () => {
    const c = await createCreative(input(), { now: () => NOW });
    assert.equal(c.status, "pendente");
    assert.equal(c.kind, "imagem");
    assert.deepEqual([c.width, c.height], [1080, 1350]);
    assert.deepEqual(c.files, ["creative.png"]);
    assert.equal(c.content_hash?.length, 64);
    assert.ok(c.checks.length >= 10 && c.checks.every((x) => x.ok));
    assert.ok(fs.existsSync(path.join(creativeDir(c.token), "creative.png")));
    assert.equal(c.builder, "modelos");
    assert.equal(await publicCreativeFile(c.token, "creative.png", NOW), null, "antes do clique não sai da casa");
    assert.ok((await panelCreativeFile(c.id, "creative.png"))!.size > 4_000, "o painel vê a prévia");
    assert.equal((await creativeFor("post", "spost_1"))!.id, c.id);
    assert.ok(getAgentData().events.some((e) => e.type === "creative.ready"));
  });

  it("vídeo: cenas verificadas, ffmpeg, ffprobe, decodificação e capa; registra a duração", async () => {
    const probe = JSON.stringify({ streams: [{ codec_type: "video", codec_name: "h264", width: 1080, height: 1920, pix_fmt: "yuv420p", r_frame_rate: "30/1" }, { codec_type: "audio", codec_name: "aac" }], format: { duration: "9.5" } });
    const calls: string[] = [];
    creativeTestHooks.video = {
      bins: { ffmpeg: "ffmpeg", ffprobe: "ffprobe" },
      run: async (bin, args) => {
        calls.push(`${bin}:${args.includes("-show_entries") ? "probe" : args.includes("-f") && args.includes("null") ? "decode" : args.includes("-frames:v") ? "poster" : "encode"}`);
        if (bin === "ffprobe") return { stdout: probe, stderr: "", code: 0 };
        const out = args[args.length - 1]!;
        if (out.endsWith(".mp4")) fs.writeFileSync(out, Buffer.alloc(300_000, 2));
        if (out.endsWith(".png")) fs.writeFileSync(out, fakePng(1080, 1920, 20_000));
        return { stdout: "", stderr: "", code: 0 };
      },
    };
    const c = await createCreative(input({ format: "reel" }), { now: () => NOW });
    assert.equal(c.status, "pendente", c.error ?? "");
    assert.equal(c.kind, "video");
    assert.equal(c.duration_s, 9.5);
    assert.deepEqual(c.files.sort(), ["creative.mp4", "poster.png"]);
    assert.deepEqual(calls, ["ffmpeg:encode", "ffprobe:probe", "ffmpeg:decode", "ffmpeg:poster"]);
    assert.ok(c.checks.some((x) => x.name === "cena 3: texto só do que a empresa disse" && x.ok), "cada cena foi verificada");
    assert.ok(c.checks.some((x) => x.name === "codec H.264" && x.ok));
  });

  it("sem navegador, sem ffmpeg ou texto reprovado: registra 'falhou' com o motivo, sem arquivos", async () => {
    creativeTestHooks.render = { browser: null };
    const noBrowser = await createCreative(input(), { now: () => NOW });
    assert.equal(noBrowser.status, "falhou");
    assert.match(noBrowser.error ?? "", /Verificação reprovada/);
    assert.ok(noBrowser.checks.some((c) => /Chrome ou Edge/.test(c.detail)));
    assert.equal(fs.existsSync(creativeDir(noBrowser.token)), false);

    creativeTestHooks.render = { browser: "fake", run: fakeBrowser() };
    creativeTestHooks.video = { bins: null };
    const noFfmpeg = await createCreative(input({ format: "reel", ownerId: "spost_2" }), { now: () => NOW });
    assert.equal(noFfmpeg.status, "falhou");
    assert.match(noFfmpeg.error ?? "", /ffmpeg não encontrado/);

    const promise = await createCreative(input({ headline: "Resultado garantido em 7 dias", ownerId: "spost_3" }), { now: () => NOW });
    assert.equal(promise.status, "falhou");
    assert.match(promise.error ?? "", /Promessa/);

    getDb().company_profile.never_say = ["atender mais clientes"];
    const banned = await createCreative(input({ ownerId: "spost_4" }), { now: () => NOW });
    assert.equal(banned.status, "falhou");
    assert.match(banned.error ?? "", /proibida/);
  });

  it("a medição reprovada (texto estourando, contraste) não entrega a arte", async () => {
    creativeTestHooks.render = { browser: "fake", run: fakeBrowser({ outside: ["h1: Seu negócio"], lowContrast: ["p: apoio"] }) };
    const c = await createCreative(input(), { now: () => NOW });
    assert.equal(c.status, "falhou");
    assert.match(c.error ?? "", /arte cabe na tela/);
    assert.equal(fs.existsSync(creativeDir(c.token)), false, "nenhum arquivo");
  });
});

describe("aprovar, recusar, expirar e servir", () => {
  it("aprovar libera a mídia (e só ela, só dentro do prazo); duas aprovações não duplicam", async () => {
    const c = await createCreative(input(), { now: () => NOW });
    const keep = new Date(NOW.getTime() + 5 * 86_400_000);
    const r = await approveCreative(c.id, "user_1", { keepUntil: keep, now: NOW });
    assert.ok(r.ok);
    assert.equal(r.ok && r.creative.status, "aprovado");
    assert.equal(r.ok && r.creative.expires_at, keep.toISOString());
    const f = (await publicCreativeFile(c.token, "creative.png", NOW))!;
    assert.equal(f.type, "image/png");
    assert.equal(await publicCreativeFile(c.token, "creative.mp4", NOW), null, "arquivo que não existe neste criativo");
    assert.equal(await publicCreativeFile(c.token, "../creative.png", NOW), null);
    assert.equal(await publicCreativeFile("b".repeat(48), "creative.png", NOW), null);
    assert.equal(await publicCreativeFile(c.token, "creative.png", new Date(keep.getTime() + 1)), null, "depois do prazo some");
    assert.ok((await approveCreative(c.id, "user_2", { now: NOW })).ok, "idempotente");
    assert.equal((await agentRepo().get("creatives", c.id))!.approved_by, "user_1");
  });

  it("arquivo adulterado ou sumido depois da verificação não é aprovado", async () => {
    const a = await createCreative(input(), { now: () => NOW });
    fs.writeFileSync(path.join(creativeDir(a.token), "creative.png"), fakePng(1080, 1350, 9_000).fill(9, 40));
    const r = await approveCreative(a.id, "u", { now: NOW });
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /mudou depois da verificação/);
    assert.equal(integrity(a).ok, false);

    const b = await createCreative(input({ ownerId: "spost_9" }), { now: () => NOW });
    fs.rmSync(creativeDir(b.token), { recursive: true, force: true });
    const gone = await approveCreative(b.id, "u", { now: NOW });
    assert.equal(gone.ok, false);
    assert.match(!gone.ok ? gone.error : "", /não existe mais/);
    assert.equal(integrity(b).ok, false);
  });

  it("recusar descarta os arquivos; falhou, recusado e expirado não aprovam", async () => {
    const c = await createCreative(input(), { now: () => NOW });
    assert.equal(await rejectCreative(c.id, NOW), true);
    assert.equal(fs.existsSync(creativeDir(c.token)), false);
    assert.equal((await approveCreative(c.id, "u", { now: NOW })).ok, false);
    assert.equal(await rejectCreative(c.id, NOW), false, "já decidido");
    assert.equal(await rejectCreative("nao-existe", NOW), false);
  });

  it("proposta sem decisão expira com os arquivos; aprovada vence no prazo da mídia", async () => {
    const a = await createCreative(input(), { now: () => NOW });
    const later = new Date(NOW.getTime() + 8 * 86_400_000);
    assert.equal((await approveCreative(a.id, "u", { now: later })).ok, false, "pendente passou de 7 dias");
    assert.equal((await agentRepo().get("creatives", a.id))!.status, "expirado");

    const b = await createCreative(input({ ownerId: "spost_5" }), { now: () => NOW });
    await approveCreative(b.id, "u", { keepUntil: new Date(NOW.getTime() + 86_400_000), now: NOW });
    const c = await createCreative(input({ ownerId: "spost_6" }), { now: () => NOW });
    assert.equal(await expireStaleCreatives(new Date(NOW.getTime() + 2 * 86_400_000)), 1, "só a aprovada vencida; a pendente ainda vale");
    assert.equal(fs.existsSync(creativeDir(b.token)), false);
    assert.equal(fs.existsSync(creativeDir(c.token)), true);
  });

  it("outro visual: a composição muda, a anterior é descartada, o dono mantém um criativo vivo", async () => {
    const a = await createCreative(input(), { now: () => NOW });
    const b = (await regenerateCreative(a.id, { now: () => NOW }))!;
    assert.notEqual(b.id, a.id);
    assert.equal(b.variant, (a.variant + 1) % LOOKS);
    assert.equal((await agentRepo().get("creatives", a.id))!.status, "recusado");
    assert.equal(fs.existsSync(creativeDir(a.token)), false);
    assert.equal((await creativeFor("post", "spost_1"))!.id, b.id);
    await approveCreative(b.id, "u", { now: NOW });
    assert.equal(await regenerateCreative(b.id, { now: () => NOW }), null, "aprovado não se troca");
    await retireCreative(b.id, NOW);
    assert.equal((await agentRepo().get("creatives", b.id))!.status, "expirado");
    assert.equal(fs.existsSync(creativeDir(b.token)), false);
  });
});

describe("arte escrita pelo Claude Code (modo restrito)", () => {
  const withClaude = (writer: (html: string, n: number) => string, opts: { fail?: boolean } = {}) => {
    const calls: Array<{ prompt: string; tools: string[]; cwd: string; budget: number }> = [];
    let original = "";
    creativeTestHooks.claudeAvailable = true;
    creativeTestHooks.claude = async (req) => {
      const n = calls.length;
      calls.push({ prompt: req.prompt, tools: req.tools ?? [], cwd: req.cwd, budget: req.budgetUsd });
      if (opts.fail) return { ok: false, result: "", costUsd: 0.1, durationMs: 1, error: "passou do tempo", timedOut: true };
      const file = path.join(req.cwd, "arte.html");
      original ||= fs.readFileSync(file, "utf8");
      assert.ok(fs.existsSync(path.join(req.cwd, "copia.json")) && fs.existsSync(path.join(req.cwd, "BRIEF.md")) && fs.existsSync(path.join(req.cwd, "formato.json")));
      fs.writeFileSync(file, writer(original, n), "utf8");
      return { ok: true, result: "pronto", costUsd: 0.2, durationMs: 1, error: null, timedOut: false };
    };
    return calls;
  };

  it("a arte do Claude Code passa pela MESMA verificação e é a que vai ao arquivo", async () => {
    const calls = withClaude((h) => h.replace("</style>", ".art{filter:none}</style>"));
    const c = await createCreative(input({ builder: "claude-code", claudeBudgetUsd: 0.5 }), { now: () => NOW });
    assert.equal(c.status, "pendente", c.error ?? "");
    assert.equal(c.builder, "claude-code");
    assert.deepEqual(calls[0]!.tools, ["Read", "Write", "Edit", "Glob", "Grep"]);
    assert.ok(c.checks.some((x) => x.name === "construtor Claude Code" && /1 rodada/.test(x.detail)));
    assert.ok(c.checks.some((x) => x.name === "texto só do que a empresa disse" && x.ok));
    assert.equal(fs.existsSync(path.join(tmp, "work", c.id)), false, "a pasta de trabalho não fica para trás");
  });

  it("palavra inventada ou script: recebe a lista do que falhou e corrige; sem corrigir, cai para o modelo", async () => {
    const bad = (h: string) => h.replace("</h1>", " incrível e barato</h1>").replace("</body>", "<script>1</script></body>");
    const fixed = withClaude((h, n) => (n === 0 ? bad(h) : h));
    const ok = await createCreative(input({ builder: "claude-code" }), { now: () => NOW });
    assert.equal(ok.builder, "claude-code");
    assert.equal(fixed.length, 2);
    assert.match(fixed[1]!.prompt, /texto só do que a empresa disse/);
    assert.match(fixed[1]!.prompt, /sem código nem recurso externo/);

    const never = withClaude((h) => bad(h));
    const fell = await createCreative(input({ builder: "claude-code", ownerId: "spost_7" }), { now: () => NOW });
    assert.equal(fell.status, "pendente", fell.error ?? "");
    assert.equal(fell.builder, "modelos");
    assert.equal(never.length, 2, "1 escrita + 1 correção");
    assert.ok(fell.checks.some((x) => x.name === "construtor Claude Code" && /Não entregue/.test(x.detail)));
  });

  it("Claude Code ausente ou com falha: sai o modelo de arte, sem travar", async () => {
    creativeTestHooks.claudeAvailable = false;
    creativeTestHooks.claude = async () => {
      throw new Error("não deveria ser chamado");
    };
    const absent = await createCreative(input({ builder: "claude-code" }), { now: () => NOW });
    assert.equal(absent.status, "pendente");
    assert.equal(absent.builder, "modelos");
    withClaude((h) => h, { fail: true });
    const failed = await createCreative(input({ builder: "claude-code", ownerId: "spost_8" }), { now: () => NOW });
    assert.equal(failed.builder, "modelos");
    assert.ok(failed.checks.some((x) => /passou do tempo/.test(x.detail)));
  });
});

describe("servir a mídia por faixas (Range)", () => {
  it("lê o cabeçalho Range sem passar do arquivo", () => {
    assert.equal(parseRange(null, 100), null);
    assert.deepEqual(parseRange("bytes=0-9", 100), { start: 0, end: 9 });
    assert.deepEqual(parseRange("bytes=90-", 100), { start: 90, end: 99 });
    assert.deepEqual(parseRange("bytes=-10", 100), { start: 90, end: 99 });
    assert.deepEqual(parseRange("bytes=50-500", 100), { start: 50, end: 99 });
    assert.equal(parseRange("bytes=100-110", 100), "invalido");
    assert.equal(parseRange("bytes=9-3", 100), "invalido");
    assert.equal(parseRange("bytes=-", 100), "invalido");
    assert.equal(parseRange("items=0-1", 100), "invalido");
  });
});
