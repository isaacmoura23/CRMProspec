/**
 * Base de dados do provider de diretório de demonstração.
 * Gera empresas realistas por nicho/localização para o modo demo,
 * simulando o retorno de um diretório empresarial.
 */

export interface NicheProfile {
  key: string;
  label: string;
  nameParts: { prefixes: string[]; cores: string[]; suffixes: string[] };
  descriptions: string[];
  catalogBias: Array<"nenhum" | "pequeno" | "medio" | "grande">;
  /** probabilidade de ter site (0–1) */
  websiteRate: number;
  /**
   * Nichos em que o negócio leva o nome do profissional (advogado, personal,
   * corretor). O miolo do nome vem de FIRST_NAMES × SURNAMES em vez da lista
   * fixa de `cores`, o que multiplica o número de empresas distintas.
   */
  personName?: boolean;
}

export const NICHES: NicheProfile[] = [
  {
    key: "imobiliaria",
    label: "Imobiliária",
    nameParts: {
      prefixes: ["Imobiliária", "", "", ""],
      cores: [
        "Horizonte", "Atlântico", "Vale Verde", "Monte Sul", "Costa Azul", "Portal",
        "Raízes", "Alameda", "Nova Era", "Solar", "Meridiano", "Prisma", "Âncora",
        "Boa Vista", "Encosta", "Mirante", "Aliança", "Fortaleza", "Recanto", "Vértice",
      ],
      suffixes: ["Imóveis", "Imobiliária", "Negócios Imobiliários", "Properties", "Imóveis & Cia"],
    },
    descriptions: [
      "Compra, venda e arrendamento de imóveis residenciais e comerciais.",
      "Imobiliária com carteira ativa de imóveis para venda e locação.",
      "Especializada em imóveis residenciais na região.",
    ],
    catalogBias: ["medio", "grande", "grande", "medio"],
    websiteRate: 0.45,
  },
  {
    key: "corretor",
    label: "Corretor de imóveis",
    nameParts: {
      prefixes: ["", "", ""],
      cores: [
        "Ricardo Fontes", "Ana Beatriz Sales", "Miguel Tavares", "Carla Nogueira",
        "Paulo Vidal", "Juliana Peixoto", "André Sampaio", "Fernanda Lacerda",
        "Bruno Cardoso", "Patrícia Amorim", "Diogo Ferreira", "Helena Barros",
      ],
      suffixes: ["Corretor de Imóveis", "Consultoria Imobiliária", "Imóveis", "Corretora"],
    },
    descriptions: [
      "Corretor autônomo com atuação em imóveis residenciais.",
      "Consultoria imobiliária personalizada para compra e venda.",
    ],
    catalogBias: ["pequeno", "medio", "medio"],
    websiteRate: 0.2,
    personName: true,
  },
  {
    key: "loja_veiculos",
    label: "Loja de veículos",
    nameParts: {
      prefixes: ["", "", "Auto"],
      cores: [
        "Rota Sul", "Premium", "Estrela", "Vanguarda", "Turbo", "Sétima Marcha",
        "Grand Prix", "Delta", "Pista Livre", "Máxima", "Central", "Novo Rumo",
      ],
      suffixes: ["Motors", "Veículos", "Multimarcas", "Automóveis", "Car"],
    },
    descriptions: [
      "Loja de veículos seminovos multimarcas com estoque rotativo.",
      "Compra, venda e troca de veículos com financiamento.",
    ],
    catalogBias: ["medio", "grande", "grande"],
    websiteRate: 0.35,
  },
  {
    key: "clinica",
    label: "Clínica",
    nameParts: {
      prefixes: ["Clínica", "Clínica", "Instituto"],
      cores: [
        "Lumina", "Vitalis", "Essenza", "Bem Viver", "Integra", "Renova",
        "Equilíbrio", "Serena", "Aurora", "Plena Saúde", "Vida Ativa", "Nova Pele",
      ],
      suffixes: ["", "Saúde", "Med", "Care"],
    },
    descriptions: [
      "Clínica com atendimento em múltiplas especialidades.",
      "Centro clínico com agendamento por telefone e WhatsApp.",
    ],
    catalogBias: ["pequeno", "medio", "medio"],
    websiteRate: 0.5,
  },
  {
    key: "estetica",
    label: "Estética",
    nameParts: {
      prefixes: ["Espaço", "Studio", "Clínica", ""],
      cores: [
        "Belle", "Essência", "Glow", "Pura", "Afrodite", "Charme", "Realce",
        "Vaidosa", "Iluminar", "Sublime", "Donna", "Fina Flor",
      ],
      suffixes: ["Estética", "Beauty", "Estética Avançada", "& Beleza"],
    },
    descriptions: [
      "Centro de estética com procedimentos faciais e corporais.",
      "Estética avançada com atendimento personalizado.",
    ],
    catalogBias: ["pequeno", "medio"],
    websiteRate: 0.25,
  },
  {
    key: "personal",
    label: "Personal trainer",
    nameParts: {
      prefixes: ["", "", ""],
      cores: [
        "Thiago Muniz", "Larissa Prado", "Felipe Aragão", "Camila Duarte",
        "Rodrigo Bastos", "Vanessa Leal", "Gustavo Pires", "Aline Moura",
      ],
      suffixes: ["Personal Trainer", "Treinamento", "Performance", "Fit"],
    },
    descriptions: [
      "Personal trainer com acompanhamento presencial e online.",
      "Consultoria de treino individualizado.",
    ],
    catalogBias: ["nenhum", "pequeno"],
    websiteRate: 0.1,
    personName: true,
  },
  {
    key: "nutricionista",
    label: "Nutricionista",
    nameParts: {
      prefixes: ["", "", "Dra.", "Dr."],
      cores: [
        "Marina Queirós", "Beatriz Antunes", "Renato Falcão", "Sofia Meireles",
        "Isabela Franco", "Caio Rezende", "Letícia Prado", "Tomás Vieira",
      ],
      suffixes: ["Nutrição", "Nutricionista", "Nutrição Clínica", "Nutri"],
    },
    descriptions: [
      "Atendimento nutricional clínico e esportivo.",
      "Nutricionista com consultas presenciais e online.",
    ],
    catalogBias: ["nenhum", "pequeno"],
    websiteRate: 0.15,
    personName: true,
  },
  {
    key: "arquiteto",
    label: "Arquiteto",
    nameParts: {
      prefixes: ["Studio", "Atelier", "", ""],
      cores: [
        "Norte", "Traço", "Forma Livre", "Eixo", "Cota Zero", "Prumo",
        "Ângulo Reto", "Croqui", "Andaime", "Planta Baixa", "Linhas", "Concreto & Luz",
      ],
      suffixes: ["Arquitetura", "Arquitetos", "Arquitetura & Interiores", "Projetos"],
    },
    descriptions: [
      "Escritório de arquitetura com projetos residenciais e comerciais.",
      "Arquitetura e design de interiores sob medida.",
    ],
    catalogBias: ["pequeno", "medio", "medio"],
    websiteRate: 0.3,
  },
  {
    key: "advogado",
    label: "Advogado",
    nameParts: {
      prefixes: ["", "", ""],
      cores: [
        "Siqueira & Prado", "Vasconcelos", "Menezes & Rocha", "Albuquerque",
        "Teixeira & Couto", "Sarmento", "Bittencourt", "Camargo & Dias",
      ],
      suffixes: ["Advogados", "Advocacia", "Sociedade de Advogados", "& Associados"],
    },
    descriptions: [
      "Escritório de advocacia com atuação em direito civil e empresarial.",
      "Advocacia consultiva e contenciosa.",
    ],
    catalogBias: ["nenhum", "pequeno"],
    websiteRate: 0.5,
    personName: true,
  },
  {
    key: "hotel",
    label: "Hotel",
    nameParts: {
      prefixes: ["Hotel", "Hotel", ""],
      cores: [
        "Maré Alta", "Jardim Real", "Encanto", "Vista do Rio", "Solar dos Reis",
        "Brisa Marinha", "Colina Dourada", "Praça Central", "Miradouro",
      ],
      suffixes: ["", "Palace", "Boutique", "& Spa"],
    },
    descriptions: [
      "Hotel com quartos confortáveis e localização central.",
      "Hospedagem com café da manhã e estacionamento.",
    ],
    catalogBias: ["medio", "grande"],
    websiteRate: 0.6,
  },
  {
    key: "pousada",
    label: "Pousada",
    nameParts: {
      prefixes: ["Pousada", "Pousada", "Refúgio"],
      cores: [
        "das Gaivotas", "do Sol Nascente", "Canto Verde", "Pedra Bonita",
        "Águas Claras", "do Vale", "Flor de Lis", "Maresia", "dos Ipês",
      ],
      suffixes: ["", "", "Charme"],
    },
    descriptions: [
      "Pousada aconchegante com reservas por telefone e WhatsApp.",
      "Hospedagem familiar próxima aos principais pontos da cidade.",
    ],
    catalogBias: ["pequeno", "medio"],
    websiteRate: 0.35,
  },
  {
    key: "loja_roupas",
    label: "Loja de roupas",
    nameParts: {
      prefixes: ["", "Loja", "Ateliê"],
      cores: [
        "Urbana", "Maré", "Vitrine", "Duo", "Essencial", "Trama", "Alfaiataria Fina",
        "Camélia", "Vento Sul", "Puro Estilo", "Linho & Cia", "Nó Cego",
      ],
      suffixes: ["Moda", "Store", "Concept", "Modas", "Boutique"],
    },
    descriptions: [
      "Loja de moda feminina e masculina com novidades semanais.",
      "Vestuário e acessórios com vendas pelo Instagram e WhatsApp.",
    ],
    catalogBias: ["medio", "grande"],
    websiteRate: 0.2,
  },
  {
    key: "restaurante",
    label: "Restaurante",
    nameParts: {
      prefixes: ["Restaurante", "", "Cantina", "Bistrô"],
      cores: [
        "Alecrim", "Fogo Lento", "Panela de Barro", "Dom Sabor", "Tempero da Casa",
        "Mar & Terra", "Braseiro", "Oliveira", "Quintal", "Farinha & Sal",
      ],
      suffixes: ["", "", "Gastronomia", "Grill"],
    },
    descriptions: [
      "Restaurante com pratos executivos e cardápio sazonal.",
      "Cozinha regional com opções para delivery.",
    ],
    catalogBias: ["pequeno", "medio"],
    websiteRate: 0.25,
  },
];

