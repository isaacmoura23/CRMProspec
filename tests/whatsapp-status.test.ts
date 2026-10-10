import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { desembrulhar, ehEventoDeStatus, ehGrupoDeConversa, ehTelefoneDeConversa, motivoDeStatus, temConteudoDeConversa } from "@/lib/whatsapp-status";

/** Mínimo do `expect` do Vitest usado aqui, para manter o arquivo igual ao da Cobra. */
function expect<T>(actual: T) {
  return {
    toBe: (e: unknown) => assert.equal(actual, e),
    toEqual: (e: unknown) => assert.deepEqual(actual, e),
    toBeNull: () => assert.equal(actual, null),
    toMatch: (r: RegExp) => assert.match(String(actual), r),
  };
}

/**
 * Portado de agenteitalo/tests/unit/whatsapp-status.test.ts.
 *
 * Eventos com a estrutura que a integração entrega. Status (publicação,
 * marcação, aviso) tem de ser ignorado; conversa de verdade — inclusive
 * resposta a status e menção a participante dentro de grupo — tem de passar.
 */

const CONTATO = "5585999887766@s.whatsapp.net";
const GRUPO = "120363001234567890@g.us";

describe("eventos de status do WhatsApp", () => {
  it("ignora publicação de status (conversa status@broadcast)", () => {
    expect(
      motivoDeStatus({
        key: { remoteJid: "status@broadcast", participant: CONTATO },
        message: { imageMessage: { mimetype: "image/jpeg", caption: "bom dia" } },
        broadcast: true,
      }),
    ).toMatch(/status@broadcast/);
  });

  it("ignora reação a status e variações de caixa do endereço", () => {
    expect(ehEventoDeStatus({ key: { remoteJid: "STATUS@BROADCAST" }, message: { reactionMessage: { text: "❤️" } } })).toBe(true);
    // endereço de status no campo alternativo
    expect(ehEventoDeStatus({ key: { remoteJid: CONTATO, remoteJidAlt: "status@broadcast" }, message: { conversation: "oi" } })).toBe(true);
  });

  it("ignora marcação em status na conversa individual (statusMentionMessage)", () => {
    const motivo = motivoDeStatus({
      key: { remoteJid: CONTATO, participant: CONTATO },
      message: { statusMentionMessage: { message: { protocolMessage: { type: 25 } } } },
    });
    expect(motivo).toBe("tipo statusMentionMessage");
  });

  it("ignora marcação em status dentro de grupo (groupStatusMentionMessage)", () => {
    expect(
      motivoDeStatus({
        key: { remoteJid: GRUPO, participant: CONTATO },
        message: { groupStatusMentionMessage: { message: {} } },
      }),
    ).toBe("tipo groupStatusMentionMessage");
  });

  it("ignora os demais avisos ligados a status", () => {
    expect(ehEventoDeStatus({ key: { remoteJid: CONTATO }, message: { statusAddYours: { message: {} } } })).toBe(true);
    expect(ehEventoDeStatus({ key: { remoteJid: GRUPO }, message: { groupStatusMessage: { message: {} } } })).toBe(true);
    expect(ehEventoDeStatus({ key: { remoteJid: CONTATO }, message: { statusNotificationMessage: {} } })).toBe(true);
    expect(ehEventoDeStatus({ key: { remoteJid: CONTATO }, message: {}, statusPsa: { campaignId: "x" } })).toBe(true);
  });

  it("ignora o aviso que chega como protocolMessage do tipo 25", () => {
    expect(motivoDeStatus({ key: { remoteJid: CONTATO }, message: { protocolMessage: { type: 25, key: { id: "X" } } } })).toMatch(/STATUS_MENTION_MESSAGE/);
    // a integração também pode entregar o nome do tipo
    expect(ehEventoDeStatus({ key: { remoteJid: CONTATO }, message: { protocolMessage: { type: "STATUS_MENTION_MESSAGE" } } })).toBe(true);
    // outro tipo de protocolo não é status (ex.: edição de mensagem)
    expect(ehEventoDeStatus({ key: { remoteJid: CONTATO }, message: { protocolMessage: { type: 14 } } })).toBe(false);
  });

  it("enxerga status mesmo embrulhado (efêmera, ver uma vez, outro aparelho, editada)", () => {
    expect(ehEventoDeStatus({ key: { remoteJid: CONTATO }, message: { ephemeralMessage: { message: { statusMentionMessage: { message: {} } } } } })).toBe(true);
    expect(ehEventoDeStatus({ key: { remoteJid: CONTATO }, message: { viewOnceMessageV2: { message: { groupStatusMentionMessage: { message: {} } } } } })).toBe(true);
    expect(ehEventoDeStatus({ key: { remoteJid: CONTATO }, message: { deviceSentMessage: { message: { protocolMessage: { type: 25 } } } } })).toBe(true);
    // dois embrulhos encaixados
    expect(
      ehEventoDeStatus({
        key: { remoteJid: CONTATO },
        message: { ephemeralMessage: { message: { viewOnceMessageV2Extension: { message: { statusAddYours: { message: {} } } } } } },
      }),
    ).toBe(true);
  });

  it("ignora citação de status sem nada escrito pela pessoa", () => {
    expect(
      motivoDeStatus({
        key: { remoteJid: CONTATO },
        message: { protocolMessage: { contextInfo: { remoteJid: "status@broadcast", quotedMessage: { imageMessage: {} } } } },
      }),
    ).toMatch(/citação de status/);
  });

  // ---------------------------------------------------------- o que deve passar
  it("mantém mensagem comum de contato", () => {
    expect(motivoDeStatus({ key: { remoteJid: CONTATO }, message: { conversation: "Bom dia, chegou a guia?" } })).toBeNull();
    expect(motivoDeStatus({ key: { remoteJid: CONTATO }, message: { imageMessage: { mimetype: "image/jpeg" } } })).toBeNull();
  });

  it("mantém resposta a um status: a pessoa escreveu de verdade", () => {
    expect(
      motivoDeStatus({
        key: { remoteJid: CONTATO },
        message: {
          extendedTextMessage: {
            text: "Parabéns pelo escritório novo!",
            contextInfo: { remoteJid: "status@broadcast", participant: CONTATO, quotedMessage: { imageMessage: {} } },
          },
        },
      }),
    ).toBeNull();
  });

  it("mantém menção a participante dentro de grupo", () => {
    expect(
      motivoDeStatus({
        key: { remoteJid: GRUPO, participant: CONTATO },
        message: {
          extendedTextMessage: {
            text: "@5585999887766 consegue ver isso hoje?",
            contextInfo: { mentionedJid: [CONTATO] },
          },
        },
      }),
    ).toBeNull();
  });

  it("mantém mensagem comum embrulhada em efêmera", () => {
    expect(ehEventoDeStatus({ key: { remoteJid: CONTATO }, message: { ephemeralMessage: { message: { conversation: "oi" } } } })).toBe(false);
  });

  it("desembrulha e reconhece conteúdo de conversa", () => {
    expect(desembrulhar({ ephemeralMessage: { message: { conversation: "oi" } } })).toEqual({ conversation: "oi" });
    expect(desembrulhar({ conversation: "oi" })).toEqual({ conversation: "oi" });
    expect(desembrulhar(null)).toBeNull();
    expect(temConteudoDeConversa({ viewOnceMessageV2: { message: { imageMessage: {} } } })).toBe(true);
    expect(temConteudoDeConversa({ statusMentionMessage: { message: {} } })).toBe(false);
  });

  it("aceita como conversa só telefone em E.164 e grupo @g.us", () => {
    expect(ehTelefoneDeConversa("+5585999887766")).toBe(true);
    expect(ehTelefoneDeConversa("+")).toBe(false);
    expect(ehTelefoneDeConversa("status@broadcast")).toBe(false);
    expect(ehTelefoneDeConversa("")).toBe(false);
    expect(ehGrupoDeConversa("120363001234567890@g.us")).toBe(true);
    expect(ehGrupoDeConversa("558599887766-1234567890@g.us")).toBe(true);
    expect(ehGrupoDeConversa("status@broadcast")).toBe(false);
    expect(ehGrupoDeConversa("120363001234567890@newsletter")).toBe(false);
  });
});
