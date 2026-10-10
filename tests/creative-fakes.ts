import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { creativeTestHooks } from "@/services/creatives/engine";
import type { BrowserRunner } from "@/services/sites/browser";

/**
 * Navegador e ffmpeg simulados para os testes (nunca chamam o Chrome nem o ffmpeg de verdade):
 * o "navegador" grava um PNG do tamanho da janela e devolve uma medição configurável; o "ffmpeg"
 * grava um MP4 de mentira e o "ffprobe" descreve um vídeo válido.
 */

export function fakePng(w: number, h: number, pad = 8_000): Buffer {
  const b = Buffer.alloc(33 + pad, 3);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

export interface ArtMeasureFake {
  w: number;
  h: number;
  sw: number;
  sh: number;
  outside: string[];
  edge: string[];
  errors: string[];
  lowContrast: string[];
}

export const OK_ART: ArtMeasureFake = { w: 1080, h: 1350, sw: 1080, sh: 1350, outside: [], edge: [], errors: [], lowContrast: [] };

export function fakeBrowser(over: Partial<ArtMeasureFake> = {}, log: string[][] = []): BrowserRunner {
  return async (_bin, args) => {
    log.push(args);
    if (args.includes("--dump-dom")) {
      const win = args.find((a) => a.startsWith("--window-size="))!.split("=")[1]!.split(",").map(Number);
      return { stdout: `<title>ATLAS_ART:${JSON.stringify({ ...OK_ART, w: win[0], h: win[1], sw: win[0], sh: win[1], ...over }).replace(/"/g, "&quot;")}</title>`, stderr: "", code: 0 };
    }
    const shot = args.find((a) => a.startsWith("--screenshot="))!.slice("--screenshot=".length);
    const [w, h] = args.find((a) => a.startsWith("--window-size="))!.split("=")[1]!.split(",").map(Number);
    fs.writeFileSync(shot, fakePng(w!, h!));
    return { stdout: "", stderr: "", code: 0 };
  };
}

const PROBE = JSON.stringify({ streams: [{ codec_type: "video", codec_name: "h264", width: 1080, height: 1920, pix_fmt: "yuv420p", r_frame_rate: "30/1" }, { codec_type: "audio", codec_name: "aac" }], format: { duration: "9.5" } });

export const fakeVideoDeps = {
  bins: { ffmpeg: "ffmpeg", ffprobe: "ffprobe" },
  run: (async (bin, args) => {
    if (bin === "ffprobe") return { stdout: PROBE, stderr: "", code: 0 };
    const out = args[args.length - 1]!;
    if (out.endsWith(".mp4")) fs.writeFileSync(out, Buffer.alloc(300_000, 2));
    if (out.endsWith(".png")) fs.writeFileSync(out, fakePng(1080, 1920, 20_000));
    return { stdout: "", stderr: "", code: 0 };
  }) as BrowserRunner,
};

/** Liga os simulados e aponta as pastas de criativos para um diretório temporário; devolve a função que desfaz. */
export function installCreativeFakes(): () => void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-creatives-"));
  process.env.CREATIVES_DIR = path.join(tmp, "creatives");
  process.env.CREATIVE_WORK_DIR = path.join(tmp, "work");
  creativeTestHooks.render = { browser: "fake", run: fakeBrowser() };
  creativeTestHooks.video = fakeVideoDeps;
  return () => {
    delete process.env.CREATIVES_DIR;
    delete process.env.CREATIVE_WORK_DIR;
    creativeTestHooks.render = undefined;
    creativeTestHooks.video = undefined;
    creativeTestHooks.claude = undefined;
    creativeTestHooks.claudeAvailable = undefined;
    fs.rmSync(tmp, { recursive: true, force: true });
  };
}
