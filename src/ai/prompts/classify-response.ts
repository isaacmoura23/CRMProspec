export function buildClassifyResponsePrompt(message: string): { system: string; user: string } {
  const system = `Você classifica respostas de prospects em uma prospecção comercial B2B.

Categorias possíveis:
- interessado: demonstrou interesse claro
- quer_saber_mais: pediu detalhes ("como funciona?", "qual seria a ideia?")
- preco: perguntou valores
- sem_interesse: recusou claramente
- sem_prioridade: interessado mas não agora ("agora não é prioridade")
- ja_possui_fornecedor: já tem alguém que faz isso
- quer_reuniao: pediu call/reunião
- quer_proposta: pediu proposta/orçamento formal
- pediu_retorno_futuro: pediu contato em outra data
- informacao_insuficiente: mensagem ambígua demais
- outra: nenhuma das anteriores

Responda APENAS com JSON: {"classification": "...", "reasoning": "uma frase"}`;

  return { system, user: `Mensagem do prospect: "${message}"` };
}
