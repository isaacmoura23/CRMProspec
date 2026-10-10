import "server-only";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Claude Code em modo headless, como ferramenta restrita.
 *
 * O CLI é chamado como `claude -p` com:
 *  - `--restricted`: sem Bash/PowerShell/REPL/WebFetch e com os arquivos confinados à pasta de trabalho;
 *  - `--tools` com SÓ ferramentas de arquivo (Read, Write, Edit, Glob, Grep);
 *  - `--strict-mcp-config` e `--disable-slash-commands`: nenhum MCP, nenhuma skill instalada na máquina;
 *  - `--permission-mode dontAsk`: nada que precise de permissão é executado (falha em vez de perguntar);
 *  - `--max-budget-usd`: teto de gasto por chamada.
 *
 * O processo recebe um ambiente SEM as chaves do CRM (Supabase, Google, Instagram, WhatsApp…): o
 * construtor não precisa delas e o texto que ele lê (o perfil do cliente) é dado de terceiros.
 */

export interface ClaudeRunRequest {
  /** Pasta de trabalho: é onde ele lê e escreve, e só ali. */
  cwd: string;
  prompt: string;
  /** Acrescenta ao prompt de sistema (regras fixas do trabalho). */
  systemAppend?: string;
  tools?: string[];
  budgetUsd: number;
  timeoutMs: number;
  model?: string;
}

export interface ClaudeRunResult {
  ok: boolean;
  /** Resposta final do modelo (uma linha, nesta tarefa). */
  result: string;
  costUsd: number;
  durationMs: number;
  error: string | null;
  timedOut: boolean;
}

export type ClaudeRunner = (req: ClaudeRunRequest) => Promise<ClaudeRunResult>;

/** Ferramentas permitidas: só leitura e escrita de arquivos na pasta de trabalho. */
export const SAFE_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep"] as const;

/** Procura o executável: CLAUDE_BIN, ou `claude(.exe)` no PATH. Nunca `.cmd` (exigiria shell). */
export function findClaude(env: Record<string, string | undefined> = process.env, exists: (p: string) => boolean = fs.existsSync): string | null {
  if (env.CLAUDE_BIN && exists(env.CLAUDE_BIN)) return env.CLAUDE_BIN;
  const names = process.platform === "win32" ? ["claude.exe"] : ["claude"];
  for (const dir of (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean)) {
    for (const n of names) {
      const p = path.join(dir, n);
      if (exists(p)) return p;
    }
  }
  return null;
}

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|SERVICE_ROLE|WEBHOOK|DSN|CREDENTIAL)/i;

/** Ambiente do processo filho: tudo menos o que parece segredo (a chave do próprio Claude, se houver, fica). */
export function childEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (k === "ANTHROPIC_API_KEY" || k === "CLAUDE_CODE_OAUTH_TOKEN" || !SECRET_NAME.test(k)) out[k] = v;
  }
  return out;
}

export function buildArgs(req: ClaudeRunRequest): string[] {
  const tools = (req.tools ?? [...SAFE_TOOLS]).join(",");
  return [
    "-p",
    "--restricted",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--permission-mode",
    "dontAsk",
    "--tools",
    tools,
    "--allowedTools",
    tools,
    "--max-budget-usd",
    String(Math.max(0.05, Math.round(req.budgetUsd * 100) / 100)),
    "--output-format",
    "json",
    "--no-session-persistence",
    ...(req.model ? ["--model", req.model] : []),
    ...(req.systemAppend ? ["--append-system-prompt", req.systemAppend] : []),
  ];
}

/** Lê o JSON final do CLI (`--output-format json`); aceita lixo antes dele. */
export function parseClaudeJson(stdout: string): { result: string; costUsd: number; isError: boolean } | null {
  const start = stdout.indexOf("{");
  if (start < 0) return null;
  try {
    const j = JSON.parse(stdout.slice(start)) as { result?: unknown; total_cost_usd?: unknown; cost_usd?: unknown; is_error?: unknown; subtype?: unknown };
    const cost = typeof j.total_cost_usd === "number" ? j.total_cost_usd : typeof j.cost_usd === "number" ? j.cost_usd : 0;
    const isError = j.is_error === true || (typeof j.subtype === "string" && j.subtype.startsWith("error"));
    return { result: typeof j.result === "string" ? j.result : "", costUsd: cost, isError };
  } catch {
    return null;
  }
}

export const runClaudeHeadless: ClaudeRunner = (req) =>
  new Promise((resolve) => {
    const started = Date.now();
    const bin = findClaude();
    const done = (r: Partial<ClaudeRunResult> & { error: string | null }) =>
      resolve({ ok: false, result: "", costUsd: 0, durationMs: Date.now() - started, timedOut: false, ...r });
    if (!bin) return done({ error: "O Claude Code (comando `claude`) não está instalado ou não está no PATH. Use CLAUDE_BIN para indicar o caminho." });

    const child = spawn(bin, buildArgs(req), { cwd: req.cwd, env: childEnv() as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, req.timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      done({ error: `Não consegui iniciar o Claude Code: ${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const parsed = parseClaudeJson(stdout);
      if (timedOut) return done({ error: `O Claude Code passou do tempo (${Math.round(req.timeoutMs / 1000)} s).`, timedOut: true, costUsd: parsed?.costUsd ?? 0 });
      if (!parsed) return done({ error: `Resposta ilegível do Claude Code (código ${code}): ${(stderr || stdout).trim().slice(0, 240)}` });
      if (code !== 0 || parsed.isError) return done({ error: `O Claude Code terminou com erro: ${(parsed.result || stderr).trim().slice(0, 240)}`, costUsd: parsed.costUsd, result: parsed.result });
      done({ ok: true, result: parsed.result, costUsd: parsed.costUsd, error: null });
    });
    // O prompt vai pela entrada padrão: não há limite de linha de comando nem aspas para escapar.
    child.stdin.on("error", () => undefined);
    child.stdin.end(req.prompt);
  });
