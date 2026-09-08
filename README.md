# NORMALIZAR PEDIDO — botão de ação Sankhya

Normaliza pedidos de marketplace (TOP 1755) no Sankhya: recalcula os valores
dos itens a partir do preço de venda real do canal, gerencia a linha de KP e
ajusta os campos do cabeçalho.

**Status: em teste com operadores.**

| | |
|---|---|
| Arquivo | `normalizador-pedido-v5.js` |
| Tipo | Ação de tabela — Script (JavaScript) |
| Instância | `CabecalhoNota` / **TGFCAB** |
| Nome do botão | NORMALIZAR PEDIDO |
| Motor | Rhino, Java 8 — código **ES5** |
| Banco | Oracle |

Para o histórico da investigação e os caminhos descartados, ver
[`DIAGNOSTICO.md`](DIAGNOSTICO.md).

---

## O problema em uma frase

O TemApi grava o `VLRUNIT` dividido pelo fator de IPI mas o `VLRDESC` sem
dividir, e envia desconto absoluto calculado contra uma base diferente da que
o ERP usa. O item chega com valor errado e o operador refaz à mão.

Este script é **plano B**. A correção definitiva é o TemApi.

---

## Por que a ação é sobre TGFCAB

O cálculo da faixa de KP depende da **venda total do pedido**. Numa ação sobre
TGFITE, se o operador selecionasse um item só, o cálculo sairia errado.

O script grava o cabeçalho pelo registro da tela (`linhas[0].setCampo` +
`save()`) e os itens pelo Jape. O Jape grava coluna crua — que é exatamente o
comportamento desejado aqui, já que o script calcula todos os campos
derivados por conta própria.

---

## Configuração

Tudo no topo do arquivo.

```javascript
var SIMULACAO        = true;    // true = só relatório, nada é gravado
var GRAVAR_CABECALHO = false;   // chaves independentes, ligar uma por vez
var GRAVAR_ITENS     = false;
var GRAVAR_KP        = false;

var PIX_HABILITADO      = false;      // regra de Pix isolada — ver abaixo
var CODCENCUS_ALVO      = 20000000;   // MARKETPLACE
var CODTIPOPER_ESPERADO = 1755;       // PEDIDO MARKETPLACE
var CAMPO_OBS_INTERNA   = "AD_INTERNAOBS";
var CAMPO_NOME_USUARIO  = "NOMEUSU";
var PRESERVAR_OBS_INTERNA = true;     // não sobrescreve autoria de outro operador
var TIPFRETE_EXTRANOTA  = "N";        // confirmado na tela
var TIPFRETE_INCLUSO    = null;       // "S" após confirmar na tela
var SCH                 = "";         // "SANKHYA." se der ORA-00942
var TOL                 = 0.011;      // tolerância geral de comparação
var DESC_TOTAL_LINHA    = true;       // VLRDESC é total da linha
```

`SIMULACAO = true` é o padrão e produz o relatório completo sem tocar no
pedido. As três chaves de gravação são independentes para permitir ativação
gradual.

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
SKUs 2310–2316 são reconhecidos como linha de KP em qualquer lugar do script.

---

## Fluxo

```
1. LER          cabeçalho (Jape) + itens (getQuery)
2. VALIDAR      TOP, desconto no rodapé, coerência do VLRNOTA atual
3. CALCULAR     reconstruir venda → devolver KP → faixa → alvos → calibrar → derivar
4. RELATAR      antes → depois de cada campo
5. (parar aqui se SIMULACAO ou se houver erro)
6. GRAVAR       itens → KP → cabeçalho
7. VERIFICAR    reler do banco e comparar; divergência → throw = ROLLBACK
8. RETORNAR     mensagem = texto
```

---

## Dissecando

### 1. Reconstrução da venda

O preço real do canal não está em campo nenhum. É reconstruído:

```javascript
descUnit      = vlrdesc / qtd            // VLRDESC é total da linha
_vendaUnit    = round2(vlrunit * (1 + aliqipi/100) - descUnit)
_vendaLinha   = round2(_vendaUnit * qtd)
```

Validado contra seis pedidos reais, incluindo quantidades 2, 3 e 4.

Item cuja venda reconstruída dê zero ou negativo é **recusado** — significa
desconto maior que o preço, como no pedido 195532.

