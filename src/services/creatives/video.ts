import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VIDEO_LIMITS, type CreativeSpec } from "@/lib/creative-policy";
import { runBrowser, type BrowserRunner } from "@/services/sites/browser";
import type { SiteCheck } from "@/types/agents";

/**
 * Vídeo como motion graphics: cenas em PNG (renderizadas pelo navegador) costuradas pelo ffmpeg
 * com zoom lento e transições suaves, em H.264 (yuv420p) com uma faixa de áudio muda — o formato
 * que o Instagram aceita para Reels. Sem API de geração, sem imagem de terceiros, sem música.
 * Renderizar quadro a quadro no navegador seria lento demais; o movimento vem do ffmpeg.
 */

export type ProcRunner = BrowserRunner;

export interface FfmpegBins {
  ffmpeg: string;
  ffprobe: string;
}

/** Procura o ffmpeg e o ffprobe: `FFMPEG_PATH` (o executável do ffmpeg) ou o PATH. */
export function findFfmpeg(env: Record<string, string | undefined> = process.env, exists: (p: string) => boolean = fs.existsSync): FfmpegBins | null {
  const exe = (n: string) => (process.platform === "win32" ? `${n}.exe` : n);
  const dirs = [env.FFMPEG_PATH ? path.dirname(env.FFMPEG_PATH) : null, ...(env.PATH ?? env.Path ?? "").split(path.delimiter)].filter((d): d is string => Boolean(d));
  for (const d of dirs) {
    const ffmpeg = path.join(d, exe("ffmpeg"));
    const ffprobe = path.join(d, exe("ffprobe"));
    if (exists(ffmpeg) && exists(ffprobe)) return { ffmpeg, ffprobe };
  }
  return null;
}

export interface VideoDeps {
  bins?: FfmpegBins | null;
  run?: ProcRunner;
}

export interface SceneTiming {
  /** Segundos de cada cena (sem contar a transição). */
  seconds: number;
  /** Segundos de transição entre cenas. */
  fade: number;
}

export const DEFAULT_TIMING: SceneTiming = { seconds: 3, fade: 0.5 };

/** Duração total: N cenas de `seconds` mais uma transição que sobra no fim. */
export const videoDuration = (scenes: number, t: SceneTiming = DEFAULT_TIMING): number => Math.round((scenes * t.seconds + t.fade) * 100) / 100;

/** Grafo de filtros do ffmpeg para N cenas: zoom lento em cada uma e transição suave entre elas. */
export function buildFilterGraph(scenes: number, spec: Pick<CreativeSpec, "width" | "height">, t: SceneTiming = DEFAULT_TIMING, fps = 30): string {
  const frames = Math.round((t.seconds + t.fade) * fps);
  const up = { w: Math.round(spec.width * 1.5), h: Math.round(spec.height * 1.5) };
  const parts: string[] = [];
  for (let i = 0; i < scenes; i++) {
    // Ampliar antes do zoompan evita o tremor de arredondamento do filtro.
    parts.push(`[${i}:v]scale=${up.w}:${up.h},setsar=1,zoompan=z='min(1+0.0005*on,1.05)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${spec.width}x${spec.height}:fps=${fps}[s${i}]`);
  }
  let last = "s0";
  for (let i = 1; i < scenes; i++) {
    const out = i === scenes - 1 ? "mix" : `x${i}`;
    parts.push(`[${last}][s${i}]xfade=transition=fade:duration=${t.fade}:offset=${Math.round(i * t.seconds * 100) / 100}[${out}]`);
    last = out;
  }
  parts.push(`[${last}]format=yuv420p[vout]`);
  return parts.join(";");
}

