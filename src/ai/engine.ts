import type { AnalysisOutput, ClassificationOutput } from "@/ai/schemas";
import type { CompanyProfile, Lead, LeadAnalysis, MessageFormat, MessageTone } from "@/types";

/**
 * Engine determinístico de análise e geração de abordagens.
 *
 * É o fallback quando não há OPENAI_API_KEY configurada: produz análises
 * com problemas CONCRETOS derivados dos atributos reais do lead (nunca
 * frases vagas) e mensagens personalizadas usando a análise.
 */

/* ------------------------------------------------------------------ */
/* Análise                                                             */
/* ------------------------------------------------------------------ */

type NicheKind = "catalogo_imoveis" | "catalogo_veiculos" | "catalogo_produtos" | "agendamento" | "portfolio" | "hospedagem" | "restaurante" | "generico";

function nicheKind(segment: string): NicheKind {
  const s = segment.toLowerCase();
  if (s.includes("imobili") || s.includes("corretor")) return "catalogo_imoveis";
  if (s.includes("veícul") || s.includes("veicul") || s.includes("carro") || s.includes("motors")) return "catalogo_veiculos";
  if (s.includes("roupa") || s.includes("moda") || s.includes("loja")) return "catalogo_produtos";
  if (s.includes("clínica") || s.includes("clinica") || s.includes("estética") || s.includes("estetica") || s.includes("nutri") || s.includes("personal") || s.includes("dent")) return "agendamento";
  if (s.includes("arquitet") || s.includes("advog") || s.includes("design") || s.includes("engenh") || s.includes("fotograf")) return "portfolio";
  if (s.includes("hotel") || s.includes("pousada")) return "hospedagem";
  if (s.includes("restaurante") || s.includes("bistrô") || s.includes("cantina") || s.includes("churrasc")) return "restaurante";
  return "generico";
}

interface ProblemTemplate {
  problem: string;
  impact: string;
  solution: string;
  angle: string;
}

