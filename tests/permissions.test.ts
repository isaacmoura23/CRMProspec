import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ADMIN_ROLES, WRITE_ROLES, canAdminister, canWrite } from "@/lib/permissions";
import type { Role } from "@/types";

const ALL_ROLES: Role[] = ["owner", "admin", "sdr", "vendedor", "viewer"];

describe("matriz de permissões", () => {
  it("viewer é o único sem escrita", () => {
    for (const r of ALL_ROLES) assert.equal(canWrite(r), r !== "viewer", r);
  });
  it("administração é só de owner e admin", () => {
    for (const r of ALL_ROLES) assert.equal(canAdminister(r), r === "owner" || r === "admin", r);
  });
  it("quem administra também escreve", () => {
    for (const r of ADMIN_ROLES) assert.ok(WRITE_ROLES.includes(r), r);
  });
});

/**
 * Guarda de regressão: uma action de escrita que resolva apenas a sessão
 * aceita `viewer`. Este teste lê o código das actions e cobra, em cada
 * função que grava, uma verificação de papel — é o tipo de descuido que
 * passa despercebido ao acrescentar uma action nova.
 */
const ACTIONS_DIR = path.join(process.env.CRM_ROOT ?? process.cwd(), "src", "actions");

/** Actions de leitura (ou cuja escrita é do próprio usuário) ficam de fora. */
const READ_ONLY = new Set([
  "getCareer", "getCareerJobs", "getResumeUrl", "exportApplicationsCsv", "exportLeadsCsv",
  "globalSearch", "askAssistant", "getProspectingJob", "getRecentJobs", "testGooglePlaces",
  "markNotificationRead", "markAllNotificationsRead", "markConversationRead",
  "suggestObjectionResponse", "previewCampaignAction",
  // Sessão do próprio visitante.
  "loginAs", "signInWithPassword", "signUpWithPassword", "sendMagicLink", "sendPasswordReset",
  "updatePassword", "logout", "updateUserProfile",
]);

/** O módulo Carreira é do titular: a autorização é por `owner_id`, não por papel. */
const OWNER_SCOPED_FILES = new Set(["career.ts"]);

function actionsOf(source: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  const re = /export async function (\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const start = m.index;
    const next = source.indexOf("\nexport ", start + 1);
    out.push({ name: m[1]!, body: source.slice(start, next === -1 ? undefined : next) });
  }
  return out;
}

describe("actions de escrita exigem papel", () => {
  const files = fs.readdirSync(ACTIONS_DIR).filter((f) => f.endsWith(".ts"));

  it("encontra os arquivos de actions", () => {
    assert.ok(files.length >= 10, `esperava os módulos de actions, achei ${files.length}`);
  });

  for (const file of files) {
    if (OWNER_SCOPED_FILES.has(file)) continue;
    const source = fs.readFileSync(path.join(ACTIONS_DIR, file), "utf-8");
    for (const { name, body } of actionsOf(source)) {
      if (READ_ONLY.has(name)) continue;
      // "Escreve" = altera o estado do servidor.
      const writes = /saveDb\(\)|\.push\(|revalidatePath\(|logActivity\(|emitEvent\(|setLead(Status|Stage)\(|recomputeLeadScore\(|createLeadFromRaw\(|createProspectingJob\(|persist[A-Z]/.test(body);
      if (!writes) continue;
      it(`${file}:${name}`, () => {
        const guarded = /getWriterUser\(\)|getAdminUser\(\)/.test(body);
        assert.ok(guarded, `${name} grava sem verificar papel — um viewer conseguiria executá-la`);
      });
    }
  }
});