### 2. Idempotência — devolver o KP à base

Num pedido já normalizado o KP foi retirado dos produtos e virou linha
própria. A faixa é decidida pelo **total da venda incluindo o KP**, então o
KP existente precisa voltar à base antes de recalcular:

```javascript
kpDevolvido = Σ (kp.vlrunit * (1+IPI) - kp.desc/qtd) * qtd
totalVenda  = somaProdutos + kpDevolvido
// e devolvido proporcionalmente a cada produto, preservando as proporções
```

Sem isso, clicar duas vezes no botão subtrairia o KP duas vezes. Confirmado em
7 de 7 pedidos já normalizados — a base "produtos apenas" erraria a faixa em
dois deles.

### 3. Alvo de cada linha

```javascript
alvoTotal  = totalVenda - kpVl
alvo[i]    = round2(vendaLinha[i] - kpVl * (vendaLinha[i] / totalVenda))
// sobra de arredondamento da distribuição vai para a maior linha
```

Assim cada linha fecha individualmente **e** a soma fecha no total.

### 4. Auto-calibração — `calibrar(it)`

**É o núcleo da segurança do script.** Antes de calcular qualquer valor novo,
cada fórmula é testada contra o estado atual do próprio item:

| # | Verificação |
|---|---|
| 1 | `VLRTOT == VLRUNIT × QTDNEG` — se falhar, o item foi alterado sem recálculo e nada mais é confiável |
| 2 | `BASEIPI == VLRTOT` (ou zero, quando não há IPI) |
| 3 | `VLRIPI == BASEIPI × ALIQIPI/100` |
| 4 | `BASEICMS` bate com um dos dois regimes conhecidos → grava qual |
| 5 | `VLRICMS == BASEICMS × ALIQICMS/100` |

Qualquer falha → **item não modelável, pedido recusado, nada é alterado.**

O passo 4 resolve o problema que travou o projeto: existem dois regimes de
base de ICMS em uso e o discriminador não foi identificado.

```javascript
comIpi = round2(vlrtot + vlripi - vlrdesc);   // regime COM_IPI
semIpi = round2(vlrtot - vlrdesc);            // regime SEM_IPI
```

O script não precisa saber **por que** o item está num regime — ele **lê qual
vale** naquele item e aplica o mesmo ao valor novo.

### 5. Derivação — `derivar(...)`

```javascript
unit    = round2((alvoLinha / (1+IPI)) / qtd)
vlrtot  = round2(unit * qtd)
baseipi = (aliqipi > 0 || baseIpiSegueTot) ? vlrtot : 0
vlripi  = round2(baseipi * aliqipi / 100)
vlrdesc = round2(vlrtot + vlripi - alvoLinha)     // resíduo de arredondamento
percdesc= round2(vlrdesc / vlrtot * 100)
baseicms= regime === "COM_IPI" ? vlrtot + vlripi - vlrdesc
                               : vlrtot - vlrdesc
vlricms = round2(baseicms * aliqicms / 100)
fecha   = round2(vlrtot + vlripi - vlrdesc)       // deve igualar alvoLinha
```

Se o bruto ficar **abaixo** do alvo, o unitário sobe um centavo e recalcula —
desconto nunca fica negativo (até 4 tentativas).

### 6. Desconto de arredondamento — regra da casa

Com IPI não existe valor unitário de 2 decimais que reconstitua qualquer alvo:

```
29,90 ÷ 1,065 = 28,0751  →  28,08
28,08 × 1,065 = 29,9052  →  29,91   (um centavo acima do alvo)
```

O resíduo vai para o `VLRDESC`, que é o que os operadores já fazem. Resultado
validado contra casos reais:

| Alvo | IPI | Qtd | VLRUNIT | VLRDESC | Fecha |
|---|---|---|---|---|---|
| 29,90 | 6,5% | 1 | 28,08 | **0,01** | 29,90 ✔ |
| 109,10 | 6,5% | 1 | 102,44 | 0,00 | 109,10 ✔ |
| 239,60 | 6,5% | 4 | 56,25 | 0,03 | 239,60 ✔ |
| 55,20 | 9,75% | 3 | 16,77 | 0,02 | 55,20 ✔ |
| 729,91 | 3,25% | 1 | 706,93 | 0,00 | 729,91 ✔ |