export function nicheByKey(key: string): NicheProfile | undefined {
  return NICHES.find((n) => n.key === key);
}

/**
 * Nicho customizado digitado pelo usuário.
 *
 * O texto digitado vira nome de empresa e rótulo de segmento, então é
 * normalizado: "petshop" viraria "Superior petshop & Cia" na tabela de leads.
 */
export function customNiche(label: string): NicheProfile {
  const clean = label.trim().replace(/\s+/g, " ");
  const titled = clean
    .split(" ")
    .map((w) => (w.length > 2 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
  return {
    key: "custom",
    label: titled,
    nameParts: {
      prefixes: ["Casa", "Grupo", "Studio", ""],
      cores: [
        "Primavera", "Central", "Ideal", "Moderna", "Clássica", "Real",
        "Superior", "Master", "Única", "Seleta", "Notável", "Autêntica",
      ],
      suffixes: [titled, `${titled} & Cia`, "Serviços", ""],
    },
    descriptions: [`Empresa de ${clean.toLowerCase()} com atendimento na região.`],
    catalogBias: ["pequeno", "medio"],
    websiteRate: 0.3,
  };
}

export const STREET_NAMES = [
  "Rua das Acácias", "Avenida Central", "Rua do Comércio", "Avenida Atlântica",
  "Rua São Jorge", "Travessa das Flores", "Avenida da República", "Rua Quinze de Novembro",
  "Rua da Alegria", "Avenida dos Aliados", "Rua Direita", "Rua Nova",
];

export const FIRST_NAMES = [
  "João", "Maria", "Pedro", "Ana", "Carlos", "Sofia", "Tiago", "Inês",
  "Rui", "Marta", "Nuno", "Catarina", "Fábio", "Teresa", "Vasco", "Rita",
  "Ricardo", "Beatriz", "Miguel", "Carla", "Paulo", "Juliana", "André", "Fernanda",
  "Bruno", "Patrícia", "Diogo", "Helena", "Thiago", "Larissa", "Felipe", "Camila",
  "Rodrigo", "Vanessa", "Gustavo", "Aline", "Marina", "Renato", "Leonardo", "Priscila",
  "Eduardo", "Mariana", "Rafael", "Letícia", "Vinícius", "Débora", "Marcelo", "Cristina",
];

/**
 * Sobrenomes usados tanto nos nichos de profissional liberal quanto como
 * miolo alternativo de nomes de empresa ("Imobiliária Andrade"), que é uma
 * forma comum de batizar negócio familiar no Brasil.
 */
export const SURNAMES = [
  "Andrade", "Barbosa", "Cardoso", "Duarte", "Esteves", "Fonseca", "Guimarães",
  "Henriques", "Inácio", "Jardim", "Lacerda", "Macedo", "Nogueira", "Oliveira",
  "Peixoto", "Queirós", "Ribeiro", "Sampaio", "Tavares", "Vasconcelos", "Xavier",
  "Almeida", "Bastos", "Carvalho", "Dantas", "Falcão", "Gonçalves", "Moreira",
  "Pacheco", "Rocha", "Siqueira", "Teixeira", "Vieira", "Amorim", "Braga",
  "Coutinho", "Meireles", "Antunes", "Aragão", "Muniz", "Prado", "Leal",
  "Pires", "Moura", "Sales", "Fontes", "Vidal", "Bonfim",
];

/**
 * Miolos neutros que combinam com qualquer ramo — entram na rotação junto
 * com os nomes específicos do nicho para ampliar o espaço de empresas
 * distintas por cidade.
 */
export const GENERIC_CORES = [
  "Alvorada", "Bandeirantes", "Cristal", "Diamante", "Esplanada", "Guararapes",
  "Ipanema", "Jequitibá", "Laguna", "Marajó", "Navegantes", "Oceânica",
  "Pantanal", "Quaresmeira", "Rio Branco", "Serra Azul", "Tijuca", "Umuarama",
  "Vitória Régia", "Ybirá", "Caravela", "Farol", "Gaivota", "Horizonte Novo",
  "Itapema", "Jurerê", "Ipê Amarelo", "Cedro", "Araucária", "Bougainville",
];

export const OPENING_HOURS = [
  "Seg–Sex 9h–18h",
  "Seg–Sex 9h–19h, Sáb 9h–13h",
  "Seg–Sáb 10h–20h",
  "Todos os dias 8h–22h",
];
