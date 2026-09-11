# NORMALIZAR PEDIDO — botão de ação Sankhya

Normaliza pedidos de marketplace (TOP 1755) no Sankhya: recalcula os valores
dos itens a partir do preço de venda real do canal, gerencia a linha de KP e
ajusta os campos do cabeçalho.

**Status: em homologação com operadores.**

| | |
|---|---|
| Arquivo | `Normalizar pedido v6.js` |
| Tipo | Ação de tabela — Script (JavaScript) |
| Instância | `CabecalhoNota` / **TGFCAB** |
| Nome do botão | NORMALIZAR PEDIDO |
| Motor | Rhino, Java 8 — código **ES5** |
| Banco | Oracle |

`Normalizar pedido v5.js` fica no repositório como referência histórica.
Ver [`Diagnostico.md`](Diagnostico.md) para a trilha da investigação.

---

## O problema em uma frase

O TemApi grava o `VLRUNIT` dividido pelo fator de IPI mas o `VLRDESC` sem
dividir, e envia desconto absoluto calculado contra uma base diferente da que
o ERP aplica. O item chega com valor errado e o operador refaz à mão.

Este script é **plano B**. A correção definitiva é o TemApi.

---

## A mudança da v5 para a v6

A v5 **replicava** o motor fiscal: calculava `BASEIPI`, `VLRIPI`, `BASEICMS` e
`VLRICMS` por conta própria, com auto-calibração para descobrir qual dos dois
regimes de ICMS valia em cada item.

Depois descobriu-se que o motor **é alcançável por script**:

```javascript
var IH = newJava("br.com.sankhya.modelcore.comercial.impostos.ImpostosHelpper");
IH.setForcarRecalculo(true);
IH.calcularImpostos(linhas[0].getCampo("NUNOTA"));
```

Provado no pedido 202443: gravando `VLRUNIT`/`VLRTOT` = 100,00 pelo Jape e
chamando o recálculo, o Sankhya produziu `BASEIPI` 100,00, `VLRIPI` 6,50,
`BASEICMS` −154,40 e `VLRICMS` −27,79 — exatamente a fórmula, inclusive nos
negativos (o desconto de 260,90 seguia intacto no teste). O `VLRNOTA` também
recalcula junto. E o `ImpostosHelpper` **respeita a transação**: após o
`throw`, o pedido voltou integralmente ao estado anterior.

**Resultado:** a v6 grava apenas valores — `VLRUNIT`, `VLRTOT`, `VLRDESC`,
`PERCDESC` — e o ERP calcula o fiscal. Saiu a auto-calibração, saiu o cálculo
de bases e impostos, saiu a gravação do `VLRNOTA`, e saiu a ressalva de
arquitetura sobre replicar o motor fiscal.

O script decide apenas regra de negócio da casa: reconstrução do preço de
venda, desconto Pix por canal, faixa de KP, desconto de arredondamento e
campos de cabeçalho.

---

## Por que a ação é sobre TGFCAB

O cálculo da faixa de KP depende da **venda total do pedido**. Numa ação sobre
TGFITE, se o operador selecionasse um item só, o cálculo sairia errado.

O cabeçalho é gravado pelo registro da tela (`linhas[0].setCampo` + `save()`)
e os itens pelo Jape.

---

## Configuração

```javascript
var SIMULACAO        = true;    // true = só relatório, nada é gravado
var GRAVAR_CABECALHO = false;   // chaves independentes, ligar uma por vez
var GRAVAR_ITENS     = false;
var GRAVAR_KP        = false;

var RECALCULAR_IMPOSTOS = true; // ImpostosHelpper — só roda com itens ou KP
var GRAVAR_FINANCEIRO   = false; // ver "Financeiro" abaixo — NÃO funciona

var PIX_HABILITADO      = true;
var CAMPO_CANAL         = "AD_CANAL_MKTPLACE";
var CANAL_ABSORVE_PIX   = "SHOPEE";
var CANAL_SO_ZERA       = "MERCADO_LIVRE";
var RECUSAR_CANAL_DESCONHECIDO = true;

var CODCENCUS_ALVO      = 20000000;   // MARKETPLACE
var CODTIPOPER_ESPERADO = 1755;       // PEDIDO MARKETPLACE
var CAMPO_OBS_INTERNA   = "AD_INTERNAOBS";
var PRESERVAR_OBS_INTERNA = true;     // não sobrescreve autoria de outro operador
var TIPFRETE_EXTRANOTA  = "N";        // confirmado na tela
var TIPFRETE_INCLUSO    = null;       // "S" após confirmar na tela
var SCH                 = "";         // "SANKHYA." se der ORA-00942
```

