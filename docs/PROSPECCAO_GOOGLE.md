# Prospecção pelo Google Places: o que guardar e o que custa

Este documento registra um **risco que depende de uma decisão sua** e como o sistema se comporta hoje.

## Como a varredura funciona

- A busca é **nicho × cidade** (Places API, Text Search). O Google devolve poucas dezenas de empresas por busca
  (páginas de 20) e cobra **por chamada**. Telefone (`nationalPhoneNumber`, `internationalPhoneNumber`) e site
  (`websiteUri`) são campos de faixa mais cara: pedir qualquer um deles faz a chamada inteira ser cobrada na faixa mais alta
  (confira os preços atuais na página de preços do Google Maps Platform; valores de terceiros divergem).
- Por isso "todo o Brasil" **não cabe numa execução**. A varredura contínua (Prospectador → "Varredura do Brasil")
  percorre ~110 cidades aos poucos (capitais primeiro), registra a cobertura em `prospect_coverage` e respeita os
  tetos diários de requisições e de leads. O progresso aparece em **Lista de prospecção**.
- "Sem site" inclui a ficha cujo campo "site" aponta para Instagram, Facebook ou Linktree: é a única fonte do Instagram,
  porque a ficha do Maps não tem campo próprio de Instagram.

## O risco: termos do Google Maps Platform

Os Termos Específicos do Google Maps Platform (Places API) permitem guardar **indefinidamente só o `place_id`**; latitude e
longitude podem ser mantidas por até **30 dias corridos**. Para os demais campos (nome, endereço, telefone, nota, site) não
encontrei uma exceção de armazenamento nos termos que consultei — fontes secundárias leem isso como "não pode guardar".
Também **não encontrei regra específica** sobre montar lista de prospecção com esses dados. Isso exige leitura dos termos
vigentes (e, se for o caso, de um advogado) antes de operar em escala.

Hoje o CRM guarda tudo o que a busca devolve como lead (nome, telefone, endereço, ficha do Maps, nota). Se você decidir
reduzir o risco, o mínimo proposto é:

1. guardar o `place_id` (sempre permitido) e consultar o resto na hora de usar;
2. guardar telefone, e-mail e Instagram **só depois** de o lead interagir (respondeu, marcou reunião) ou de você os confirmar
   por outra fonte (o site da empresa, a conversa);
3. renovar ou apagar o que veio do Places em até 30 dias.

Isto é uma **proposta, não uma implementação**: mudar o que se guarda altera o funil inteiro (o Vendedor precisa do
telefone para abordar). A decisão é sua; sem ela o comportamento atual continua.

Fontes: Termos Específicos do Google Maps Platform (cloud.google.com/maps-platform/terms) e a documentação de campos e
faixas do Places (developers.google.com/maps/documentation/places).