O desconto só é diferente de zero quando o arredondamento exige. O script
avisa se o resíduo passar de `0,01 × qtd + 0,01`, o que indicaria outra causa.

### 7. Linha de KP

Quatro ações possíveis:

| Situação | Ação |
|---|---|
| faixa aplicável e nenhuma linha de KP | `INSERIR` |
| faixa aplicável e linha existente | `ATUALIZAR` (remove e reinsere) |
| sem faixa e linha existente | `REMOVER` |
| sem faixa e sem linha | `NENHUMA` |

`ATUALIZAR` é remover e reinserir, não editar — mais simples e sempre
consistente, ao custo de mudar a sequência da linha.

Os campos fiscais são **copiados de uma linha de KP real do mesmo SKU** num
outro pedido 1755 sem desconto:

```javascript
gabaritoKp(sku, nunota)  // lê pelo Jape → getProperty() devolve o tipo certo
```

Isso é **exato, não estimado**: o KP tem valor fixo por SKU, então a base de
cálculo do gabarito é a mesma que o Sankhya calcularia. Antes de copiar, o
script confere que o gabarito tem o valor esperado da faixa — se divergir,
recusa.

**Campos de ciclo de vida não vêm do gabarito.** Ele vem de um pedido já
faturado, onde `QTDENTREGUE=1`, `PENDENTE='N'` e `STATUSNOTA='L'` são
legítimos. Copiar isso torna a linha nova inexcluível
(`CORE_E01541 — Item já foi faturado`). Portanto:

- `QTDENTREGUE` = sempre `0`
- `PENDENTE` e `STATUSNOTA` = lidos de um item de produto **do próprio pedido**

Se não houver gabarito para a faixa, o script **recusa** em vez de inserir
linha incompleta. Faixas nunca usadas exigem um KP manual uma vez.

### 8. Cabeçalho

Gravado por `linhas[0].setCampo(...)` + `save()`:

| Campo | Valor |
|---|---|
| `DTNEG`, `DTMOV` | hoje, meia-noite |
| `CODCENCUS` | 20000000 |
| `OBSERVACAO` | número único do pedido |
| `AD_INTERNAOBS` | `NOME - dd/mm` — **preservado se já preenchido** |
| `VLRDESCTOT`, `PERCDESC` | 0 |
| `VLRDESCTOTITEM` / `VLRDESCTOTITEMMOE` | soma dos `VLRDESC` dos itens no estado novo |
| `QTDVOL` | soma das quantidades, KP fora |
| `VLRNOTA` | venda + frete |
| `TIPFRETE` | `'N'` (Extra nota) quando frete = 0 |

`PRESERVAR_OBS_INTERNA = true` evita apagar a autoria de quem normalizou
antes — a correção manual não deixa outro rastro.

**"Desconto total por item" é coluna gravada, não cálculo de exibição.**
`VLRDESCTOTITEM` no `TGFCAB`. Como nada recalcula, precisa ser escrita: no
202443 os itens ficaram com `VLRDESC 0` e o rodapé continuava mostrando
260,90. O valor correto é a soma dos descontos dos itens no estado novo — o
resíduo de arredondamento, ou zero.

### 9. Verificação e rollback

Depois de gravar, o script **relê do banco** e compara. Confere por item o
`VLRUNIT`, `VLRTOT`, `VLRDESC`, `VLRIPI`, `BASEICMS` e `VLRICMS`; a contagem e
o valor da linha de KP; os campos do cabeçalho; e dois fechamentos:

```
soma dos itens (VLRTOT + VLRIPI − VLRDESC)  ==  venda        (exato, ±0,005)
VLRNOTA                                     ==  venda + frete (exato, ±0,005)
```

Divergência → `throw`, que **desfaz a transação**. Comprovado em produção: o
KP foi inserido, o fechamento reprovou, e o pedido ficou sem a linha.

O fechamento usa tolerância **exata** (não os 0,011 gerais) porque, com o
desconto de arredondamento, não há motivo para sobrar centavo.

---

## Casos em que o pedido é recusado

Nenhuma alteração é feita:

- TOP diferente de 1755
- mais de um pedido selecionado
- pedido sem itens, ou só com linhas de KP
- **desconto no rodapé** (`VLRDESCTOT` ou `PERCDESC`) com `PIX_HABILITADO = false`
- item **não modelável** — qualquer fórmula falhando na calibração
- item com venda reconstruída ≤ 0 (desconto maior que o preço)
- alvo que não fecha com 2 decimais
- sem gabarito de KP para a faixa necessária

---

## Ativação gradual

```
1. SIMULACAO = true                                   → conferir o relatório
2. SIMULACAO = false, três chaves false               → exercita o caminho até o fim
3. GRAVAR_ITENS = true + GRAVAR_KP = true             → a unidade que fecha o valor
4. + GRAVAR_CABECALHO = true                          → completo
```

Ligar `GRAVAR_ITENS` ou `GRAVAR_KP` **sozinho** reprova por construção em
pedido que precisa de KP novo: o item sozinho não reconstitui a venda, e o KP
sozinho a excede. Os dois formam a unidade que fecha.

Rodar duas vezes seguidas com tudo ligado é o teste de idempotência — nenhum
valor de item deve mudar na segunda passagem.

---

## Limitações conhecidas

**Replica o motor fiscal em vez de chamá-lo.** O Sankhya não recalcula em
gravação server-side (quatro vias testadas, ver `DIAGNOSTICO.md`). A
auto-calibração e a verificação com rollback são as proteções, mas gravar base
de IPI e ICMS por script é decisão de arquitetura que deve ser conhecida pelo
CTO e revisada por quem cuida do fiscal.

**Gravação do cabeçalho pode comitar em transação própria.** Observado no
pedido 202543: após uma execução reprovada, `QTDVOL` e `DTNEG` permaneceram
alterados enquanto os itens foram desfeitos. Indício de que
`Registro.save()` confirma separadamente do Jape. Correção pendente: verificar
os itens **antes** de encostar no cabeçalho, em vez de verificar tudo no fim.

**Desconto Pix desligado.** Pedido com desconto no rodapé é recusado. Ao
religar (`PIX_HABILITADO = true`), atenção: a faixa de KP é decidida sobre a
venda antes do Pix, e essa informação desaparece quando o campo é zerado — se
o Pix cruzar uma fronteira de faixa, uma segunda execução pode escolher faixa
menor.

**`TIPFRETE` Incluso não confirmado.** `TIPFRETE_INCLUSO = null`, então pedido
com frete não tem o campo alterado. Falta abrir um pedido com `TIPFRETE = 'S'`
e frete > 0 e conferir o rótulo no Rodapé → Transporte.

**Acréscimo por parcelamento** entra pelo parâmetro `ACRESCIMO` do botão, por
não ter campo conhecido no ERP.

**Distribuição proporcional.** Pix e acréscimo são distribuídos entre itens
proporcionalmente ao valor, consistente com o KP. A calculadora original
dividia igualmente — decisão pendente de confirmação.

**Linha de KP inserida por script** não passa pela liberação normal. Vale
confirmar com quem conhece o fluxo de faturamento se há outros campos de
controle além dos tratados.

---

## Manutenção

**Recusas são sinal, não ruído.** Se itens começarem a aparecer como "não
modelável", algo mudou na tributação — produto de outro estado, redução de
base, alteração de parametrização. A auto-calibração protege o dado, mas
alguém precisa investigar a causa.

**Rhino, cuidados obrigatórios:**

- todo código dentro de funções; o topo do script tem limite de offset de
  16 bits (`bad offset`)
- **nunca** nomear função ou variável como `contexto` — a global com esse nome
  quebra o Rhino com erro **não capturável**
- ES5: sem `let`/`const`, arrow, template literal, `Object.assign`,
  `Number.EPSILON`
- `BigDecimal` sempre construído a partir de **string**, para não levar ruído
  de ponto flutuante ao banco
- retorno ao usuário é **atribuição**: `mensagem = txt`

**Alterar a tabela de KP** exige apenas editar `KP_TABLE`. Faixa nova precisa
de um KP inserido manualmente uma vez, para servir de gabarito fiscal.

---

## Arquivos

| Arquivo | Conteúdo |
|---|---|
| `normalizador-pedido-v5.js` | o script |
| `README.md` | este documento |
| `DIAGNOSTICO.md` | histórico da investigação e caminhos descartados |