### Tabela de KP

```javascript
var KP_TABLE = [
  { sku: 2310, nome: 'KP1',  vl:  29.90, min:   74.75, max:  200.00 },
  { sku: 2311, nome: 'KP3',  vl:  89.70, min:  200.00, max:  448.50 },
  { sku: 2312, nome: 'KP6',  vl: 179.40, min:  448.50, max:  897.00 },
  { sku: 2313, nome: 'KP9',  vl: 269.10, min:  897.00, max: 1345.50 },
  { sku: 2314, nome: 'KP12', vl: 358.80, min: 1345.50, max: 1794.00 },
  { sku: 2315, nome: 'KP18', vl: 538.20, min: 1794.00, max: 2691.00 },
  { sku: 2316, nome: 'KP24', vl: 717.60, min: 2691.00, max: 3588.00 }
];
```

Venda abaixo de 74,75 → sem KP. Acima de 3.588,00 → KP24 (teto).

---

## Fluxo

```
1. LER          cabeçalho (Jape) + itens + financeiro (getQuery)
2. VALIDAR      TOP, consistência dos itens, regra de Pix, classe de impostos
3. CALCULAR     venda → devolver KP → Pix → faixa → alvos → valores
4. RELATAR      antes → depois de cada campo
5. (parar aqui se SIMULACAO ou se houver erro)
6. GRAVAR       cabeçalho → itens → KP → ImpostosHelpper
7. VERIFICAR    reler do banco e comparar; divergência → throw = ROLLBACK
8. RETORNAR     mensagem = texto
```

**A ordem importa.** O cabeçalho vai primeiro por dois motivos: o
`Registro.save()` usa o snapshot em memória e sobrescreveria o `VLRNOTA` que o
motor calcular depois; e o `VLRDESCTOT` precisa estar zerado antes do
recálculo, senão o Pix é descontado duas vezes (visto no 202443: `VLRNOTA`
veio 111,20 em vez de 125,10).

---

## Dissecando

### 1. Reconstrução da venda

O preço real do canal não está em campo nenhum. É reconstruído:

```javascript
descUnit    = vlrdesc / qtd              // VLRDESC é total da linha
vendaUnit   = round2(vlrunit * (1 + aliqipi/100) - descUnit)
vendaLinha  = round2(vendaUnit * qtd)
```

Item cuja venda reconstruída dê zero ou negativo é **recusado**.

### 2. Idempotência — devolver o KP à base

Num pedido já normalizado o KP foi retirado dos produtos e virou linha
própria. A faixa é decidida pelo **total da venda incluindo o KP**, então o
KP existente precisa voltar à base antes de recalcular. Sem isso, clicar duas
vezes subtrairia o KP duas vezes.

Confirmado em 7 de 7 pedidos já normalizados — a base "produtos apenas"
erraria a faixa em dois deles.

### 3. Desconto Pix — regra por canal

Canal lido de `TGFCAB.AD_CANAL_MKTPLACE`:

| Canal | Desconto no rodapé | Ação |
|---|---|---|
| `SHOPEE` | > 0 | **absorve** o Pix na base e zera o campo |
| `MERCADO_LIVRE` | > 0 | apenas zera o campo (o valor do pedido sobe) |
| não reconhecido | > 0 | **recusa** |
| qualquer | 0 | segue normal |

Só `'SHOPEE'` e `'MERCADO_LIVRE'` em caixa alta são reconhecidos. O banco tem
variações (`SHPS`, `MELI`, `mercado livre`, nulo) que caem em não reconhecido;
nenhuma tem desconto no rodapé hoje.

Ocorrência: 4 pedidos em 7.454 na Shopee, 27 em 6.954 no Mercado Livre.

Validado contra o pedido 203430: venda 159,90 − Pix 6,99 = 152,91, que é o
`Vlr. Nota` real, e o item fecha em 123,01 — o mesmo valor que o operador
havia digitado à mão.

### 4. Alvo de cada linha

```javascript
brutoAlvo = totalVenda - pix
alvo[i]   = round2(vendaLinha[i] - (kpVl + pix) * (vendaLinha[i] / totalVenda))
// sobra de arredondamento da distribuição vai para a maior linha
```

### 5. Desconto de arredondamento — regra da casa

Com IPI não existe valor unitário de 2 decimais que reconstitua qualquer alvo:

```
29,90 ÷ 1,065 = 28,0751  →  28,08
28,08 × 1,065 = 29,9052  →  29,91   (um centavo acima)
```

