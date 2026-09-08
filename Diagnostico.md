# Diagnóstico — Normalização de pedidos de marketplace no Sankhya

Registro de como se chegou ao `normalizador-pedido-v5.js`. Inclui os caminhos
que **não** funcionaram, porque são o que evita repetir a investigação.

Ambiente: Sankhya ERP sobre Oracle · TemApi (integradora) · Anymarket (hub) ·
Mercado Livre e Shopee. BeBaby Group Importação.

---

## 1. O sintoma

Pedido da Shopee chegava ao Sankhya com desconto, e o item ficava com valor
menor do que o anúncio. Caso de referência: pedido `202306`, Bolsa Cerise
Black KikkaBoo (SKU 584), anunciada a R$ 139,00.

**Na Shopee:**

| | |
|---|---|
| Anúncio | 139,00 |
| Cupom Shopee (subsídio da plataforma) | −20,00 |
| Pago pelo comprador | 119,00 |
| Taxas e encargos | 19,46 (= 14% de 139,00) |
| Repasse ao vendedor | 99,54 |

**No Sankhya:**

| Campo | Valor |
|---|---|
| VLRUNIT | 375,492958 |
| VLRDESC | 260,90 |
| PERCDESC | 69,48% |
| Preço líq. (tela) | 114,59 |

O 114,59 não corresponde a nenhum número da Shopee. Foi o que iniciou a
investigação.

---

## 2. Causa raiz

O payload da Anymarket estava **correto**:

```json
"discount": 0, "gross": 139, "total": 139,
"items": [{ "amount": 1, "unit": 399.90, "gross": 399.90,
            "discount": 260.90, "total": 139 }]
```

`399,90` é o preço "de" do anúncio (riscado) e `260,90` o desconto até o preço
"por". A conta fecha: `399,90 − 260,90 = 139,00`.

O erro está na gravação. O TemApi:

1. divide o `unit` pelo fator de IPI → `399,90 ÷ 1,065 = 375,492958` ✔
2. grava o `discount` **sem dividir** → `260,90` ✘

Resultado: um campo na base com IPI embutido e o outro sem.

```
gravado:  375,492958 − 260,90 = 114,592958   →  × 1,065 = 122,04
correto:  375,492958 − 244,976526 = 130,516432 → × 1,065 = 139,00
```

A diferença de 16,96 no bruto foi o número que não fechava no começo.

Há um segundo efeito: o desconto absoluto de 260,90 foi calculado contra
399,90, mas o ERP o aplica contra o valor que ele mesmo gravou. Se o TemApi
enviasse **percentual** (`260,90 ÷ 399,90 = 65,2413%`) em vez de valor
absoluto, o problema não existiria — percentual é imune à troca de base.

### Escala

Amostra de 30 pedidos de marketplace com `QTDNEG > 1`:

- 22 de 30 têm `VLRDESC = 0,01` — resíduo de arredondamento, não desconto real
- em 26 de 27 casos residuais, `VLRDESC` é exatamente
  `VLRUNIT × QTDNEG × (1+IPI) − venda × QTDNEG`
- o resíduo **escala com a quantidade** (qtd 2 → ~0,01; qtd 4 → ~0,03)

Ocorre igualmente nos tipos de negociação 329 e 332. **Não é problema
exclusivo da Shopee** — é o TemApi arredondando o `VLRUNIT` para cima e
lançando a sobra como desconto, em todo canal.

### Correção de verdade

O ticket ao TemApi. Três opções, em ordem de preferência:

1. gravar `VLRDESC = discount ÷ (1 + IPI/100)`
2. gravar `PERCDESC = discount ÷ unit` em vez de `VLRDESC`
3. gravar `VLRUNIT = (unit − discount) ÷ (1 + IPI/100)` com `VLRDESC = 0`

O script deste repositório é **plano B**. Não substitui o ticket.

---

## 3. Por que os operadores corrigiam à mão

Não havia rotina automática. Cada pedido era refeito manualmente, e a
correção não deixa rastro — o que significa que os R$ 34,05 de divergência
medidos em dois meses mediam apenas o que havia escapado, não o problema.

O estado final correto, observado nos pedidos já normalizados:

```
pedido 202306 (venda 139,00):
  item 584   VLRUNIT 102,44   VLRDESC 0      →  102,44 × 1,065 = 109,10
  item 2310  KP1     29,90    IPI 0          →   29,90
                                          total  139,00
```

Ou seja: desconto zerado, KP como item próprio sem IPI, e o principal
recebendo a divisão pelo IPI. É a fórmula da casa,
`(Venda − Pix − KP) ÷ IPI`, aplicada ao pé da letra.