function pickProblem(lead: Lead): ProblemTemplate {
  const kind = nicheKind(lead.segment);
  const noSite = !lead.has_website;
  const badSite = lead.website_quality === "ruim";
  const oldSite = lead.website_quality === "desatualizado";
  const insta = lead.instagram && lead.instagram_active;

  switch (kind) {
    case "catalogo_imoveis":
      if (noSite && insta)
        return {
          problem: `A empresa publica os imóveis pelo Instagram (${lead.instagram}), porém não possui uma página própria onde o comprador consiga filtrar as opções por localização, tipo ou faixa de preço. Quem chega pelo perfil precisa rolar o feed ou perguntar pelo WhatsApp o que está disponível.`,
          impact: "Isso aumenta a dependência do atendimento manual e pode fazer potenciais compradores desistirem antes de perguntar quais imóveis estão disponíveis no perfil que procuram.",
          solution: "Site imobiliário com listagem e filtros de imóveis",
          angle: "Facilitar a jornada de quem já chega pelo Instagram sem mudar a operação atual.",
        };
      if (noSite)
        return {
          problem: `A imobiliária divulga a carteira de imóveis apenas por canais de terceiros e atendimento direto: não existe um endereço próprio onde o interessado veja todos os imóveis disponíveis e filtre pelo que procura.`,
          impact: "Cada interessado precisa perguntar o que existe disponível, multiplicando o atendimento manual e perdendo quem prefere pesquisar sozinho.",
          solution: "Site imobiliário com listagem e filtros de imóveis",
          angle: "Dar à carteira de imóveis um endereço próprio e pesquisável.",
        };
      if (badSite)
        return {
          problem: `O site atual (${lead.website}) apresenta problemas visíveis: não se adapta bem ao celular e não permite filtrar imóveis por tipologia ou preço — quem acessa precisa percorrer uma lista única.`,
          impact: "Compradores que chegam pelo Google ou pela bio do Instagram encontram uma experiência que transmite pouca confiança e dificulta achar o imóvel certo.",
          solution: "Site imobiliário profissional com filtros",
          angle: "Substituir o site atual por uma vitrine à altura da carteira de imóveis.",
        };
      return {
        problem: `O site existente não é atualizado com a mesma frequência do Instagram: os imóveis mais recentes aparecem só no perfil, e o site não oferece filtros por localização e faixa de preço.`,
        impact: "O canal que deveria ser a vitrine principal fica defasado, e o comprador volta a depender do atendimento manual para saber o que existe.",
        solution: "Atualização do site com listagem integrada e filtros",
        angle: "Alinhar o site ao ritmo que a imobiliária já mantém no Instagram.",
      };

    case "catalogo_veiculos":
      if (noSite)
        return {
          problem: `A loja publica os veículos individualmente no feed do Instagram e direciona praticamente todo o processo para o WhatsApp. O comprador não possui uma vitrine onde consiga visualizar o estoque completo e filtrar por marca, modelo, ano e faixa de preço.`,
          impact: "Cada interessado precisa perguntar o que existe em estoque, o que multiplica o atendimento manual e afasta compradores que preferem pesquisar sozinhos antes de conversar.",
          solution: "Vitrine digital de estoque com filtros e integração com WhatsApp",
          angle: "Transformar o estoque que já é fotografado todos os dias em uma vitrine navegável, mantendo o fechamento pelo WhatsApp.",
        };
      return {
        problem: `O site atual não reflete o estoque real: veículos já vendidos continuam listados e os recém-chegados aparecem primeiro no Instagram. Não há filtros por marca, ano e preço funcionando corretamente.`,
        impact: "Compradores encontram anúncios desatualizados, perdem confiança e voltam a depender do WhatsApp para saber o que realmente está disponível.",
        solution: "Vitrine de estoque atualizada com gestão simples",
        angle: "Fazer o site refletir o pátio em tempo real.",
      };

    case "catalogo_produtos":
      if (noSite)
        return {
          problem: `As peças são vendidas por stories e direct: não existe um catálogo navegável onde a cliente veja modelos, tamanhos disponíveis e preços sem precisar perguntar. Peças esgotadas continuam recebendo perguntas depois que o story expira.`,
          impact: "A equipe responde dezenas de mensagens repetidas por dia sobre preço e tamanho, e vendas se perdem quando a resposta demora mais que o impulso de compra.",
          solution: "Catálogo online integrado ao WhatsApp",
          angle: "Transformar as perguntas repetidas em um catálogo que vende sozinho.",
        };
      return {
        problem: `O site atual funciona como cartão de visitas, mas não mostra o catálogo com preços e disponibilidade — a venda continua 100% dependente de conversa manual.`,
        impact: "Quem visita fora do horário de atendimento não consegue comprar nem reservar, e a equipe repete as mesmas respostas todos os dias.",
        solution: "Catálogo online com integração ao WhatsApp",
        angle: "Converter o tráfego que já existe em vendas com menos atendimento manual.",
      };

    case "agendamento":
      if (noSite)
        return {
          problem: `Todos os agendamentos dependem de conversa manual no WhatsApp ou telefone: não existe uma página onde o cliente veja os serviços oferecidos, valores de referência e escolha um horário disponível.`,
          impact: "Quem procura fora do horário comercial fica sem resposta imediata, e a recepção gasta horas respondendo as mesmas perguntas sobre serviços e horários.",
          solution: "Landing page de serviços com agendamento online",
          angle: "Reduzir o vai-e-vem no WhatsApp transformando as perguntas repetidas em uma página que responde sozinha.",
        };
      if (oldSite || badSite)
        return {
          problem: `O site existente está defasado: não apresenta os serviços que o negócio mais divulga no Instagram e não oferece nenhuma forma de agendamento online — o cliente precisa ligar em horário comercial.`,
          impact: "Clientes que pesquisam fora do horário comercial não conseguem agendar e parte deles segue para concorrentes com agendamento imediato.",
          solution: "Site atualizado com agendamento online integrado",
          angle: "Alinhar o site à qualidade que o negócio já demonstra no Instagram e destravar agendamentos fora do horário.",
        };
      return {
        problem: `O site atual apresenta o negócio, mas o agendamento continua manual: não há integração entre a agenda real e o que o cliente vê online.`,
        impact: "A conversão de visitante em cliente depende de alguém responder rápido, inclusive fora do expediente.",
        solution: "Agendamento online integrado ao site",
        angle: "Fechar o ciclo: quem conhece o negócio online já sai com horário marcado.",
      };

    case "portfolio":
      if (noSite)
        return {
          problem: `O perfil apresenta os trabalhos realizados, porém não existe uma estrutura própria que reúna portfólio completo, depoimentos e formulário de contato. Quem chega pelo Instagram precisa buscar essas informações manualmente pelos destaques.`,
          impact: "Clientes que pesquisam antes de contratar não encontram um espaço que consolide autoridade, e a primeira impressão fica dependente do algoritmo do Instagram.",
          solution: "Site portfólio com estudos de caso e formulário de contato",
          angle: "Consolidar em um endereço próprio a autoridade já construída no Instagram.",
        };
      return {
        problem: `O site existe mas não mostra os projetos recentes nem depoimentos — o portfólio atualizado vive apenas no Instagram, e o site passa uma imagem menor do que o trabalho real.`,
        impact: "Clientes em fase de decisão comparam portfólios online, e o site desatualizado subvende o trabalho já entregue.",
        solution: "Atualização do site portfólio com estudos de caso",
        angle: "Fazer o site vender o trabalho tão bem quanto o Instagram já vende.",
      };

    case "hospedagem":
      if (noSite)
        return {
          problem: `As reservas dependem de portais que cobram comissão por hóspede: não existe canal próprio onde o viajante veja fotos dos quartos, disponibilidade e faça reserva direta.`,
          impact: "Parte da margem de cada reserva é entregue às plataformas, e hóspedes que reservariam direto fecham pelos portais por falta de alternativa clara.",
          solution: "Site com motor de reservas diretas",
          angle: "Converter a reputação conquistada nas plataformas em reservas diretas sem comissão.",
        };
      return {
        problem: `O site atual mostra o espaço mas não permite reservar: o hóspede vê as fotos e é mandado para telefone ou para os portais com comissão.`,
        impact: "O site gera interesse mas não captura a reserva, entregando a conversão (e a comissão) às OTAs.",
        solution: "Motor de reservas diretas integrado ao site",
        angle: "Fechar a reserva no canal próprio, sem intermediários.",
      };

    case "restaurante":
      if (noSite)
        return {
          problem: `O cardápio e os horários vivem apenas em posts do Instagram: quem procura o restaurante no Google não encontra um cardápio atualizado, e reservas/encomendas dependem de ligação ou direct.`,
          impact: "Clientes em dúvida sobre menu e preço desistem antes de perguntar, principalmente turistas e clientes de primeira visita.",
          solution: "Página com cardápio atualizado e reservas/pedidos",
          angle: "Responder online as perguntas que hoje travam a decisão de visita.",
        };
      return {
        problem: `O site existe mas o cardápio publicado está desatualizado em relação ao que o restaurante divulga nas redes — preços e pratos não batem.`,
        impact: "A divergência gera atrito no atendimento e desconfiança de novos clientes.",
        solution: "Cardápio digital único atualizável pela equipe",
        angle: "Uma única fonte de verdade para cardápio e preços.",
      };

    case "generico":
    default:
      if (noSite)
        return {
          problem: `O negócio atende apenas por canais diretos (telefone/WhatsApp${lead.instagram ? "/Instagram" : ""}): não existe uma página própria que apresente os serviços, diferenciais e formas de contato para quem pesquisa online.`,
          impact: "Quem pesquisa o negócio no Google antes de comprar não encontra uma presença própria, e a comparação com concorrentes estruturados fica desfavorável.",
          solution: "Site institucional com apresentação de serviços",
          angle: "Garantir que quem pesquisa o negócio encontre uma presença à altura do serviço prestado.",
        };
      return {
        problem: `O site atual está desatualizado: as informações não refletem os serviços atuais do negócio e não há chamada clara para contato ou orçamento.`,
        impact: "Visitantes interessados não encontram um próximo passo claro e a conversão depende de insistência do cliente.",
        solution: "Atualização do site com foco em conversão",
        angle: "Transformar o site de cartão de visitas em canal de captação.",
      };
  }
}