O resíduo vai para o `VLRDESC`, que é o que os operadores já fazem. Validado:

| Alvo | IPI | Qtd | VLRUNIT | VLRDESC | Fecha |
|---|---|---|---|---|---|
| 29,90 | 6,5% | 1 | 28,08 | **0,01** | 29,90 ✔ |
| 109,10 | 6,5% | 1 | 102,44 | 0,00 | 109,10 ✔ |
| 239,60 | 6,5% | 4 | 56,25 | 0,03 | 239,60 ✔ |
| 55,20 | 9,75% | 3 | 16,77 | 0,02 | 55,20 ✔ |

O IPI é calculado aqui **apenas para decidir** o valor unitário e o resíduo —
não é gravado. A verificação confere se o IPI que o motor produziu bate com o
que guiou o cálculo; divergência reprova.

### 6. Linha de KP

| Situação | Ação |
|---|---|
| faixa aplicável e nenhuma linha | `INSERIR` |
| faixa aplicável e linha existente | `ATUALIZAR` (remove e reinsere) |
| sem faixa e linha existente | `REMOVER` |
| sem faixa e sem linha | `NENHUMA` |

Os campos do produto são copiados de uma linha de KP real do mesmo SKU num
outro pedido 1755 sem desconto. Como o KP tem valor fixo por SKU, a cópia é
exata. O script confere que o gabarito tem o valor esperado da faixa antes de
copiar.

**Campos de ciclo de vida não vêm do gabarito.** Ele vem de um pedido já
faturado, onde `QTDENTREGUE=1`, `PENDENTE='N'` e `STATUSNOTA='L'` são
legítimos. Copiar isso torna a linha nova inexcluível
(`CORE_E01541 — Item já foi faturado`). Portanto `QTDENTREGUE` = sempre `0`,
e `PENDENTE`/`STATUSNOTA` vêm de um item de produto do próprio pedido.

### 7. Cabeçalho

| Campo | Valor |
|---|---|
| `DTNEG`, `DTMOV` | hoje, meia-noite |
| `CODCENCUS` | 20000000 |
| `OBSERVACAO` | número único do pedido |
| `AD_INTERNAOBS` | `NOME - dd/mm` — **preservado se já preenchido** |
| `VLRDESCTOT`, `PERCDESC` | 0 |
| `VLRDESCTOTITEM` / `VLRDESCTOTITEMMOE` | soma dos `VLRDESC` dos itens |
| `QTDVOL` | soma das quantidades, KP fora |
| `TIPFRETE` | `'N'` (Extra nota) quando frete = 0 |

O `VLRNOTA` **não é gravado** — o motor calcula.

`VLRDESCTOTITEM` é coluna gravada, não cálculo de exibição: sem escrevê-la, o
rodapé continua mostrando o desconto antigo.

### 8. Recálculo fiscal

```javascript
var IH = newJava(CLS_IMPOSTOS);
IH.setForcarRecalculo(true);
IH.calcularImpostos(linhas[0].getCampo("NUNOTA"));
```

Recalcula `BASEIPI`, `VLRIPI`, `BASEICMS`, `VLRICMS` e `VLRNOTA`. Só roda se
`GRAVAR_ITENS` ou `GRAVAR_KP` estiverem ligados.

### 9. Verificação e rollback

Após gravar, o script relê do banco e confere por item o `VLRUNIT`, `VLRDESC`
e o `VLRIPI` que o motor calculou; a contagem e o valor da linha de KP; os
campos do cabeçalho; e dois fechamentos exatos:

```
soma dos itens (VLRTOT + VLRIPI − VLRDESC)  ==  venda − Pix
VLRNOTA                                      ==  venda − Pix + frete
```

Divergência → `throw`, que **desfaz a transação**. Comprovado várias vezes em
produção, inclusive com o `ImpostosHelpper` já chamado.

---

## Financeiro — pendência conhecida

O campo `Vlr. do desdobramento` (Rodapé → Financeiro) **não acompanha** as
alterações. Quando há desconto de arredondamento, o financeiro fica um centavo
fora do `Vlr. Nota` e o operador **não consegue confirmar o pedido**.

O `ImpostosHelpper` recalcula impostos mas não refaz o desdobramento.

**Solução operacional atual: dois cliques.** Rodar NORMALIZAR PEDIDO e depois
o botão **Refazer Financeiro** (ação separada, já existente). Testado e
funciona: aplica o desconto de um centavo e o `Vlr. do desdobramento` fica
exatamente igual ao `Vlr. Nota`.