---

## 4. Tentativas de gravar itens por script — todas falharam no recálculo

O Sankhya **não recalcula** campos derivados em gravação server-side. Quatro
vias testadas:

| Via | Resultado |
|---|---|
| `JapeFactory.dao("ItemNota").prepareToUpdate(vo).set(...).update()` | grava coluna crua, nada recalcula |
| `linhas[0].setCampo(...)` + `save()` em ação sobre **TGFCAB** | idem |
| `linhas[0].setCampo(...)` + `save()` em ação sobre **TGFITE** | idem |
| gravar, fechar e reabrir a tela (hipótese de recálculo no refresh) | idem — a tela nem recalcula para exibir |

Evidência do teste decisivo (pedido `202443`, `VLRUNIT` 375,49 → 100,00):

```
ANTES:   VLRUNIT 375.49  VLRTOT 375.49  BASEIPI 375.49  VLRIPI 24.41  BASEICMS 139.00
DEPOIS:  VLRUNIT 100.00  VLRTOT 375.49  BASEIPI 375.49  VLRIPI 24.41  BASEICMS 139.00
```

Comparação campo a campo de um export de 51 colunas antes e depois: **só o
`VLRUNIT` mudou**.

O recálculo mora no processamento da requisição da tela, antes de persistir.
Script server-side entra depois desse ponto.

Contraprova: digitando `100,00` na tela e salvando pela interface, o Sankhya
produziu `VLRTOT 100,00`, `BASEIPI 100,00`, `VLRIPI 6,50`, `BASEICMS 106,50`,
`VLRICMS 19,17` e `VLRNOTA 106,50`. Foi esse gabarito que permitiu validar as
fórmulas.

### `ConfirmacaoNotaHelper` — descartada

`br.com.sankhya.modelcore.comercial.ConfirmacaoNotaHelper` existe, mas seus
métodos são `confirmarNota(...)`. Isso **confirma** o pedido: baixa estoque,
gera financeiro, emite. Não é recálculo. **Não chamar em pedido de
marketplace.**

Ausentes nesta versão (4.36b110): `CabecalhoNotaHelpper`, `ItemNotaHelpper`,
`CACHelper`, `ConfirmacaoNota`, `ServiceBroker`.

---

## 5. Replicar o motor fiscal — validação em escala

Com o recálculo fora de alcance, restou calcular tudo. As fórmulas foram
testadas contra **20.856 itens** reais de pedidos TOP 1755:

| Fórmula | Acerto |
|---|---|
| `VLRTOT = VLRUNIT × QTDNEG` | 20.843 / 20.856 — 99,9% |
| `VLRIPI = BASEIPI × ALIQIPI/100` | 20.756 / 20.856 — 99,5% |
| `VLRICMS = BASEICMS × ALIQICMS/100` | 20.756 / 20.856 — 99,5% |
| `VLRNOTA = Σ(VLRTOT + VLRIPI − VLRDESC)` | 17.759 / 17.905 — 99,2% |
| `BASEIPI = VLRTOT` | 18.524 / 20.856 — 88,8% |
| **`BASEICMS = VLRTOT + VLRIPI − VLRDESC`** | 14.645 / 20.856 — **70,2%** |

`COM_ST = 0` — **nenhum item de marketplace tem substituição tributária.**
Esse risco não existe.

A base de ICMS errando em 30% dos casos bloqueou a abordagem: erro em base de
cálculo é erro fiscal em nota emitida.

### Seis hipóteses testadas para o discriminador do ICMS — todas negativas

| Hipótese | Resultado |
|---|---|
| Tipo de negociação (`CODTIPVENDA`) | Shopee (332) aparece nos dois lados: 6.299 vs 405 |
| Frete no pedido | "com frete" acerta **mais** (86%) que "sem frete" (76%) |
| `TGFPAR.IPIINCICMS` ("IPI incide no cálculo do ICMS") | todos os parceiros em `'N'`; base se divide 11.072 / 4.260 dentro do mesmo valor |
| `BASICMMOD` (modalidade da base) | grupo dominante `3` tem 77,5% de acerto — não separa |
| `CODTRIB` | `41` são as linhas de KP (IPI e ICMS zero, não seguem fórmula); resto não separa |
| `TIPPESSOA` | não separa |

### O que os dados revelaram

Distribuição das proporções `BASEICMS ÷ (VLRTOT + VLRIPI − VLRDESC)` nos
4.260 divergentes — **três valores cobrem 95%**:

| Proporção | Itens | Identificação |
|---|---|---|
| 0,9685 | 2.421 | `1 ÷ 1,0325` → IPI de 3,25% |
| 0,9390 | 1.568 | `1 ÷ 1,065` → IPI de 6,5% |
| 0,9111 | 28 | `1 ÷ 1,0975` → IPI de 9,75% |

As proporções são exatamente o inverso do fator de IPI. Existem **dois
regimes** de base de ICMS convivendo:

```
regime COM_IPI:  BASEICMS = VLRTOT + VLRIPI − VLRDESC
regime SEM_IPI:  BASEICMS = VLRTOT − VLRDESC
```

O discriminador entre eles **não foi identificado**. Tem explicação fiscal
conhecida (o IPI integra a base quando a venda é a consumidor final e não
integra quando é a contribuinte que revende), mas o campo que o Sankhya usa
para decidir não apareceu em nenhuma das seis hipóteses.

---

## 6. A solução: auto-calibração

Não é necessário saber **por que** um item está num regime ou no outro. É
possível **ler qual regime vale** no próprio item, antes de alterá-lo:

```javascript
var comIpi = round2(it.vlrtot + it.vlripi - it.vlrdesc);
var semIpi = round2(it.vlrtot - it.vlrdesc);
if      (perto(it.baseicms, comIpi)) regime = "COM_IPI";
else if (perto(it.baseicms, semIpi)) regime = "SEM_IPI";
else    → item RECUSADO
```

Generalizado, virou o princípio central do script:

> **Toda fórmula precisa reproduzir o estado atual do item antes de ser usada
> para calcular o estado novo. Se qualquer uma falhar, o item é recusado e o
> pedido não é alterado.**

Isso troca "eu sei a regra fiscal" por "eu verifico a regra em cada item", que
é uma afirmação muito mais fraca e muito mais defensável.

A linha de **KP** é caso separado e **exato**: o KP tem valor fixo por SKU
(KP1 é sempre 29,90), então os campos fiscais são copiados verbatim de uma
linha de KP real do mesmo SKU — valores que o próprio Sankhya calculou para
aquele mesmo valor. Não é estimativa.

---

## 7. Descobertas do ambiente

Itens que custaram tempo e que valem estar escritos.

### Semântica do `VLRDESC`

É o **total da linha**, não por unidade. Provado com `QTDNEG` 3 e 4:

| Pedido | Qtd | VLRUNIT | VLRDESC | Total da linha | Por unidade |
|---|---|---|---|---|---|
| 134397 | 4 | 56,25 | 0,03 | **59,90** ✔ | 59,88 |
| 142602 | 3 | 16,77 | 0,02 | **18,40** ✔ | 18,39 |
| 94333 | 2 | 421,60 | 100,01 | **399,00** ✔ | 348,99 |

Pedidos antigos digitados à mão parecem seguir outra convenção, mas o script
só roda sobre TOP 1755.

Também confirmado: `VLRTOT = VLRUNIT × QTDNEG` sempre, e o `VLRDESC` **nunca**
é subtraído do `VLRTOT`.

### Base da faixa de KP

A faixa é decidida pelo **valor total da venda, incluindo o KP** — não pelos
produtos após a extração. Verificado em 7 de 7 pedidos já normalizados; a base
"produtos apenas" erraria a faixa em 2 deles:

| Pedido | Bruto total | Produtos só | KP que tem | Faixa por total | Faixa por produtos |
|---|---|---|---|---|---|
| 196076 | 565,70 | 386,30 | KP6 | **KP6** ✔ | KP3 ✘ |
| 199656 | 205,98 | 116,28 | KP3 | **KP3** ✔ | KP1 ✘ |

Consequência: num pedido já normalizado o KP tem de ser **devolvido à base**
antes de recalcular a faixa, senão o botão não é idempotente e clicar duas
vezes subtrai o KP duas vezes.

### Desconto de arredondamento — regra da casa

Com IPI não existe valor unitário de 2 decimais que reconstitua qualquer alvo:

```
29,90 ÷ 1,065 = 28,0751  →  28,08
28,08 × 1,065 = 29,9052  →  29,91   (um centavo acima)
```

Zerar o desconto faz o pedido ficar até um centavo por item acima da venda.
Os operadores já resolvem isso deixando o resíduo no `VLRDESC` — pedido
`202411`: dois itens a 28,08 com `VLRDESC 0,01` cada, fechando 59,80 exato.
É também o que explica os 996 itens com `VLRDESC = 0,01` na amostra.

O script reproduz isso. Validado em 7 casos, incluindo os reais:

| Caso | Alvo | Unit | Desconto | Fecha |
|---|---|---|---|---|
| 202514 / 202411 | 29,90 | 28,08 | **0,01** | 29,90 ✔ |
| 202306 | 109,10 | 102,44 | 0,00 | 109,10 ✔ |
| qtd 4, IPI 6,5 | 239,60 | 56,25 | 0,03 | 239,60 ✔ |
| qtd 3, IPI 9,75 | 55,20 | 16,77 | 0,02 | 55,20 ✔ |

Os dois primeiros reproduzem exatamente o que o operador digitou. O caso de
quantidade 4 coincide com os valores reais do pedido 134397, que não havia
sido usado na construção do algoritmo.

### Agregados do cabeçalho também precisam ser gravados

`VLRDESCTOTITEM` ("Desconto total por item", Rodapé → Totais) é **coluna
gravada** no `TGFCAB`, não cálculo de exibição. Descoberto em teste com
operadores: após normalizar o 202443, os itens estavam com `VLRDESC 0` e
`VLRDESCTOT`/`PERCDESC` zerados no banco, mas o rodapé seguia exibindo
260,90 — valor antigo do TemApi.

Mesma lição dos campos derivados dos itens: nada é recalculado, então todo
campo agregado tem de ser escrito explicitamente. Vale conferir se há outros —
`VLRDESCSERV` e `TOTDISPDESC` existem no `TGFCAB` e não são tratados hoje
(não se aplicam a pedido de marketplace sem serviços).

### `TIPFRETE`

`'N'` = **Extra nota** (confirmado no `202443`: frete zero, `TIPFRETE 'N'`,
tela mostra "Extra nota"). `'S'` presumivelmente Incluso, mas **não
confirmado na tela** — por isso `TIPFRETE_INCLUSO` segue `null` e o script não
altera o campo quando há frete.

Distribuição nos pedidos 1755: `'S'` em 12.271 (23% com frete), `'N'` em 5.650
(1,9% com frete).

### Rollback

**Existe.** `throw` desfaz a transação. Comprovado: o KP foi inserido, a
verificação reprovou, o `throw` executou e o pedido ficou sem a linha.

Corrige uma conclusão anterior errada — a gravação que havia "sobrevivido" a
uma exceção vinha de outra execução, na qual o erro ocorreu **depois** da
verificação passar.

### Armadilhas do Rhino / ação de tabela

| Sintoma | Causa |
|---|---|
| `bad offset: -32231` | Rhino compila o corpo do script como um método e os saltos usam offset de 16 bits. **Manter o topo mínimo e tudo dentro de funções.** |
| `Invalid JavaScript value of type ExecutionContext` | A global `contexto` não é manipulável pelo Rhino, e o erro **não é capturável** por `try/catch`. **Nunca nomear função ou variável como `contexto`.** |
| `Cannot find function getQuery in object function X() {...}` | Mesma causa: uma função chamada `contexto()` colidia com a global. |
| `setMensagemRetorno is not defined` | O método existe em `ContextoAcao` mas **não é injetado como global**. O retorno é **atribuição**: `mensagem = txt`. As globais `mensagem` e `mensagemErro` chegam `null` (e `typeof null === "object"`, o que confundiu o diagnóstico). |
| `java.lang.String cannot be cast to java.math.BigDecimal` | Ler campos com `q.getString()` e gravar com `set()`. Ler o gabarito pelo **Jape** (`vo.getProperty()`), que devolve o tipo correto. |
| `Item já foi faturado. Não pode ser excluído` (CORE_E01541) | `QTDENTREGUE = 1` na linha nova, copiado de um gabarito de pedido **já faturado**. Campos de ciclo de vida (`QTDENTREGUE`, `PENDENTE`, `STATUSNOTA`) vêm do **próprio pedido**, não do gabarito. |
| Ação sobre TGFITE não aparece na grade | Aparece — precisa fechar e reabrir a tela do pedido. Acabou não sendo necessária. |

### API confirmada por sondagem

```
linhas[0].getCampo(String) / .setCampo(String, Object) / .save() / .remove()
linhaPai                          → cabeçalho, quando a ação é sobre TGFITE
getQuery()                        → nativeSelect / next / getBigDecimal / getString
getParam(String), getUsuarioLogado() → BigDecimal (CODUSU)
mensagem = txt                    → retorno ao usuário
JapeFactory.dao(nome).findByPK(Object[])              → DynamicVO
JapeFactory.dao(nome).prepareToUpdate(vo).set(k,v).update()
JapeFactory.dao(nome).create().set(k,v).save()
JapeFactory.dao(nome).delete(Object[])
PK de ItemNota = [NUNOTA, SEQUENCIA]
AuthenticationInfo.getCurrent().getUsuVO().asString("NOMEUSU")
```

