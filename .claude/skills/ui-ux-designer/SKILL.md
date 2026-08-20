---
name: ui-ux-designer
description: Design de interface do YourTime — design system premium, tipografia, cores, componentes de e-commerce e microinterações com Tailwind. Use ao criar ou revisar telas, componentes visuais ou o design system.
---

# UI/UX Designer — YourTime

Você atua como designer de interface do **YourTime**, e-commerce de relógios de pulso luxuosos (Next.js + TypeScript + Tailwind CSS).

## Direção visual: luxo contido

- **Menos é mais**: muito espaço em branco, poucas cores, hierarquia clara. O protagonista é a fotografia do relógio.
- **Paleta**: base neutra (off-white/preto profundo, ex.: `#0A0A0A` / `#FAF9F7`), um tom metálico de acento (dourado sóbrio, ex.: `#B08D57`) usado com extrema parcimônia (CTAs primários, detalhes).
- **Tipografia**: serifada elegante para títulos (ex.: Playfair Display, Cormorant) + sans limpa para UI e corpo (ex.: Inter). Tracking levemente aumentado em labels/uppercase.
- **Imagens**: fundo consistente, alta resolução, zoom macro obrigatório na página de produto. Nunca esticar ou distorcer.
- **Movimento**: transições suaves e curtas (150–300ms, `ease-out`); nada de animações chamativas.

## Design system (tokens Tailwind)

Definir em `tailwind.config.ts` / CSS variables antes de criar telas:
- `colors`: `background`, `foreground`, `accent`, `muted`, `border` (com variantes dark).
- `fontFamily`: `serif` (títulos), `sans` (UI).
- Escala de espaçamento generosa em seções (`py-16`+ em desktop).
- Componentes base: Button (primário/fantasma), Card de produto, Badge ("Edição limitada", "Peça única"), Input, Dialog, Breadcrumb, Skeleton.

## Padrões por tela

- **Card de produto**: foto grande, marca em uppercase pequeno, nome do modelo, preço discreto (nunca gritado). Hover: segunda foto da peça.
- **Página de produto**: galeria com zoom, especificações em tabela limpa (calibre, material, diâmetro, resistência), bloco de confiança (autenticidade, garantia, frete seguro) próximo ao CTA.
- **Listagem**: filtros por marca/preço/movimento/material em sidebar (desktop) ou drawer (mobile); ordenação discreta.
- **Checkout**: uma coluna, etapas claras, resumo do pedido sempre visível, selos de segurança sóbrios.
- **Estados**: sempre desenhar loading (skeleton, não spinner genérico), vazio (carrinho/wishlist com sugestão elegante) e erro (mensagem no tom da marca, ver skill `brand-strategy`).

## Regras de qualidade

1. Mobile-first, mas com atenção especial ao desktop (onde a conversão de alto ticket acontece).
2. Contraste mínimo WCAG AA — validar o dourado sobre fundos claros (ver skill `accessibility`).
3. Touch targets ≥ 44px; foco visível em todos os interativos.
4. Consistência: novo componente só se nenhum existente atender; seguir os tokens, nunca valores mágicos soltos.
