import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { IMAGE_MAX_BYTES, pngSize, type CreativeSpec } from "@/lib/creative-policy";
import { CONTRAST_JS, consoleErrors, runBrowser, type BrowserRunner } from "@/services/sites/browser";
import { findBrowser } from "@/services/presence/visual";
import type { Safe } from "@/services/creatives/templates";
import type { SiteCheck } from "@/types/agents";

/**
 * HTML/SVG → PNG com o Chrome ou o Edge instalados (modo headless, só sobre arquivos locais `file://`).
 *
 * Também mede a arte antes de aceitá-la: texto fora da tela ou da margem de segurança, rolagem,
 * erro de console e contraste. Nada disso vai para a imagem final: a medição usa uma cópia da página.
 */

export interface RenderDeps {
  browser?: string | null;
  run?: BrowserRunner;
}

export interface RenderResult {
  png: Buffer | null;
  checks: SiteCheck[];
}

const MEASURE = (spec: Pick<CreativeSpec, "width" | "height">, safe: Safe) => `<script>(function(){var errs=[];window.addEventListener('error',function(e){errs.push(String(e.message||'erro'))});
${CONTRAST_JS}
function measure(){var W=${spec.width},H=${spec.height},S=${JSON.stringify(safe)},out=[],edge=[];
document.querySelectorAll('body *').forEach(function(el){var own='';for(var i=0;i<el.childNodes.length;i++){if(el.childNodes[i].nodeType===3)own+=el.childNodes[i].nodeValue}own=own.replace(/\\s+/g,' ').trim();if(!own)return;var r=el.getBoundingClientRect();if(!r.width||!r.height)return;var tag=el.tagName.toLowerCase()+': '+own.slice(0,24);
if(r.right>W+1||r.bottom>H+1||r.left<-1||r.top<-1){out.push(tag);return}
if(r.left<S.side-4||r.right>W-S.side+4||r.top<S.top-4||r.bottom>H-S.bottom+4)edge.push(tag)});
var r={w:window.innerWidth,h:window.innerHeight,sw:document.documentElement.scrollWidth,sh:document.documentElement.scrollHeight,outside:out.slice(0,3),edge:edge.slice(0,3),errors:errs,lowContrast:lowContrast()};
document.title='ATLAS_ART:'+JSON.stringify(r)}
window.addEventListener('load',function(){setTimeout(measure,300)})})();</script>`;

interface ArtMeasure {
  w: number;
  h: number;
  sw: number;
  sh: number;
  outside: string[];
  edge: string[];
  errors: string[];
  lowContrast: string[];
}

export function parseArtMeasure(dom: string): ArtMeasure | null {
  const m = /<title>ATLAS_ART:([\s\S]*?)<\/title>/.exec(dom);
  if (!m) return null;
  try {
    return JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")) as ArtMeasure;
  } catch {
    return null;
  }
}

function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-art-"));
  return fn(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

const NO_BROWSER: SiteCheck = { name: "navegador", ok: false, detail: "Chrome ou Edge não encontrados (use CHROME_PATH): sem o navegador não há como gerar nem conferir a arte." };

/** Renderiza o HTML em PNG no tamanho exato da arte e confere o arquivo. */
export async function renderPng(html: string, spec: CreativeSpec, deps: RenderDeps = {}): Promise<RenderResult> {
  const browser = deps.browser === undefined ? findBrowser() : deps.browser;
  if (!browser) return { png: null, checks: [NO_BROWSER] };
  const run = deps.run ?? runBrowser;
  return withTemp(async (dir) => {
    const page = path.join(dir, "arte.html");
    const shot = path.join(dir, "arte.png");
    fs.writeFileSync(page, html, "utf8");
    await run(
      browser,
      [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--no-first-run",
        "--no-default-browser-check",
        "--force-device-scale-factor=1",
        `--user-data-dir=${path.join(dir, "profile")}`,
        `--window-size=${spec.width},${spec.height}`,
        "--virtual-time-budget=5000",
        `--screenshot=${shot}`,
        pathToFileURL(page).toString(),
      ],
      45_000
    );
    if (!fs.existsSync(shot)) return { png: null, checks: [{ name: "imagem gerada", ok: false, detail: "O navegador não gravou a imagem." }] };
    const png = fs.readFileSync(shot);
    const size = pngSize(png);
    const checks: SiteCheck[] = [
      { name: "imagem gerada", ok: Boolean(size), detail: size ? "PNG gravado." : "O arquivo gravado não é um PNG válido." },
      { name: "dimensões da arte", ok: Boolean(size && size.width === spec.width && size.height === spec.height), detail: size ? `${size.width}×${size.height} (esperado ${spec.width}×${spec.height}).` : "Sem dimensões." },
      { name: "peso do arquivo", ok: png.length > 4_000 && png.length <= IMAGE_MAX_BYTES, detail: `${Math.round(png.length / 1024)} KB (aceito: de 4 KB a ${IMAGE_MAX_BYTES / 1024 / 1024} MB).` },
    ];
    return { png, checks };
  });
}

/** Mede a arte numa cópia com script: texto fora da tela ou da margem de segurança, erro de console e contraste. */
export async function measureArt(html: string, spec: CreativeSpec, safe: Safe, deps: RenderDeps = {}): Promise<SiteCheck[]> {
  const browser = deps.browser === undefined ? findBrowser() : deps.browser;
  if (!browser) return [NO_BROWSER];
  const run = deps.run ?? runBrowser;
  return withTemp(async (dir) => {
    const page = path.join(dir, "medir.html");
    fs.writeFileSync(page, html.replace("</body>", `${MEASURE(spec, safe)}</body>`), "utf8");
    const res = await run(
      browser,
      ["--headless=new", "--disable-gpu", "--no-first-run", "--enable-logging=stderr", "--v=0", "--force-device-scale-factor=1", `--user-data-dir=${path.join(dir, "profile")}`, `--window-size=${spec.width},${spec.height}`, "--virtual-time-budget=5000", "--dump-dom", pathToFileURL(page).toString()],
      45_000
    );
    const m = parseArtMeasure(res.stdout);
    if (!m) return [{ name: "navegador abriu a arte", ok: false, detail: "O navegador não conseguiu abrir ou medir a arte." }];
    const errors = [...consoleErrors(res.stderr), ...m.errors];
    const scroll = m.sw > spec.width + 1 || m.sh > spec.height + 1;
    return [
      { name: "navegador abriu a arte", ok: true, detail: "A arte abriu e foi medida." },
      { name: "sem erro de console", ok: errors.length === 0, detail: errors.length === 0 ? "Nenhum erro de console nem recurso que falhou." : `Erros: ${errors.slice(0, 2).join(" | ")}` },
      { name: "arte cabe na tela", ok: !scroll && m.outside.length === 0, detail: scroll ? `A arte tem ${m.sw}×${m.sh}px numa tela de ${spec.width}×${spec.height}px.` : m.outside.length ? `Texto fora da tela: ${m.outside.join(" | ")}` : "Todo texto está dentro da tela." },
      { name: "texto na margem de segurança", ok: m.edge.length === 0, detail: m.edge.length === 0 ? "Nada de texto sob a interface do app nem colado na borda." : `Texto fora da margem: ${m.edge.join(" | ")}` },
      { name: "texto legível (contraste)", ok: m.lowContrast.length === 0, detail: m.lowContrast.length === 0 ? "Todo texto tem contraste de pelo menos 3:1 com o fundo." : `Contraste baixo em: ${m.lowContrast.join(" | ")}` },
    ];
  });
}
