import { CREATIVE_SPECS, type CreativeCopy } from "@/lib/creative-policy";
import { paletteFor } from "@/lib/site-generate";
import type { CreativeFormat } from "@/types/agents";

/**
 * Modelos de arte: HTML + CSS + SVG puros, sem imagem, sem fonte externa, sem script.
 *
 * Cada composição mostra SÓ o texto recebido (título, apoio, chamada e o nome da empresa) sobre
 * cor e forma geométrica: nada de foto de banco, pessoa, logotipo ou marca de terceiros.
 * Há três composições; `variant` escolhe a próxima ao pedir "outro visual". As cores nascem do
 * nome da empresa e são escuras o bastante para texto branco (contraste conferido na verificação).
 */

export type Scene = "all" | "hook" | "body" | "cta";
export const LOOKS = 3;

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export interface Safe {
  top: number;
  bottom: number;
  side: number;
}

/** Stories e Reels cobrem o topo e o rodapé com a interface do app: o texto fica fora dessas faixas. */
export function safeArea(format: CreativeFormat): Safe {
  return format === "story" || format === "reel" ? { top: 250, bottom: 340, side: 84 } : { top: 84, bottom: 84, side: 84 };
}

/** Cores da marca: escuras (texto branco legível), com um tom claro para detalhes sobre fundo escuro. */
export function artPalette(brand: string): { primary: string; light: string; ink: string; soft: string; hue: number } {
  const p = paletteFor(brand, null);
  const hsl = (h: number, s: number, l: number) => {
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => {
      const k = (n + h / 30) % 12;
      return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1))))).toString(16).padStart(2, "0");
    };
    return `#${f(0)}${f(8)}${f(4)}`;
  };
  return { primary: hsl(p.hue, 0.58, 0.3), light: hsl(p.hue, 0.8, 0.72), ink: "#12161b", soft: hsl(p.hue, 0.45, 0.95), hue: p.hue };
}

function headlineSize(len: number, tall: boolean): number {
  const steps = tall ? [[16, 150], [30, 122], [46, 100]] : [[16, 132], [30, 108], [46, 88]];
  for (const [max, px] of steps) if (len <= max!) return px!;
  return tall ? 84 : 74;
}
const bodySize = (len: number, tall: boolean): number => (len <= 70 ? (tall ? 58 : 52) : tall ? 50 : 44);

export interface ArtInput {
  format: CreativeFormat;
  copy: CreativeCopy;
  variant: number;
  scene?: Scene;
}

/** O que a arte mostra em cada cena: a imagem única mostra tudo; o vídeo reparte em abertura, apoio e chamada. */
function show(scene: Scene, copy: CreativeCopy) {
  return {
    brand: true,
    headline: scene === "all" || scene === "hook",
    body: Boolean(copy.body) && (scene === "all" || scene === "body"),
    cta: Boolean(copy.cta) && (scene === "all" || scene === "cta"),
    // Na cena de chamada o título não aparece, então o nome da empresa ganha destaque.
    bigBrand: scene === "cta",
  };
}

/** Cenas do vídeo: abertura (título), apoio (se houver texto) e chamada (se houver). */
export function videoScenes(copy: CreativeCopy): Scene[] {
  return ["hook", ...(copy.body ? (["body"] as Scene[]) : []), "cta"];
}