/** Costura as cenas (PNG) em um MP4. Devolve `null` se tudo certo, ou o motivo do erro. */
export async function scenesToVideo(scenePngs: string[], spec: Pick<CreativeSpec, "width" | "height">, outFile: string, deps: VideoDeps = {}, t: SceneTiming = DEFAULT_TIMING): Promise<string | null> {
  const bins = deps.bins === undefined ? findFfmpeg() : deps.bins;
  if (!bins) return "ffmpeg não encontrado (instale o ffmpeg ou use FFMPEG_PATH): sem ele não dá para gerar o vídeo.";
  if (scenePngs.length < 2) return "O vídeo precisa de pelo menos duas cenas.";
  const run = deps.run ?? runBrowser;
  const total = videoDuration(scenePngs.length, t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-vid-"));
  try {
    const args = ["-y", "-hide_banner", "-loglevel", "error"];
    for (const p of scenePngs) args.push("-loop", "1", "-framerate", "30", "-t", String(t.seconds + t.fade), "-i", p);
    args.push("-f", "lavfi", "-t", String(total), "-i", "anullsrc=r=44100:cl=stereo");
    // O grafo vai inline: `-filter_complex_script` saiu de versões novas do ffmpeg, e o grafo cabe folgado na linha de comando.
    args.push("-filter_complex", buildFilterGraph(scenePngs.length, spec, t), "-map", "[vout]", "-map", `${scenePngs.length}:a`);
    args.push("-t", String(total), "-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-profile:v", "high", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-c:a", "aac", "-b:a", "96k", "-shortest", outFile);
    const res = await run(bins.ffmpeg, args, 240_000);
    if (res.code !== 0 || !fs.existsSync(outFile)) return `O ffmpeg falhou: ${(res.stderr || "sem mensagem").trim().slice(0, 240)}`;
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export interface ProbeInfo {
  video: { codec: string; width: number; height: number; pixFmt: string; fps: number } | null;
  audio: { codec: string } | null;
  duration: number;
  bytes: number;
}

function parseFps(r: string | undefined): number {
  const m = /^(\d+)\/(\d+)$/.exec(r ?? "");
  return m && Number(m[2]) > 0 ? Number(m[1]) / Number(m[2]) : 0;
}

export function parseProbe(json: string, bytes: number): ProbeInfo | null {
  try {
    const j = JSON.parse(json) as { streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; pix_fmt?: string; r_frame_rate?: string }>; format?: { duration?: string } };
    const v = j.streams?.find((s) => s.codec_type === "video");
    const a = j.streams?.find((s) => s.codec_type === "audio");
    return {
      video: v ? { codec: v.codec_name ?? "", width: v.width ?? 0, height: v.height ?? 0, pixFmt: v.pix_fmt ?? "", fps: parseFps(v.r_frame_rate) } : null,
      audio: a ? { codec: a.codec_name ?? "" } : null,
      duration: Number(j.format?.duration ?? 0),
      bytes,
    };
  } catch {
    return null;
  }
}

export async function probeVideo(file: string, deps: VideoDeps = {}): Promise<ProbeInfo | null> {
  const bins = deps.bins === undefined ? findFfmpeg() : deps.bins;
  if (!bins || !fs.existsSync(file)) return null;
  const run = deps.run ?? runBrowser;
  const res = await run(bins.ffprobe, ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,pix_fmt,r_frame_rate", "-show_entries", "format=duration", "-of", "json", file], 30_000);
  return res.code === 0 ? parseProbe(res.stdout, fs.statSync(file).size) : null;
}

/** O vídeo serve ao Instagram (Reels)? Confere o arquivo de fato, não a intenção. */
export function verifyVideoInfo(info: ProbeInfo | null, spec: Pick<CreativeSpec, "width" | "height">): SiteCheck[] {
  if (!info?.video) return [{ name: "vídeo legível", ok: false, detail: "O ffprobe não leu o vídeo gerado." }];
  const v = info.video;
  const mb = (info.bytes / 1024 / 1024).toFixed(1);
  return [
    { name: "vídeo legível", ok: true, detail: "O ffprobe leu o vídeo." },
    { name: "codec H.264", ok: v.codec === "h264" && v.pixFmt === "yuv420p", detail: `${v.codec} / ${v.pixFmt} (o Instagram pede H.264 em yuv420p).` },
    { name: "dimensões do vídeo", ok: v.width === spec.width && v.height === spec.height, detail: `${v.width}×${v.height} (esperado ${spec.width}×${spec.height}).` },
    { name: "quadros por segundo", ok: v.fps >= 23 && v.fps <= 60, detail: `${v.fps.toFixed(1)} fps (aceito: de 23 a 60).` },
    { name: "duração do vídeo", ok: info.duration >= VIDEO_LIMITS.minSeconds && info.duration <= VIDEO_LIMITS.maxSeconds, detail: `${info.duration.toFixed(1)} s (aceito: de ${VIDEO_LIMITS.minSeconds} a ${VIDEO_LIMITS.maxSeconds} s).` },
    { name: "faixa de áudio", ok: Boolean(info.audio), detail: info.audio ? `Áudio ${info.audio.codec} (mudo).` : "Sem faixa de áudio: o Instagram pode recusar." },
    { name: "peso do vídeo", ok: info.bytes > 20_000 && info.bytes <= VIDEO_LIMITS.maxBytes, detail: `${mb} MB (aceito: até ${VIDEO_LIMITS.maxBytes / 1024 / 1024} MB).` },
  ];
}

/** Decodifica o vídeo inteiro: qualquer erro de decodificação reprova. */
export async function decodeCheck(file: string, deps: VideoDeps = {}): Promise<SiteCheck> {
  const bins = deps.bins === undefined ? findFfmpeg() : deps.bins;
  if (!bins) return { name: "vídeo decodifica sem erro", ok: false, detail: "ffmpeg não encontrado." };
  const run = deps.run ?? runBrowser;
  const res = await run(bins.ffmpeg, ["-v", "error", "-i", file, "-f", "null", "-"], 120_000);
  const clean = res.code === 0 && res.stderr.trim() === "";
  return { name: "vídeo decodifica sem erro", ok: clean, detail: clean ? "Decodificação completa, sem erro." : `Erro: ${(res.stderr || `código ${res.code}`).trim().slice(0, 160)}` };
}

/** Um quadro do vídeo (capa), para o painel. `null` se não deu. */
export async function posterFrame(file: string, outPng: string, atSeconds: number, deps: VideoDeps = {}): Promise<boolean> {
  const bins = deps.bins === undefined ? findFfmpeg() : deps.bins;
  if (!bins) return false;
  const run = deps.run ?? runBrowser;
  const res = await run(bins.ffmpeg, ["-y", "-v", "error", "-ss", String(atSeconds), "-i", file, "-frames:v", "1", outPng], 30_000);
  return res.code === 0 && fs.existsSync(outPng) && fs.statSync(outPng).size > 5_000;
}