**Por que não está dentro do script.** A mesma chamada falha quando executada
de dentro da v6:

```
PersistenceException: Parâmentro nulo: "nota":{"nunota":203267
```

A string JSON chega truncada — perde a chave de abertura e as de fechamento.
Testado com aspas simples, aspas duplas e prefixo de schema; o erro persiste
em todas. O botão separado usa a mesma sintaxe e funciona, então a diferença
está no contexto de execução, ainda não identificada.

`GRAVAR_FINANCEIRO` fica `false`. Quando o financeiro diverge e a chave está
desligada, o script emite aviso orientando o operador.

Contorno manual alternativo, se o botão não estiver disponível: no item, zerar
o desconto e salvar, depois recolocar e salvar.

---

## Casos em que o pedido é recusado

- TOP diferente de 1755
- mais de um pedido selecionado
- pedido sem itens, ou só com linhas de KP
- item inconsistente (`VLRTOT` fora de `VLRUNIT × QTDNEG`)
- item com venda reconstruída ≤ 0
- desconto no rodapé com canal não reconhecido
- alvo que não fecha com 2 decimais
- sem gabarito de KP para a faixa necessária
- `RECALCULAR_IMPOSTOS` ligado e a classe ausente no ambiente

---

## Ativação gradual

```
1. SIMULACAO = true                          → conferir o relatório
2. SIMULACAO = false, três chaves false      → exercita o caminho até o fim
3. GRAVAR_ITENS + GRAVAR_KP + GRAVAR_CABECALHO juntos
```

**As três chaves andam juntas em pedido com Pix.** Ligar itens sem cabeçalho
deixa o `VLRDESCTOT` no pedido, e o motor desconta o Pix duas vezes ao
recalcular o `VLRNOTA`. A verificação pega e desfaz, mas é rodada perdida.

Rodar duas vezes seguidas é o teste de idempotência — nenhum valor de item
deve mudar na segunda passagem.

---

## Limitações conhecidas

**Financeiro.** Ver seção acima. É a pendência principal.

**`TIPFRETE` Incluso não confirmado.** `TIPFRETE_INCLUSO = null`, então pedido
com frete não tem o campo alterado. Falta abrir um pedido com `TIPFRETE = 'S'`
e frete > 0 e conferir o rótulo no Rodapé → Transporte.

**Mercado Livre com Pix sobe o valor do pedido.** Zerar o desconto sem
absorver aumenta o total pelo montante do desconto. Comportamento definido,
mas vale conferir num caso real.

**Reexecução com Pix.** A faixa de KP é decidida sobre a venda antes do Pix, e
essa informação desaparece quando o campo é zerado. Se o Pix cruzar uma
fronteira de faixa, uma segunda execução pode escolher faixa menor.

**Acréscimo por parcelamento** não tem campo conhecido no ERP.

**Distribuição proporcional.** Pix e KP são distribuídos entre itens
proporcionalmente ao valor. A calculadora original dividia o Pix igualmente —
decisão pendente de confirmação.

**Linha de KP inserida por script** não passa pela liberação normal. Vale
confirmar com quem conhece o fluxo de faturamento se há outros campos de
controle além dos tratados.

**Pedido criado manualmente** vem sem `AD_CANAL_MKTPLACE`. Se tiver desconto
no rodapé, é recusado.

---

## Manutenção

**Rhino, cuidados obrigatórios:**

- todo código dentro de funções; o topo do script tem limite de offset de
  16 bits (`bad offset`)
- **nunca** nomear função ou variável como `contexto` — a global com esse nome
  quebra o Rhino com erro **não capturável**
- ES5: sem `let`/`const`, arrow, template literal, `Object.assign`,
  `Number.EPSILON`
- `BigDecimal` sempre construído a partir de **string**
- retorno ao usuário é **atribuição**: `mensagem = txt`

**Alterar a tabela de KP** exige apenas editar `KP_TABLE`. Faixa nova precisa
de um KP inserido manualmente uma vez, para servir de gabarito.

**Relogar antes de usar em produção.** O `AuthenticationInfo` cacheia o VO do
usuário na sessão, então mudanças no cadastro (nome, por exemplo) só aparecem
após novo login. A Observação Interna registra o que estiver em cache.

---

## Arquivos

| Arquivo | Conteúdo |
|---|---|
| `Normalizar pedido v6.js` | o script em uso |
| `Normalizar pedido v5.js` | versão anterior, mantida como referência |
| `README.md` | este documento |
| `Diagnostico.md` | histórico da investigação e caminhos descartados |
| `demo.mp4` | demonstração |