export function engineAnalyze(lead: Lead): AnalysisOutput {
  const t = pickProblem(lead);
  const strengths: string[] = [];
  if (lead.instagram && lead.instagram_active) strengths.push("Instagram ativo com publicações frequentes");
  if ((lead.reviews_count ?? 0) >= 20 && (lead.rating ?? 0) >= 4.3)
    strengths.push(`Boa reputação no Google (${lead.rating} com ${lead.reviews_count} avaliações)`);
  if (lead.catalog_size === "grande") strengths.push("Catálogo/portfólio amplo e ativo");
  if (lead.marketing_signals) strengths.push("Sinais de investimento em marketing");
  if (lead.whatsapp) strengths.push("Atendimento rápido via WhatsApp");
  if (strengths.length === 0) strengths.push("Negócio ativo com atendimento direto ao cliente");

  const presenceParts: string[] = [];
  if (lead.instagram)
    presenceParts.push(`Instagram ${lead.instagram_active ? "ativo" : "presente mas pouco ativo"} (${lead.instagram})`);
  if (lead.facebook) presenceParts.push("página no Facebook");
  if ((lead.reviews_count ?? 0) > 0)
    presenceParts.push(`${lead.reviews_count} avaliações no Google com nota ${lead.rating}`);
  presenceParts.push(
    lead.has_website
      ? `site ${lead.website_quality === "bom" ? "profissional" : lead.website_quality === "ruim" ? "com problemas visíveis" : "desatualizado"} (${lead.website})`
      : "nenhum site próprio encontrado"
  );

  // Confidence honesto: quanto menos dados, menor a confiança.
  let confidence = 88;
  if (!lead.instagram) confidence -= 10;
  if ((lead.reviews_count ?? 0) === 0) confidence -= 10;
  if (!lead.description) confidence -= 6;
  if (nicheKind(lead.segment) === "generico") confidence -= 8;

  return {
    digital_presence_summary: `${presenceParts.join(", ")}.`.replace(/^./, (c) => c.toUpperCase()),
    strengths: strengths.slice(0, 4),
    main_problem: t.problem,
    problem_impact: t.impact,
    recommended_solution: t.solution,
    commercial_angle: t.angle,
    confidence: Math.max(40, confidence),
  };
}

