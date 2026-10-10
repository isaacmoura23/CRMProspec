import "server-only";
import fs from "node:fs";
import path from "node:path";
import { SAFE_TOOLS, type ClaudeRunner } from "@/services/claude/headless";
import type { SiteCheck } from "@/types/agents";

/**
 * O laço "escrever → verificar → corrigir" do Claude Code em modo restrito, igual para o construtor
 * de sites e para as artes: o Claude Code escreve UM arquivo numa pasta isolada; quem decide se
 * serve é a verificação que o chamador passa (`verify`), e quando ela reprova o Claude Code recebe
 * a lista exata do que falhou, até esgotar as rodadas, o prazo ou o teto de gasto.
 */

export interface AuthorLoopInput {
  /** Pasta de trabalho já preparada (perfil, regras, skills, arquivo de partida). */
  dir: string;
  /** Nome do arquivo que o Claude Code escreve dentro de `dir`. */
  file: string;
  runner: ClaudeRunner;
  systemAppend: string;
  firstPrompt: string;
  repairPrompt: (failed: SiteCheck[]) => string;
  /** A verificação do chamador: a mesma que valeria para o gerador determinístico. */
  verify: (content: string) => Promise<SiteCheck[]>;
  budgetUsd: number;
  timeoutMs: number;
  /** Rodadas de correção depois da primeira escrita. */
  repairRounds: number;
  model?: string;
  /** Passado o prazo, não começa outra rodada. */
  deadline: Date;
  now?: () => Date;
  maxBytes?: number;
}

export type AuthorLoopResult =
  | { ok: true; html: string; checks: SiteCheck[]; costUsd: number; rounds: number }
  | { ok: false; reason: string; costUsd: number; rounds: number; checks: SiteCheck[] };

const DEFAULT_MAX_BYTES = 200_000;

export async function authorLoop(input: AuthorLoopInput): Promise<AuthorLoopResult> {
  const clock = input.now ?? (() => new Date());
  const file = path.join(input.dir, input.file);
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  let cost = 0;
  let rounds = 0;
  let checks: SiteCheck[] = [];
  const spare = () => Math.max(0, input.budgetUsd - cost);

  for (let round = 0; round <= input.repairRounds; round++) {
    if (clock().getTime() >= input.deadline.getTime()) return { ok: false, reason: "Passou o prazo antes de o Claude Code terminar.", costUsd: cost, rounds, checks };
    if (spare() < 0.05) return { ok: false, reason: `O teto de gasto do construtor (US$ ${input.budgetUsd.toFixed(2)}) acabou.`, costUsd: cost, rounds, checks };

    const run = await input.runner({
      cwd: input.dir,
      prompt: round === 0 ? input.firstPrompt : input.repairPrompt(checks.filter((c) => !c.ok)),
      systemAppend: input.systemAppend,
      tools: [...SAFE_TOOLS],
      budgetUsd: spare(),
      timeoutMs: input.timeoutMs,
      model: input.model,
    });
    rounds++;
    cost += run.costUsd;
    if (!run.ok) return { ok: false, reason: run.error ?? "O Claude Code não terminou.", costUsd: cost, rounds, checks };

    let content: string;
    try {
      if (fs.statSync(file).size > maxBytes) return { ok: false, reason: `O ${input.file} que o Claude Code escreveu é grande demais.`, costUsd: cost, rounds, checks };
      content = fs.readFileSync(file, "utf8");
    } catch {
      return { ok: false, reason: `O Claude Code não deixou um ${input.file}.`, costUsd: cost, rounds, checks };
    }

    checks = await input.verify(content);
    if (checks.every((c) => c.ok)) return { ok: true, html: content, checks, costUsd: cost, rounds };
  }
  return { ok: false, reason: `Depois de ${rounds} rodada(s), a verificação ainda reprova: ${checks.filter((c) => !c.ok).map((c) => c.name).join("; ")}.`, costUsd: cost, rounds, checks };
}