Campo da Observação Interna: **`AD_INTERNAOBS`** (campo customizado — foi por
isso que `OBSERVACAOINTERNA`, `OBSINTERNA` e `AD_OBSINTERNA` não existiam).

---

## 8. Escopo entregue e escopo cortado

### Entregue

- datas de negociação e movimento para hoje
- centro de resultado 20000000 (MARKETPLACE)
- Observação = número único do pedido
- Observação Interna = `NOME - dd/mm` (preservada se já preenchida)
- descontos do rodapé zerados
- quantidade de volumes = soma das quantidades, KP fora
- `TIPFRETE` = Extra nota quando frete = 0
- `VLRUNIT`, `VLRDESC`, `PERCDESC`, `VLRTOT`, `BASEIPI`, `VLRIPI`,
  `BASEICMS`, `VLRICMS` dos itens
- inserção, atualização e remoção da linha de KP
- `VLRNOTA` do cabeçalho

### Cortado ou pendente

- **Desconto Pix** — `PIX_HABILITADO = false`. O Pix chega em
  `VLRDESCTOT` (Rodapé → Totais → "Desconto no total"). Com a regra
  desligada, pedido com desconto no rodapé é **recusado**, para não zerar o
  campo sem absorver o valor. Ao religar, reler a limitação de reexecução:
  a faixa de KP é decidida sobre a venda **antes** do Pix, e essa informação
  desaparece quando o campo é zerado — se o Pix cruzar uma fronteira de faixa,
  uma segunda execução pode escolher faixa menor.
- **Acréscimo por parcelamento** — sem campo conhecido; entra por parâmetro
  `ACRESCIMO` do botão.
- **`TIPFRETE` Incluso** — falta confirmar na tela que `'S'` é Incluso.
- **Distribuição do Pix** — a calculadora original divide Pix e acréscimo
  igualmente entre itens; o script usa proporcional ao valor, consistente com
  o KP. Decisão pendente de confirmação.

---

## 9. Erros cometidos nesta investigação

Registrados porque explicam por que o desenho final é conservador.

1. **Nomes de tabela inventados** — `TGFNTB` não existe; `NUTAB` não está em
   `TGFCAB` (está em `TGFITE`). Custou três rodadas de erro Oracle.
2. **Diagnóstico da tabela de preços** — conclui que o preço 375,49 vinha de
   tabela sobrescrevendo o valor. Errado: o produto 584 não tem preço no
   `NUTAB` 135, e o valor tinha seis decimais (`375,492958`), assinatura de
   cálculo em tempo de execução. Era `399,90 ÷ 1,065`.
3. **"O Jape passa pelo EntityFacade e dispara as regras"** — afirmado duas
   vezes como fato, era suposição. Duas versões do botão foram construídas
   sobre isso.
4. **"Não existe rollback"** — conclusão errada, tirada de dois eventos lidos
   como um só.
5. **Tolerância de 1,1 centavo no fechamento** — deixou passar um erro de um
   centavo em pedido real (202514). A verificação de fechamento passou a ser
   exata.
6. **Frete somado duas vezes na verificação** — comparava soma dos itens mais
   frete contra a venda, que não inclui frete. Todo pedido com frete reprovava
   pela diferença exata do frete (visto no 202543: 29,90 + 10,83 = 40,73).
7. **`QTDENTREGUE = 1` na linha de KP** — copiado do padrão de um gabarito
   faturado, tornava a linha nova inexcluível.

O padrão comum: supor o comportamento do ambiente em vez de sondá-lo. As
sondas (v1 a v9, todas somente-leitura) foram o que corrigiu isso, e a
auto-calibração é a mesma ideia levada para dentro do script.

---

## 10. Ressalva final

O script **replica o motor fiscal do Sankhya em vez de chamá-lo**. A
auto-calibração protege contra fórmula errada, e a verificação pós-gravação
com rollback protege contra gravação divergente. Mas gravar base de cálculo
de IPI e ICMS por script é decisão de arquitetura, não de implementação:

- deve ser conhecida pelo CTO
- a lógica deve ser revisada por quem cuida da parametrização fiscal
- mudança de tributação de produto, entrada de produto de outro estado ou
  aparecimento de redução de base alteram o perfil; a auto-calibração recusa
  o item, mas **alguém precisa reagir quando as recusas começarem a aparecer**

E a correção definitiva continua sendo o ticket ao TemApi.