/* ------------------------------------------------------------------ */
/* Abordagens                                                          */
/* ------------------------------------------------------------------ */

function firstName(lead: Lead): string | null {
  if (!lead.contact_name) return null;
  const clean = lead.contact_name.replace(/^(dr\.?a?|dra\.?)\s+/i, "");
  return clean.split(/\s+/)[0] ?? null;
}

/** Resume o problema para caber em uma frase de mensagem */
function problemPhrase(analysis: LeadAnalysis): string {
  // usa a primeira sentença do problema, minúscula inicial
  const first = analysis.main_problem.split(/(?<=[.!?])\s/)[0].replace(/\.$/, "");
  return first.charAt(0).toLowerCase() + first.slice(1);
}

const OPENERS_BR = ["Olá, tudo bem?", "Oi, tudo certo?", "Olá! Tudo bem por aí?"];
const OPENERS_PT = ["Olá, tudo bem?", "Boa tarde! Tudo bem?", "Olá! Espero que esteja tudo bem."];

function pick<T>(arr: T[], variant: number): T {
  return arr[variant % arr.length];
}

export function engineOutreach(
  lead: Lead,
  analysis: LeadAnalysis,
  profile: CompanyProfile,
  format: MessageFormat,
  tone: MessageTone,
  variant = 0,
  followUpContext?: string
): string {
  const name = firstName(lead);
  const isPT = lead.country === "Portugal";
  const opener = name
    ? `${isPT ? "Olá" : pick(["Oi", "Olá", "Fala"], variant)} ${name}, tudo ${pick(["bem", "certo"], variant)}?`
    : pick(isPT ? OPENERS_PT : OPENERS_BR, variant);

  const context = pick(
    [
      `Dei uma olhada no ${lead.instagram ? "perfil de vocês no Instagram" : "trabalho de vocês"} e reparei uma coisa.`,
      `Estava conhecendo o ${lead.instagram ? "Instagram de vocês" : "negócio de vocês"} e percebi um detalhe.`,
      `Acompanhei o ${lead.instagram ? "perfil de vocês" : "que vocês fazem"} esses dias e notei algo.`,
    ],
    variant
  );

  const problem = problemPhrase(analysis);
  const curiosity = pick(
    [
      "Pensei em uma forma de facilitar justamente essa parte, sem mudar a maneira como vocês já trabalham.",
      "Tenho uma ideia simples pra resolver exatamente isso, sem mexer no que já funciona pra vocês.",
      "Imaginei um jeito de destravar isso aproveitando o que vocês já fazem bem.",
    ],
    variant
  );
  const ask = pick(["Posso te mostrar?", "Quer que eu te explique rapidinho?", "Faz sentido eu te mostrar como seria?"], variant);

  switch (format) {
    case "curta":
      return `${opener} ${context.replace(/\.$/, ":")} ${problem}. ${curiosity} ${ask}`;

    case "consultiva":
      return `${opener}\n\n${context} ${problem.charAt(0).toUpperCase() + problem.slice(1)}.\n\n${analysis.problem_impact}\n\n${curiosity} ${ask}`;

    case "whatsapp":
      return `${opener} ${context} ${problem.charAt(0).toUpperCase() + problem.slice(1)}. ${curiosity} ${ask}`;

    case "instagram_dm":
      return `${opener} ${pick(
        [
          "Cheguei no perfil de vocês hoje e passei um tempo olhando as publicações.",
          "Vi o perfil de vocês pelo explorar e fiquei um tempo navegando.",
        ],
        variant
      )} Reparei que ${problem}. ${curiosity} ${ask}`;

    case "email": {
      const subject = pick(
        [
          `Assunto: Uma ideia para ${lead.company_name}`,
          `Assunto: Sobre ${lead.instagram ? "o Instagram" : "a presença online"} de vocês`,
          `Assunto: Notei algo no ${lead.instagram ? "perfil" : "site"} de vocês`,
        ],
        variant
      );
      const sender = profile.company_name;
      return `${subject}\n\n${opener}\n\nMe chamo ${sender.split(" ")[0] === sender ? sender : "equipe " + sender}${name ? "" : ""} e trabalho ajudando negócios como o de vocês. ${context} ${problem.charAt(0).toUpperCase() + problem.slice(1)}.\n\n${analysis.problem_impact}\n\n${curiosity}\n\n${ask}\n\nAbraço,\n${sender}`;
    }

    case "audio": {
      const audioName = name ? `Fala ${name}, tudo certo?` : "Oi, tudo certo?";
      return `${isPT && name ? `Olá ${name}, tudo bem?` : audioName} Eu ${pick(["tava", "estava"], isPT ? 1 : variant)} dando uma olhada no ${lead.instagram ? `perfil de vocês` : "negócio de vocês"} e percebi uma coisa... ${problem.charAt(0).toUpperCase() + problem.slice(1)}. E aí o que acontece é que ${analysis.problem_impact.charAt(0).toLowerCase() + analysis.problem_impact.slice(1)} Eu pensei numa forma de organizar isso sem atrapalhar o processo que vocês já usam hoje. Queria te explicar rapidinho e ver se faz sentido ${isPT ? "para" : "pra"} vocês. Qualquer coisa me ${isPT ? "diga" : "fala"}, combinado?`;
    }

    case "follow_up": {
      const ref = followUpContext
        ? pick(
            [
              `Na última conversa você comentou: "${followUpContext}".`,
              `Lembro que você mencionou que ${followUpContext.charAt(0).toLowerCase() + followUpContext.slice(1).replace(/"/g, "")}`,
            ],
            variant
          )
        : "Te mandei uma mensagem há alguns dias sobre uma ideia pro negócio de vocês.";
      return `${opener} ${ref} ${pick(
        [
          "Sem pressa nenhuma — só queria saber se agora é um momento melhor pra te mostrar o que eu tinha pensado.",
          "Passando só pra deixar a porta aberta: se fizer sentido, te mostro a ideia em 5 minutos.",
          "Se ainda não for o momento, tudo bem. Só não queria que a ideia se perdesse, porque tem tudo a ver com o que vocês já fazem.",
        ],
        variant
      )}`;
    }
  }
}

