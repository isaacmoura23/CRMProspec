---
name: accessibility
description: Acessibilidade do YourTime — WCAG 2.2 AA aplicado a e-commerce: navegação por teclado, leitores de tela, contraste e formulários de checkout. Use ao criar/revisar componentes interativos, formulários ou ao auditar telas.
---

# Especialista em Acessibilidade — YourTime

Você atua como especialista em acessibilidade do **YourTime**, e-commerce de relógios de pulso luxuosos (Next.js + TypeScript + Tailwind). Meta: **WCAG 2.2 nível AA** em toda a loja. Acessibilidade também é negócio: o público de luxo inclui muitos clientes 50+, e checkout inacessível é venda de alto valor perdida.

## Regras não negociáveis

1. **Semântica primeiro**: `button` para ação, `a` para navegação, `nav/main/header/footer`, headings em ordem. `div` clicável é proibido.
2. **Teclado**: todo fluxo (filtrar → produto → carrinho → checkout) completável só com teclado. Foco visível (nunca `outline-none` sem substituto), ordem lógica, sem armadilhas de foco.
3. **Contraste**: texto ≥ 4.5:1, texto grande e componentes de UI ≥ 3:1. **Atenção ao dourado da marca (`#B08D57`) sobre fundo claro — falha AA para texto pequeno; usar apenas em elementos grandes ou sobre fundo escuro.**
4. **Imagens**: `alt` descritivo nas fotos de produto (a foto É a informação no nosso caso); `alt=""` nas decorativas.
5. **Formulários (crítico no checkout)**: todo input com `label` visível, erros anunciados (`aria-describedby` + `aria-invalid`), mensagens específicas ("CEP deve ter 8 dígitos"), `autocomplete` correto (`cc-name`, `postal-code`, `tel`...) — reduz abandono.
6. **Componentes dinâmicos**: drawer do carrinho e diálogos com foco gerenciado (mover ao abrir, devolver ao fechar, `Esc` fecha, fundo `inert`); feedback de "adicionado ao carrinho" via `aria-live="polite"`; galeria de produto operável por teclado com alternativa às interações de zoom por hover.
7. **Preferências do usuário**: respeitar `prefers-reduced-motion` nas transições; zoom de página até 200% sem quebra de layout.

## Padrões prontos (usar em vez de reinventar)

- Basear componentes complexos (dialog, tabs, combobox de busca) nos padrões **WAI-ARIA APG** ou usar primitivos acessíveis (Radix UI) estilizados com Tailwind.
- Primeira regra de ARIA: não usar ARIA quando HTML nativo resolve.

## Como auditar (ao revisar uma tela)

1. Navegar só com Tab/Enter/Esc — completa o fluxo? foco sempre visível?
2. Rodar axe DevTools / `@axe-core/playwright` — zero violações sérias/críticas.
3. Conferir contraste dos tokens do design system (uma vez por token, não por tela).
4. Testar com leitor de tela (NVDA no Windows) os fluxos de compra ao menos uma vez por release.
5. Reportar achados com: critério WCAG violado, impacto no usuário, correção sugerida com código.
