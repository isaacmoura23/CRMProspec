import "server-only";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { captureWithBrowser, findBrowser, VIEWPORTS, type CaptureFn, type Viewport } from "@/services/presence/visual";
import type { SiteCheck } from "@/types/agents";

/**
 * Verificação da prévia no navegador (Chrome ou Edge instalados, modo headless).
 *
 * Abre uma CÓPIA da página com um script de medição (a página publicada não tem
 * script nenhum) e confere, no desktop e no celular: erro de console, rolagem
 * lateral e âncoras quebradas. Também tira as capturas de tela. Roda só sobre
 * arquivos locais (`file://`), nunca sobre um endereço da internet.
 */

export interface BrowserRun {
  stdout: string;
  stderr: string;
  code: number | null;
}

export type BrowserRunner = (browser: string, args: string[], timeoutMs: number) => Promise<BrowserRun>;

export const runBrowser: BrowserRunner = (browser, args, timeoutMs) =>
  new Promise((resolve) => {
    const child = spawn(browser, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: null });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });

const MEASURE = `<script>(function(){var errs=[];window.addEventListener('error',function(e){errs.push(String(e.message||'erro'))});
function done(){var bad=[];document.querySelectorAll('a[href^="#"]').forEach(function(a){var id=a.getAttribute('href').slice(1);if(id&&!document.getElementById(id))bad.push(id)});
var r={w:window.innerWidth,sw:document.documentElement.scrollWidth,overflow:document.documentElement.scrollWidth>window.innerWidth+1,badAnchors:bad,errors:errs,h1:document.querySelectorAll('h1').length};
document.title='ATLAS_VERIFY:'+JSON.stringify(r)}
window.addEventListener('load',function(){setTimeout(done,300)})})();</script>`;

export interface Measure {
  w: number;
  sw: number;
  overflow: boolean;
  badAnchors: string[];
  errors: string[];
  h1: number;
}

/** Lê o resultado que o script de medição deixou no título da página. */
export function parseMeasure(dom: string): Measure | null {
  const m = /<title>ATLAS_VERIFY:([\s\S]*?)<\/title>/.exec(dom);
  if (!m) return null;
  try {
    return JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")) as Measure;
  } catch {
    return null;
  }
}

/** Linhas do navegador que indicam erro de console ou recurso que falhou. */
export function consoleErrors(stderr: string): string[] {
  return stderr
    .split(/\r?\n/)
    .filter((l) => /CONSOLE/i.test(l) && /(error|uncaught|failed to load)/i.test(l))
    .map((l) => l.trim().slice(0, 200))
    .slice(0, 5);
}

export interface BrowserVerification {
  checks: SiteCheck[];
  /** Capturas gravadas, por nome de arquivo (relativo à pasta da prévia). */
  screenshots: Array<{ file: string; bytes: number }>;
  available: boolean;
}

export interface BrowserDeps {
  browser?: string | null;
  run?: BrowserRunner;
  capture?: CaptureFn;
}

export async function verifyInBrowser(html: string, outDir: string, deps: BrowserDeps = {}): Promise<BrowserVerification> {
  const browser = deps.browser === undefined ? findBrowser() : deps.browser;
  if (!browser) {
    return { available: false, screenshots: [], checks: [{ name: "navegador", ok: false, detail: "Chrome ou Edge não encontrados (use CHROME_PATH): sem o navegador não há como conferir erro de console, rolagem lateral e capturas." }] };
  }
  const run = deps.run ?? runBrowser;
  const capture = deps.capture ?? captureWithBrowser(browser, 40_000);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-verify-"));
  const checks: SiteCheck[] = [];
  const screenshots: Array<{ file: string; bytes: number }> = [];

  try {
    // Cópia só para medir: a página publicada continua sem nenhum script.
    const measurable = path.join(work, "verify.html");
    fs.writeFileSync(measurable, html.replace("</body>", `${MEASURE}</body>`), "utf8");
    const url = pathToFileURL(measurable).toString();

    const measures: Partial<Record<Viewport["name"], Measure | null>> = {};
    const errorLines: string[] = [];
    for (const vp of VIEWPORTS) {
      const res = await run(
        browser,
        [
          "--headless=new",
          "--disable-gpu",
          "--no-first-run",
          "--enable-logging=stderr",
          "--v=0",
          `--user-data-dir=${path.join(work, `profile-${vp.name}`)}`,
          `--window-size=${vp.width},${vp.height}`,
          "--virtual-time-budget=5000",
          "--dump-dom",
          url,
        ],
        40_000
      );
      measures[vp.name] = parseMeasure(res.stdout);
      errorLines.push(...consoleErrors(res.stderr));
    }

    const mobile = measures.mobile;
    const desktop = measures.desktop;
    const measured = Boolean(mobile && desktop);
    checks.push({ name: "navegador abriu a página", ok: measured, detail: measured ? "A página abriu no desktop e no celular." : "O navegador não conseguiu abrir ou medir a página." });
    const pageErrors = [...errorLines, ...(mobile?.errors ?? []), ...(desktop?.errors ?? [])];
    checks.push({ name: "sem erro de console", ok: measured && pageErrors.length === 0, detail: pageErrors.length === 0 ? "Nenhum erro de console nem recurso que falhou." : `Erros: ${pageErrors.slice(0, 2).join(" | ")}` });
    checks.push({
      name: "sem rolagem lateral no celular",
      ok: Boolean(mobile && !mobile.overflow),
      detail: mobile ? (mobile.overflow ? `A página tem ${mobile.sw}px de largura numa tela de ${mobile.w}px.` : `Cabe nos ${mobile.w}px do celular.`) : "Não foi possível medir.",
    });
    checks.push({ name: "âncoras sem quebra", ok: Boolean(mobile && desktop && mobile.badAnchors.length === 0 && desktop.badAnchors.length === 0), detail: mobile?.badAnchors.length ? `Âncoras quebradas: ${mobile.badAnchors.join(", ")}` : "Todas as âncoras levam a uma seção." });

    // Capturas de tela (a prévia do dono ver, não parte do site publicado).
    fs.mkdirSync(path.join(outDir, "screens"), { recursive: true });
    for (const vp of VIEWPORTS) {
      const png = await capture(pathToFileURL(path.join(work, "verify.html")).toString(), vp);
      if (png && png.length > 2_000) {
        const file = `screens/${vp.name}.png`;
        fs.writeFileSync(path.join(outDir, file), png);
        screenshots.push({ file, bytes: png.length });
      }
    }
    checks.push({ name: "capturas desktop e celular", ok: screenshots.length === VIEWPORTS.length, detail: screenshots.length === VIEWPORTS.length ? "Capturas de tela gravadas." : "Não foi possível tirar todas as capturas." });
    return { available: true, checks, screenshots };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