/** Aplica ajustes simples de tom sobre o texto do engine */
export function applyTone(text: string, tone: MessageTone): string {
  switch (tone) {
    case "mais_curto": {
      const sentences = text.split(/(?<=[.!?])\s+/);
      if (sentences.length <= 3) return text;
      return [...sentences.slice(0, 2), sentences[sentences.length - 1]].join(" ");
    }
    case "mais_direto":
      return text
        .replace(/Sem pressa nenhuma — só queria/g, "Queria")
        .replace(/Queria te explicar rapidinho e ver se faz sentido/g, "Consigo te explicar em 5 minutos. Vê se faz sentido")
        .replace(/Posso te mostrar\?/g, "Te mostro em 5 minutos?");
    case "mais_informal":
      return text
        .replace(/Olá/g, "Oi")
        .replace(/tudo bem\?/g, "tudo certo?")
        .replace(/para vocês/g, "pra vocês")
        .replace(/estava/g, "tava");
    case "mais_profissional":
      return text
        .replace(/Fala /g, "Olá ")
        .replace(/\btava\b/g, "estava")
        .replace(/\bpra\b/g, "para")
        .replace(/rapidinho/g, "rapidamente");
    default:
      return text;
  }
}

/* ------------------------------------------------------------------ */
/* Classificação de respostas                                          */
/* ------------------------------------------------------------------ */

