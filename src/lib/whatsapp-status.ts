/**
 * Portado de agenteitalo/src/lib/whatsapp-status.ts (projeto Cobra), sem alterações
 * de lógica; os testes vieram junto (tests/whatsapp-status.test.ts).
 *
 * Identificação de eventos de **status** do WhatsApp (as "histórias" de 24h).
 *
 * Status não é conversa: publicações, marcações ("fulano mencionou você no
 * status"), reações e avisos ligados a status não podem virar contato, grupo,
 * mensagem, contador de não lidas, fila de atendimento, cobrança ou automação.
 *
 * O endereço `status@broadcast` sozinho não basta: a marcação em status chega
 * **dentro da conversa individual ou do grupo**, com o tipo próprio
 * (`statusMentionMessage`, `groupStatusMentionMessage`, …) ou como
 * `protocolMessage` do tipo `STATUS_MENTION_MESSAGE` (25). O conteúdo ainda
 * pode vir embrulhado (mensagem efêmera, ver uma vez, enviada por outro
 * aparelho, editada), então a verificação desembrulha antes de decidir.
 *
 * Resposta a um status é outra coisa: a pessoa escreveu de verdade, com o
 * status apenas citado. Isso é conversa e **continua valendo**.
 */

export const STATUS_JID = "status@broadcast";

/** Tipos de mensagem que existem só por causa de status. */
const TIPOS_DE_STATUS = [
  "statusMentionMessage",
  "groupStatusMentionMessage",
  "statusAddYours",
  "groupStatusMessage",
  "statusNotificationMessage",
  "statusPsaMessage",
] as const;

/** Embrulhos que escondem o conteúdo de verdade um nível abaixo. */
const EMBRULHOS = [
  "ephemeralMessage",
  "viewOnceMessage",
  "viewOnceMessageV2",
  "viewOnceMessageV2Extension",
  "documentWithCaptionMessage",
  "editedMessage",
  "deviceSentMessage",
  "botInvokeMessage",
] as const;

/** Conteúdo que uma pessoa realmente escreveu ou enviou. */
const TIPOS_DE_CONVERSA = [
  "conversation",
  "extendedTextMessage",
  "imageMessage",
  "videoMessage",
  "audioMessage",
  "documentMessage",
  "stickerMessage",
  "contactMessage",
  "contactsArrayMessage",
  "locationMessage",
  "liveLocationMessage",
  "pollCreationMessage",
  "pollCreationMessageV2",
  "pollCreationMessageV3",
  "ptvMessage",
] as const;

/** Tipo do `protocolMessage` que anuncia marcação em status. */
const PROTOCOL_STATUS_MENTION = 25;

type Objeto = Record<string, unknown>;

export type EventoWhatsapp = {
  key?: { remoteJid?: string | null; remoteJidAlt?: string | null; participant?: string | null; participantAlt?: string | null } | null;
  message?: Objeto | null;
  broadcast?: boolean | null;
  statusPsa?: unknown;
  messageStubType?: number | string | null;
};

function ehObjeto(v: unknown): v is Objeto {
  return typeof v === "object" && v !== null;
}

function ehJidDeStatus(jid?: string | null): boolean {
  return typeof jid === "string" && jid.trim().toLowerCase() === STATUS_JID;
}

/**
 * Tira os embrulhos (efêmera, ver uma vez, enviada por outro aparelho,
 * editada) e devolve o conteúdo de dentro. Para em 6 níveis: embrulho
 * repetido sem fim é evento malformado, não conversa.
 */
export function desembrulhar(message?: Objeto | null): Objeto | null {
  let atual: Objeto | null = ehObjeto(message) ? message : null;
  for (let i = 0; i < 6 && atual; i++) {
    const embrulho = EMBRULHOS.find((nome) => ehObjeto(atual![nome]));
    if (!embrulho) return atual;
    const dentro = atual[embrulho] as Objeto;
    const proximo = ehObjeto(dentro.message) ? (dentro.message as Objeto) : null;
    if (!proximo) return atual;
    atual = proximo;
  }
  return atual;
}