export function artHtml(input: ArtInput): string {
  const { format, copy } = input;
  const spec = CREATIVE_SPECS[format];
  const W = spec.width;
  const H = spec.height;
  const tall = H > W;
  const safe = safeArea(format);
  const pal = artPalette(copy.brand);
  const scene = input.scene ?? "all";
  const look = ((input.variant % LOOKS) + LOOKS) % LOOKS;
  const s = show(scene, copy);
  // Cena de abertura sozinha pode usar tipo maior.
  const hSize = headlineSize(copy.headline.length, tall) + (scene === "hook" ? 10 : 0);
  const bSize = bodySize(copy.body.length, tall) + (scene === "body" ? 12 : 0);

  const brand = `<div class="brand"><svg class="mark" viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="22" fill="currentColor"/><circle cx="32" cy="16" r="9" fill="var(--accent)"/></svg><span>${esc(copy.brand)}</span></div>`;
  const headline = s.headline ? `<h1>${esc(copy.headline)}</h1><div class="bar"></div>` : "";
  const body = s.body ? `<p class="body">${esc(copy.body)}</p>` : "";
  const cta = s.cta ? `<div class="cta">${esc(copy.cta)}</div>` : "";
  const bigBrand = s.bigBrand ? `<div class="bigbrand">${esc(copy.brand)}</div>` : "";

  const decoration = [
    // 0: círculos grandes no canto, em branco translúcido sobre a cor da marca
    `<svg class="deco" viewBox="0 0 ${W} ${H}" aria-hidden="true"><circle cx="${W * 0.86}" cy="${H * 0.18}" r="${W * 0.46}" fill="#ffffff" fill-opacity="0.09"/><circle cx="${W * 0.98}" cy="${H * 0.9}" r="${W * 0.3}" fill="#ffffff" fill-opacity="0.07"/></svg>`,
    // 1: o painel da cor da marca com a borda inferior inclinada é CSS; nada aqui
    ``,
    // 2: brilho da cor da marca sobre fundo escuro
    `<svg class="deco" viewBox="0 0 ${W} ${H}" aria-hidden="true"><defs><radialGradient id="g" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="${pal.primary}" stop-opacity="0.95"/><stop offset="1" stop-color="${pal.primary}" stop-opacity="0"/></radialGradient></defs><circle cx="${W * 0.9}" cy="${H * 0.12}" r="${W * 0.85}" fill="url(#g)"/><circle cx="${W * 0.06}" cy="${H * 0.97}" r="${W * 0.34}" fill="url(#g)"/></svg>`,
  ][look];

  const base = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${W}px;height:${H}px;overflow:hidden;background:#000}
.art{position:relative;width:${W}px;height:${H}px;overflow:hidden;--accent:${pal.light}}
.deco{position:absolute;left:0;top:0;width:${W}px;height:${H}px}
.in{position:relative;width:${W}px;height:${H}px;padding:${safe.top}px ${safe.side}px ${safe.bottom}px;display:flex;flex-direction:column;justify-content:space-between}
.brand{display:flex;align-items:center;gap:20px;font-size:36px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.mark{width:56px;height:56px;flex:none}
.main{display:flex;flex-direction:column;gap:34px;max-width:${W - safe.side * 2}px}
h1{font-size:${hSize}px;line-height:1.04;letter-spacing:-.02em;overflow-wrap:anywhere}
.bar{width:130px;height:12px;border-radius:6px}
.body{font-size:${bSize}px;line-height:1.3;font-weight:500;max-width:${Math.round((W - safe.side * 2) * 0.92)}px;overflow-wrap:anywhere}
.foot{display:flex;flex-direction:column;gap:30px;align-items:flex-start}
.cta{display:inline-block;font-size:${tall ? 46 : 42}px;font-weight:800;padding:30px 58px;border-radius:999px;overflow-wrap:anywhere;max-width:${W - safe.side * 2}px}
.bigbrand{font-size:${tall ? 104 : 88}px;font-weight:800;line-height:1.05;letter-spacing:-.02em;overflow-wrap:anywhere}`;

  const looks = [
    // 0 Bloco: cor cheia da marca, tipo pesado
    `body{font-family:"Segoe UI",system-ui,-apple-system,Arial,sans-serif}
.art{background:${pal.primary};color:#fff}
h1{font-weight:800}.bar{background:${pal.light}}
.body{opacity:.94}
.cta{background:#fff;color:${pal.primary}}
.brand{color:#fff}`,
    // 1 Faixa: painel da marca com borda inclinada sobre fundo claro, tipo com serifa
    `body{font-family:Georgia,"Times New Roman",serif}
.art{background:${pal.soft};color:${pal.ink}}
.l1{padding:0;justify-content:flex-start}
.head{flex:none;display:flex;flex-direction:column;gap:${tall ? 90 : 60}px;padding:${safe.top}px ${safe.side}px ${Math.round(H * 0.11)}px;background:${pal.primary};clip-path:polygon(0 0,100% 0,100% 88%,0 100%)}
.l1 .foot{flex:1;justify-content:center;gap:44px;padding:${tall ? 70 : 48}px ${safe.side}px ${safe.bottom}px}
.brand{color:#fff;font-family:"Segoe UI",system-ui,Arial,sans-serif}
h1{color:#fff;font-weight:700}.bar{background:${pal.light}}
.body{color:${pal.ink};font-weight:500}
.cta{background:${pal.primary};color:#fff;font-family:"Segoe UI",system-ui,Arial,sans-serif}
.bigbrand{color:${pal.primary}}`,
    // 2 Noite: fundo escuro com brilho da marca
    `body{font-family:"Trebuchet MS","Segoe UI",system-ui,Arial,sans-serif}
.art{background:${pal.ink};color:#fff}
h1{font-weight:800}.bar{background:${pal.light}}
.body{color:#d5dce3}
.cta{border:4px solid ${pal.light};color:#fff;padding:26px 54px}
.brand{color:#fff}`,
  ];

  // Na composição "Faixa" o título fica no cabeçalho da cor da marca (texto branco); o apoio e a chamada, sobre o fundo claro.
  const layout =
    look === 1
      ? `<div class="in l1"><div class="head">${brand}<div class="main">${headline}</div></div><div class="foot">${bigBrand}${body}${cta}</div></div>`
      : `<div class="in">${brand}<div class="main">${headline}${body}${bigBrand}</div><div class="foot">${cta}</div></div>`;

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>${esc(copy.brand)}</title>
<style>${base}
${looks[look]}</style>
</head>
<body>
<div class="art">${decoration}${layout}</div>
</body>
</html>
`;
}