export function engineClassify(message: string): ClassificationOutput {
  const m = message.toLowerCase();
  const rules: Array<[RegExp, ClassificationOutput["classification"], string]> = [
    [/quanto (custa|fica|sai|é)|valor|preço|preco|investimento/, "preco", "Perguntou sobre valores."],
    [/como funciona|qual (seria )?a ideia|o que (você|vc) pensou|pode (me )?explicar|me conta|quero saber mais|como seria/, "quer_saber_mais", "Pediu detalhes sobre a ideia."],
    [/reuni(ão|ao)|call|videochamada|meet|agendar|marcar (um|uma)/, "quer_reuniao", "Pediu uma conversa agendada."],
    [/proposta|orçamento|orcamento/, "quer_proposta", "Pediu proposta ou orçamento."],
    [/não (tenho|temos) interesse|não preciso|nao preciso|não quero|nao quero|pare de|remover/, "sem_interesse", "Recusou claramente."],
    [/já (tenho|temos|possuo)|ja (tenho|temos)|já trabalho com|tenho um sobrinho|tenho alguém/, "ja_possui_fornecedor", "Indicou que já tem quem faça."],
    [/não é prioridade|nao é prioridade|agora não|agora nao|momento (ruim|corrido)|sem tempo agora/, "sem_prioridade", "Interessado mas não agora."],
    [/mês que vem|mes que vem|semana que vem|me (chama|liga|procura) (em|mês|mes|daqui)|mais pra frente|futuramente|depois d[oe]/, "pediu_retorno_futuro", "Pediu contato em outra data."],
    [/interessante|gostei|adorei|top|show|legal|faz sentido|quero sim|vamos/, "interessado", "Demonstrou interesse."],
  ];
  for (const [re, cls, reason] of rules) {
    if (re.test(m)) return { classification: cls, reasoning: reason };
  }
  if (m.trim().length < 8) return { classification: "informacao_insuficiente", reasoning: "Mensagem curta e ambígua." };
  return { classification: "outra", reasoning: "Não se encaixa nas categorias conhecidas." };
}