/** Percorre a mensagem e todos os seus embrulhos, de fora para dentro. */
function camadas(message?: Objeto | null): Objeto[] {
  const encontradas: Objeto[] = [];
  let atual: Objeto | null = ehObjeto(message) ? message : null;
  for (let i = 0; i < 6 && atual; i++) {
    encontradas.push(atual);
    const embrulho = EMBRULHOS.find((nome) => ehObjeto(atual![nome]));
    if (!embrulho) break;
    const dentro = atual[embrulho] as Objeto;
    atual = ehObjeto(dentro.message) ? (dentro.message as Objeto) : null;
  }
  return encontradas;
}

/** A pessoa escreveu ou enviou alguma coisa nesta mensagem? */
export function temConteudoDeConversa(message?: Objeto | null): boolean {
  return camadas(message).some((camada) => TIPOS_DE_CONVERSA.some((tipo) => camada[tipo] !== undefined && camada[tipo] !== null));
}

function contextoDeStatus(camada: Objeto): boolean {
  for (const tipo of [...TIPOS_DE_CONVERSA, "protocolMessage"]) {
    const conteudo = camada[tipo];
    if (!ehObjeto(conteudo)) continue;
    const ctx = conteudo.contextInfo;
    if (ehObjeto(ctx) && ehJidDeStatus(ctx.remoteJid as string)) return true;
  }
  const ctx = camada.contextInfo;
  return ehObjeto(ctx) && ehJidDeStatus(ctx.remoteJid as string);
}

/**
 * Diz se o evento é de status e por quê (o motivo entra no log). Devolve
 * `null` para conversa de verdade — inclusive resposta a um status e menção a
 * participante dentro de grupo.
 */
export function motivoDeStatus(evento: EventoWhatsapp): string | null {
  const remoteJid = evento.key?.remoteJid ?? null;
  const remoteJidAlt = evento.key?.remoteJidAlt ?? null;

  // 1) A própria conversa é a de status (publicação e reação a publicação).
  if (ehJidDeStatus(remoteJid) || ehJidDeStatus(remoteJidAlt)) return "conversa status@broadcast";

  const partes = camadas(evento.message);

  // 2) Tipo próprio de status, em qualquer camada do embrulho.
  for (const camada of partes) {
    const tipo = TIPOS_DE_STATUS.find((nome) => camada[nome] !== undefined && camada[nome] !== null);
    if (tipo) return `tipo ${tipo}`;
  }

  // 3) Aviso de marcação em status vindo como protocolMessage.
  for (const camada of partes) {
    const protocolo = camada.protocolMessage;
    if (!ehObjeto(protocolo)) continue;
    const tipo = protocolo.type;
    if (tipo === PROTOCOL_STATUS_MENTION || tipo === "STATUS_MENTION_MESSAGE") return "protocolMessage STATUS_MENTION_MESSAGE";
  }

  // 4) Metadados do próprio evento.
  if (evento.statusPsa !== undefined && evento.statusPsa !== null) return "statusPsa";
  if (evento.messageStubType === PROTOCOL_STATUS_MENTION || evento.messageStubType === "STATUS_MENTION_MESSAGE") return "messageStubType de status";

  // 5) Citação de status **sem nada escrito pela pessoa**: é aviso de status.
  //    Com texto ou mídia própria é resposta ao status — conversa de verdade.
  if (!temConteudoDeConversa(evento.message) && partes.some(contextoDeStatus)) return "citação de status sem conteúdo próprio";
  if (evento.broadcast === true && partes.some(contextoDeStatus) && !temConteudoDeConversa(evento.message)) return "difusão de status";

  return null;
}

/** Conveniência para quem só precisa do sim/não. */
export function ehEventoDeStatus(evento: EventoWhatsapp): boolean {
  return motivoDeStatus(evento) !== null;
}

/**
 * Identificador de conversa aceitável: telefone em E.164 ou grupo `@g.us`.
 * Serve de última barreira antes de gravar — `status@broadcast` e qualquer
 * endereço estranho não viram contato nem grupo.
 */
export function ehTelefoneDeConversa(peer?: string | null): boolean {
  return typeof peer === "string" && /^\+\d{10,15}$/.test(peer.trim());
}

export function ehGrupoDeConversa(jid?: string | null): boolean {
  return typeof jid === "string" && /^\d{5,}(-\d+)?@g\.us$/.test(jid.trim());
}