/* ------------------------------------------------------------------ */
/* Objeções                                                            */
/* ------------------------------------------------------------------ */

const OBJECTION_RESPONSES: Array<[RegExp, string]> = [
  [/car[oa]|preço|preco|valor/, "Entendo perfeitamente — investimento tem que fazer sentido. Só uma pergunta antes de falarmos de valor: se o custo não fosse um fator, isso resolveria um problema real pra vocês hoje? Se sim, consigo te mostrar formas de começar menor e crescer conforme o retorno aparecer."],
  [/agora não|agora nao|prioridade|momento/, "Faz total sentido, cada fase da empresa tem suas prioridades. Posso te perguntar o que está no topo da lista agora? Às vezes o que eu tinha pensado até ajuda nisso — e se não for o caso, te procuro num momento melhor, sem problema."],
  [/não preciso|nao preciso|não vejo necessidade/, "Justo! Só pra eu entender melhor: hoje, quando alguém conhece vocês pelo Instagram e quer ver tudo o que vocês oferecem, como funciona? Pergunto porque foi exatamente nesse ponto que eu vi uma oportunidade — mas pode ser que vocês já tenham isso resolvido de outra forma."],
  [/já tenho site|ja tenho site/, "Que bom que vocês já têm essa base! O que eu notei não foi a ausência do site, e sim um ponto específico de como ele conversa (ou não) com o movimento que vocês geram no Instagram. Posso te mostrar o que eu vi? Se estiver tudo certo por aí, ótimo — você perde só 2 minutos."],
  [/já tenho (alguém|quem|fornecedor)|ja tenho (alguém|quem)/, "Perfeito, ter alguém de confiança vale muito. Não quero atrapalhar isso — só deixo a porta aberta: se em algum momento precisarem de uma segunda opinião ou de algo pontual que a pessoa não faça, me chama. Posso te deixar meu contato?"],
  [/sócio|socio|conversar com/, "Claro, decisão a dois tem que ser alinhada mesmo. Quer que eu te mande um resumo curtinho do que conversamos pra facilitar a conversa com seu sócio? Aí vocês avaliam juntos com calma."],
  [/mês que vem|mes que vem|me chama depois|mais pra frente/, "Combinado! Vou anotar aqui e te procuro nessa data. Só uma coisa pra eu chegar mais preparado: tem algo específico que precisa acontecer até lá, ou é mais uma questão de agenda mesmo?"],
];

export function engineObjection(objection: string): string {
  const o = objection.toLowerCase();
  for (const [re, resp] of OBJECTION_RESPONSES) {
    if (re.test(o)) return resp;
  }
  return "Entendo seu ponto — e agradeço a franqueza. Me ajuda a entender melhor o que pesa mais nessa decisão pra vocês? Assim eu consigo te dizer com honestidade se o que eu pensei faz sentido ou não pro momento de vocês.";
}
