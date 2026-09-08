// ============================================================
//  NORMALIZADOR DE PEDIDO DE MARKETPLACE - v5
//  Acao de tabela sobre TGFCAB
//
//  NOVIDADE: grava ITENS e LINHA DE KP, alem do cabecalho.
//
//  ============ COMO ISSO FICOU SEGURO ============
//  O motor do Sankhya NAO recalcula nada em gravacao por script
//  (testado: Jape, Registro.save em TGFCAB, Registro.save em
//  TGFITE, e refresh de tela). Entao este script calcula TODOS
//  os campos derivados. O que torna isso defensavel:
//
//  AUTO-CALIBRACAO. Antes de gravar, cada formula e testada
//  contra o ESTADO ATUAL do proprio item. Se a formula reproduz
//  o que o Sankhya gravou ali, ela vale para o valor novo. Se
//  qualquer uma falhar, o item e RECUSADO e o pedido nao e
//  alterado.
//
//  Isso resolve a duvida da base de ICMS: existem dois regimes
//  (IPI compondo ou nao a base) e nao descobri o discriminador -
//  testei tipo de negociacao, frete, IPIINCICMS, BASICMMOD,
//  CODTRIB e TIPPESSOA, todos negativos. Mas nao preciso saber
//  POR QUE: leio qual regime vale lendo o proprio item.
//
//  LINHA DE KP e exata, nao estimada: o KP tem valor fixo por
//  SKU, entao os campos fiscais sao COPIADOS de uma linha de KP
//  real do mesmo SKU - valores que o proprio Sankhya calculou
//  para aquele mesmo valor.
//
//  ROLLBACK EXISTE: throw desfaz a transacao (comprovado). A
//  verificacao pos-gravacao e rede de seguranca de verdade.
//
//  ============ RESSALVA ============
//  Isto replica o motor fiscal em vez de chama-lo. A auto-
//  calibracao protege contra formula errada, mas a decisao de
//  gravar base de calculo por script deve passar pelo pessoal
//  fiscal antes de producao.
//
//  Motor Rhino: ES5, tudo em funcoes. NAO nomear nada como
//  'contexto' (global que o Rhino nao manipula).
// ============================================================

// ---------- configuracao ----------

var SIMULACAO        = true;
var GRAVAR_CABECALHO = false;
var GRAVAR_ITENS     = false;
var GRAVAR_KP        = false;

var PIX_HABILITADO      = false;
var CODCENCUS_ALVO      = 20000000;
var CODTIPOPER_ESPERADO = 1755;
var CAMPO_OBS_INTERNA   = "AD_INTERNAOBS";
var CAMPO_NOME_USUARIO  = "NOMEUSU";
var PRESERVAR_OBS_INTERNA = true;   // nao sobrescreve autoria de outro operador
// TIPFRETE: 'N' = Extra nota (confirmado no 202443: frete 0, TIPFRETE 'N',
// tela mostra "Extra nota"). 'S' = Incluso, ainda por confirmar na tela.
var TIPFRETE_EXTRANOTA  = "N";
var TIPFRETE_INCLUSO    = null;     // "S" apos confirmar na tela
var SCH                 = "";
var TOL                 = 0.011;
var DESC_TOTAL_LINHA    = true;

// "Desconto total por item" no Rodape > Totais e COLUNA GRAVADA no TGFCAB
// (VLRDESCTOTITEM), nao calculo de exibicao. Como nada recalcula, o script
// tem de grava-la, senao ela fica com o valor antigo do TemApi - visto no
// 202443: itens com VLRDESC 0 e o rodape ainda mostrando 260,90.
// VLRDESCTOTITEMMOE e a versao em moeda; em pedido em real espelha a outra.
var GRAVAR_DESCTOTITEM  = true;
var CAMPO_DESCITEM      = "VLRDESCTOTITEM";
var CAMPO_DESCITEM_MOE  = "VLRDESCTOTITEMMOE";

var KP_TABLE = [
  { sku: 2310, nome: 'KP1',  vl:  29.90, min:   74.75, max:  200.00 },
  { sku: 2311, nome: 'KP3',  vl:  89.70, min:  200.00, max:  448.50 },
  { sku: 2312, nome: 'KP6',  vl: 179.40, min:  448.50, max:  897.00 },
  { sku: 2313, nome: 'KP9',  vl: 269.10, min:  897.00, max: 1345.50 },
  { sku: 2314, nome: 'KP12', vl: 358.80, min: 1345.50, max: 1794.00 },
  { sku: 2315, nome: 'KP18', vl: 538.20, min: 1794.00, max: 2691.00 },
  { sku: 2316, nome: 'KP24', vl: 717.60, min: 2691.00, max: 3588.00 }
];

// Campos copiados da linha de KP gabarito (fiscais + operacionais do SKU).
// ATENCAO: NAO inclui campos de CICLO DE VIDA. O gabarito vem de um pedido
// JA FATURADO, onde QTDENTREGUE=1, PENDENTE='N' e STATUSNOTA='L' sao
// legitimos. Copiar isso para linha nova faz o Sankhya considerar o item
// faturado e bloquear a exclusao ("Item ja foi faturado. Nao pode ser
// excluido." - CORE_E01541). Esses campos vem do PROPRIO pedido.
var CAMPOS_KP = ["CODEMP", "CODLOCALORIG", "USOPROD", "CODCFO", "CODVOL",
                 "CODTRIB", "ATUALESTOQUE", "RESERVA", "FATURAR",
                 "CSTIPI", "CODBENEFNAUF", "CODSIT08EFD", "GERAPRODUCAO",
                 "ORIGPROD", "ATUALESTTERC", "TERCEIROS",
                 "SOLCOMPRA", "STATUSLOTE", "NUTAB", "PRODUTONFE",
                 "INDDEVOLUCAONFCOM", "CODVEND", "ALIQIPI", "BASEIPI",
                 "VLRIPI", "ALIQICMS", "BASEICMS", "VLRICMS", "CODENQIPI",
                 "BASICMMOD", "ALIQICMSRED", "CODANTECIPST"];

// Ciclo de vida: lidos de um item de PRODUTO do proprio pedido, para a linha
// de KP nascer no mesmo estado das outras. QTDENTREGUE sempre 0.
var CAMPOS_CICLO = ["PENDENTE", "STATUSNOTA"];

var rel = [], erros = [], avisos = [], feitos = [];
var JF = Packages.br.com.sankhya.jape.wrapper.JapeFactory;


// ---------- utilitarios ----------

function round2(v) { return Math.round((Number(v) + 0.0000001) * 100) / 100; }
function f2(v) { var n = Number(v); return isNaN(n) ? "-" : n.toFixed(2); }
function padL(t, n) { var s = String(t); while (s.length < n) s = " " + s; return s; }
function isKp(c) { return c >= 2310 && c <= 2316; }
function fIpi(a) { return 1 + (Number(a) || 0) / 100; }
function bd(v) { return new java.math.BigDecimal(String(v)); }
function perto(a, b) { return Math.abs(Number(a) - Number(b)) < TOL; }

function box(t) {
    rel.push("");
    rel.push("=================================================");
    rel.push(t);
    rel.push("=================================================");
}

function paramNum(nome) {
    try {
        var v = getParam(nome);
        if (v === null || v === undefined || String(v) === "") return 0;
        return Number(v);
    } catch (e) { return 0; }
}

function tsHoje() {
    var d = new Date();
    var z = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    return new java.sql.Timestamp(java.lang.Long.parseLong(String(z.getTime())));
}

function ddmm() {
    var d = new Date();
    return ("0" + d.getDate()).slice(-2) + "/" + ("0" + (d.getMonth() + 1)).slice(-2);
}

function nomeUsuario() {
    try {
        return String(Packages.br.com.sankhya.modelcore.auth.AuthenticationInfo
                      .getCurrent().getUsuVO().asString(CAMPO_NOME_USUARIO));
    } catch (e) {
        try { return "CODUSU " + String(getUsuarioLogado()); } catch (e2) { return "?"; }
    }
}

function retornaMensagem(txt) {
    try {
        mensagem = txt;
        if (String(mensagem) === String(txt)) return true;
    } catch (e) { }
    try { java.lang.System.out.println("[NORMALIZADOR] " + txt); } catch (e) { }
    return false;
}


// ---------- leitura ----------

function lerCabecalho(nunota) {
    var vo = JF.dao("CabecalhoNota").findByPK([bd(nunota)]);
    var c = {};
    c.CODTIPOPER  = Number(vo.asBigDecimalOrZero("CODTIPOPER"));
    c.CODTIPVENDA = Number(vo.asBigDecimalOrZero("CODTIPVENDA"));
    c.CODCENCUS   = Number(vo.asBigDecimalOrZero("CODCENCUS"));
    c.VLRNOTA     = Number(vo.asBigDecimalOrZero("VLRNOTA"));
    c.VLRDESCTOT  = Number(vo.asBigDecimalOrZero("VLRDESCTOT"));
    c.PERCDESC    = Number(vo.asBigDecimalOrZero("PERCDESC"));
    c.VLRFRETE    = Number(vo.asBigDecimalOrZero("VLRFRETE"));
    c.QTDVOL      = Number(vo.asBigDecimalOrZero("QTDVOL"));
    c.TIPFRETE    = String(vo.asString("TIPFRETE"));
    c.OBSERVACAO  = String(vo.asString("OBSERVACAO"));
    c.DTNEG       = String(vo.getProperty("DTNEG"));
    c.DTMOV       = String(vo.getProperty("DTMOV"));
    c.OBSINT_OK   = false;
    try { c.OBSINT = String(vo.asString(CAMPO_OBS_INTERNA)); c.OBSINT_OK = true; }
    catch (e) { c.OBSINT = "(ilegivel)"; }
    c.DESCITEM_OK = false;
    try { c.DESCITEM = Number(vo.asBigDecimalOrZero(CAMPO_DESCITEM)); c.DESCITEM_OK = true; }
    catch (e) { c.DESCITEM = null; }
    c.DESCITEMMOE_OK = false;
    try { c.DESCITEMMOE = Number(vo.asBigDecimalOrZero(CAMPO_DESCITEM_MOE)); c.DESCITEMMOE_OK = true; }
    catch (e) { c.DESCITEMMOE = null; }
    return c;
}

function lerItens(nunota) {
    var out = [], q = getQuery();
    q.nativeSelect("SELECT SEQUENCIA, CODPROD, QTDNEG, VLRUNIT, VLRTOT, VLRDESC," +
                   " PERCDESC, ALIQIPI, BASEIPI, VLRIPI, ALIQICMS, BASEICMS," +
                   " VLRICMS FROM " + SCH + "TGFITE WHERE NUNOTA = " + nunota +
                   " ORDER BY SEQUENCIA");
    while (q.next()) {
        out.push({
            sequencia: Number(q.getBigDecimal("SEQUENCIA")),
            codprod:   Number(q.getBigDecimal("CODPROD")),
            qtdneg:    Number(q.getBigDecimal("QTDNEG")),
            vlrunit:   Number(q.getBigDecimal("VLRUNIT")),
            vlrtot:    Number(q.getBigDecimal("VLRTOT")),
            vlrdesc:   Number(q.getBigDecimal("VLRDESC")),
            percdesc:  Number(q.getBigDecimal("PERCDESC")),
            aliqipi:   Number(q.getBigDecimal("ALIQIPI")),
            baseipi:   Number(q.getBigDecimal("BASEIPI")),
            vlripi:    Number(q.getBigDecimal("VLRIPI")),
            aliqicms:  Number(q.getBigDecimal("ALIQICMS")),
            baseicms:  Number(q.getBigDecimal("BASEICMS")),
            vlricms:   Number(q.getBigDecimal("VLRICMS"))
        });
    }
    return out;
}


// ============================================================
//  AUTO-CALIBRACAO
//  Testa cada formula contra o estado ATUAL do item. Se todas
//  reproduzem o que o Sankhya gravou, valem para o valor novo.
// ============================================================

function calibrar(it) {
    var d = { ok: true, motivos: [] };

    // 1. VLRTOT = VLRUNIT * QTDNEG
    if (!perto(it.vlrtot, it.vlrunit * it.qtdneg)) {
        d.ok = false;
        d.motivos.push("VLRTOT " + f2(it.vlrtot) + " != VLRUNIT x QTDNEG " +
                       f2(it.vlrunit * it.qtdneg) + " (item alterado sem recalculo)");
        return d;   // estado inconsistente: nao da para calibrar o resto
    }

    // 2. BASEIPI: igual ao VLRTOT quando ha IPI; zero quando nao ha
    d.baseIpiSegueTot = perto(it.baseipi, it.vlrtot);
    if (it.aliqipi > 0) {
        if (!d.baseIpiSegueTot) {
            d.ok = false;
            d.motivos.push("BASEIPI " + f2(it.baseipi) + " != VLRTOT " + f2(it.vlrtot));
        }
    } else {
        if (!perto(it.baseipi, 0) && !d.baseIpiSegueTot) {
            d.ok = false;
            d.motivos.push("IPI 0% mas BASEIPI = " + f2(it.baseipi));
        }
    }

    // 3. VLRIPI = BASEIPI * ALIQIPI/100
    if (!perto(it.vlripi, round2(it.baseipi * it.aliqipi / 100))) {
        d.ok = false;
        d.motivos.push("VLRIPI " + f2(it.vlripi) + " != BASEIPI x ALIQIPI " +
                       f2(it.baseipi * it.aliqipi / 100));
    }

    // 4. BASEICMS: descobre o REGIME lendo o proprio item.
    //    Ha dois em uso e o discriminador nao foi identificado -
    //    entao le-se qual vale aqui em vez de supor.
    var comIpi = round2(it.vlrtot + it.vlripi - it.vlrdesc);
    var semIpi = round2(it.vlrtot - it.vlrdesc);
    if (perto(it.baseicms, comIpi))      d.regimeIcms = "COM_IPI";
    else if (perto(it.baseicms, semIpi)) d.regimeIcms = "SEM_IPI";
    else {
        d.ok = false;
        d.regimeIcms = null;
        d.motivos.push("BASEICMS " + f2(it.baseicms) + " nao bate com nenhum regime " +
                       "conhecido (com IPI " + f2(comIpi) + " / sem IPI " + f2(semIpi) + ")");
    }

    // 5. VLRICMS = BASEICMS * ALIQICMS/100
    if (!perto(it.vlricms, round2(it.baseicms * it.aliqicms / 100))) {
        d.ok = false;
        d.motivos.push("VLRICMS " + f2(it.vlricms) + " != BASEICMS x ALIQICMS " +
                       f2(it.baseicms * it.aliqicms / 100));
    }

    return d;
}

// Aplica as formulas calibradas ao valor novo.
// alvoLinha = bruto que esta linha deve carregar (venda menos a parte do KP).
//
// DESCONTO DE ARREDONDAMENTO (regra da casa): com IPI nao existe valor
// unitario de 2 decimais que reconstitua qualquer alvo. Ex: 29,90 / 1,065 =
// 28,0751 -> 28,08, e 28,08 x 1,065 = 29,91, um centavo acima. O residuo vai
// para VLRDESC, que e exatamente o que os operadores fazem (pedido 202411:
// itens a 28,08 com VLRDESC 0,01, fechando 59,80 ao centavo).
function derivar(cal, alvoLinha, qtd, aliqipi, aliqicms) {
    var f = fIpi(aliqipi);
    var unit = round2((alvoLinha / f) / qtd);
    var o = null;

    // se o bruto ficar ABAIXO do alvo, sobe um centavo no unitario e repete:
    // desconto nao pode ser negativo
    for (var t = 0; t < 4; t++) {
        var vlrtot  = round2(unit * qtd);
        var baseipi = (aliqipi > 0 || cal.baseIpiSegueTot) ? vlrtot : 0;
        var vlripi  = round2(baseipi * aliqipi / 100);
        var bruto   = round2(vlrtot + vlripi);
        var resid   = round2(bruto - alvoLinha);
        if (resid < -0.0001) { unit = round2(unit + 0.01); continue; }
        o = { unit: unit, vlrtot: vlrtot, baseipi: baseipi,
              vlripi: vlripi, vlrdesc: resid, alvo: alvoLinha };
        break;
    }
    if (o === null) return null;

    o.percdesc = (o.vlrtot > 0 && o.vlrdesc > 0)
               ? round2(o.vlrdesc / o.vlrtot * 100) : 0;
    o.baseicms = (cal.regimeIcms === "COM_IPI")
               ? round2(o.vlrtot + o.vlripi - o.vlrdesc)
               : round2(o.vlrtot - o.vlrdesc);
    o.vlricms  = round2(o.baseicms * aliqicms / 100);
    o.fecha    = round2(o.vlrtot + o.vlripi - o.vlrdesc);
    return o;
}


// ---------- calculo do valor (nucleo de 43 testes) ----------

function faixaKp(total) {
    for (var k = 0; k < KP_TABLE.length; k++) {
        if (total >= KP_TABLE[k].min && total < KP_TABLE[k].max) return KP_TABLE[k];
    }
    var u = KP_TABLE[KP_TABLE.length - 1];
    return (total >= u.max) ? u : null;
}

function calcular(cab, itens) {
    var D = { produtos: [], kpExist: [] };
    for (var i = 0; i < itens.length; i++) {
        if (isKp(itens[i].codprod)) D.kpExist.push(itens[i]);
        else D.produtos.push(itens[i]);
    }
    if (D.produtos.length === 0) { erros.push("Pedido so tem linhas de KP."); return D; }
    if (D.kpExist.length > 1) {
        avisos.push("Pedido tem " + D.kpExist.length + " linhas de KP; maximo 1.");
    }

    var soma = 0;
    for (var j = 0; j < D.produtos.length; j++) {
        var it = D.produtos[j], qtd = it.qtdneg || 1;
        var du = DESC_TOTAL_LINHA ? (it.vlrdesc / qtd) : it.vlrdesc;
        it._qtd = qtd;
        it._vendaUnit = round2(it.vlrunit * fIpi(it.aliqipi) - du);
        it._vendaLinha = round2(it._vendaUnit * qtd);
        if (it._vendaUnit <= 0) {
            erros.push("Item seq " + it.sequencia + ": venda reconstruida em " +
                       f2(it._vendaUnit) + ". Desconto maior que o preco.");
        }
        soma += it._vendaLinha;
    }
    D.somaProdutos = round2(soma);

    // idempotencia: devolve o KP existente a base antes de decidir a faixa
    var dev = 0;
    for (var k = 0; k < D.kpExist.length; k++) {
        var ki = D.kpExist[k], kq = ki.qtdneg || 1;
        var kdu = DESC_TOTAL_LINHA ? (ki.vlrdesc / kq) : ki.vlrdesc;
        dev += round2((ki.vlrunit * fIpi(ki.aliqipi) - kdu) * kq);
    }
    D.kpDevolvido = round2(dev);
    D.totalVenda = round2(D.somaProdutos + D.kpDevolvido);

    if (D.kpDevolvido > 0 && D.somaProdutos > 0) {
        for (var m = 0; m < D.produtos.length; m++) {
            var p = D.produtos[m];
            p._vendaLinha = round2(p._vendaLinha +
                                   D.kpDevolvido * (p._vendaLinha / D.somaProdutos));
            p._vendaUnit = round2(p._vendaLinha / p._qtd);
        }
        avisos.push("KP existente de " + f2(D.kpDevolvido) +
                    " devolvido a base (idempotencia).");
    }

    D.kp = faixaKp(D.totalVenda);
    if (D.kp === null && D.totalVenda < KP_TABLE[0].min) {
        avisos.push("Total " + f2(D.totalVenda) + " abaixo do piso de KP. Sem KP.");
    }
    var kpVl = D.kp ? D.kp.vl : 0;

    // alvo bruto de cada linha: venda da linha menos a parte proporcional do KP
    var alvoTotal = round2(D.totalVenda - kpVl);
    var alvos = [], somaAlvos = 0;
    for (var n = 0; n < D.produtos.length; n++) {
        var q0 = D.produtos[n];
        var prop = D.totalVenda > 0 ? (q0._vendaLinha / D.totalVenda) : (1 / D.produtos.length);
        var a = round2(q0._vendaLinha - kpVl * prop);
        alvos.push(a);
        somaAlvos += a;
    }
    // sobra de arredondamento da distribuicao vai para a maior linha
    var sobra = round2(alvoTotal - round2(somaAlvos));
    if (sobra !== 0 && alvos.length > 0) {
        var maior = 0;
        for (var mm = 1; mm < alvos.length; mm++) if (alvos[mm] > alvos[maior]) maior = mm;
        alvos[maior] = round2(alvos[maior] + sobra);
    }

    D.novos = [];
    for (var n2 = 0; n2 < D.produtos.length; n2++) {
        var q = D.produtos[n2];
        var cal = calibrar(q);
        var der = cal.ok ? derivar(cal, alvos[n2], q._qtd, q.aliqipi, q.aliqicms) : null;
        if (!cal.ok) {
            erros.push("Item seq " + q.sequencia + " (prod " + q.codprod +
                       ") NAO MODELAVEL:");
            for (var z = 0; z < cal.motivos.length; z++) erros.push("     " + cal.motivos[z]);
        } else if (der === null) {
            erros.push("Item seq " + q.sequencia + ": nao consegui fechar o alvo de " +
                       f2(alvos[n2]) + " com 2 decimais.");
        } else {
            var maxResid = round2(0.01 * q._qtd + 0.01);
            if (der.vlrdesc > maxResid) {
                avisos.push("Item seq " + q.sequencia + ": desconto de arredondamento " +
                            f2(der.vlrdesc) + " acima do esperado (" + f2(maxResid) + ").");
            }
        }
        D.novos.push({
            sequencia: q.sequencia, codprod: q.codprod, qtdneg: q._qtd,
            aliqipi: q.aliqipi, aliqicms: q.aliqicms,
            atual: q, unitNovo: (der === null ? null : der.unit),
            cal: cal, der: der, alvo: alvos[n2],
            venda: q._vendaLinha, kpShare: round2(kpVl * (D.totalVenda > 0
                     ? q._vendaLinha / D.totalVenda : 1 / D.produtos.length))
        });
    }

    if (D.kp && D.kpExist.length === 0)      D.acaoKp = "INSERIR";
    else if (D.kp && D.kpExist.length >= 1)  D.acaoKp = "ATUALIZAR";
    else if (!D.kp && D.kpExist.length >= 1) D.acaoKp = "REMOVER";
    else                                      D.acaoKp = "NENHUMA";

    D.qtdVol = 0;
    for (var v = 0; v < D.produtos.length; v++) D.qtdVol += D.produtos[v]._qtd;
    D.obsInterna = nomeUsuario() + " - " + ddmm();

    // VLRNOTA alvo: soma dos itens no estado novo + KP + frete
    var vn = 0;
    for (var w = 0; w < D.novos.length; w++) {
        if (D.novos[w].der === null) { vn = null; break; }
        vn += D.novos[w].der.fecha;      // ja liquido do desconto de arredondamento
    }
    D.vlrnotaAlvo = (vn === null) ? null : round2(vn + kpVl + cab.VLRFRETE);

    // soma dos descontos dos itens no estado novo (a linha de KP entra com 0):
    // e o que o campo "Desconto total por item" do rodape deve mostrar
    var sd = 0, sdOk = true;
    for (var y = 0; y < D.novos.length; y++) {
        if (D.novos[y].der === null) { sdOk = false; break; }
        sd += D.novos[y].der.vlrdesc;
    }
    D.descItemAlvo = sdOk ? round2(sd) : null;
    return D;
}


// ---------- validacao ----------

function validar(cab, itens) {
    if (cab.CODTIPOPER !== CODTIPOPER_ESPERADO) {
        erros.push("TOP " + cab.CODTIPOPER + ", esperado " + CODTIPOPER_ESPERADO + ".");
    }
    if (!PIX_HABILITADO && (cab.VLRDESCTOT !== 0 || cab.PERCDESC !== 0)) {
        erros.push("Desconto no rodape (Vlr " + f2(cab.VLRDESCTOT) + " / Perc " +
                   f2(cab.PERCDESC) + ") com a regra de Pix DESLIGADA. Tratar a mao.");
    }
    // VLRNOTA atual deve reproduzir a soma dos itens: se nao, o pedido ja
    // esta inconsistente e nao da para confiar em nada.
    var s = 0;
    for (var i = 0; i < itens.length; i++) {
        s += itens[i].vlrtot + itens[i].vlripi - itens[i].vlrdesc;
    }
    s = round2(s + cab.VLRFRETE - cab.VLRDESCTOT);
    if (!perto(cab.VLRNOTA, s)) {
        avisos.push("VLRNOTA atual " + f2(cab.VLRNOTA) + " nao reproduz a soma dos " +
                    "itens (" + f2(s) + "). Diferenca de " + f2(cab.VLRNOTA - s) + ".");
    }
}


// ---------- relatorio ----------

function relatorio(cab, D, nunota) {
    box("SITUACAO ATUAL");
    rel.push("  TOP / negociacao .. " + cab.CODTIPOPER + " / " + cab.CODTIPVENDA);
    rel.push("  Vlr. Nota ......... " + f2(cab.VLRNOTA));
    rel.push("  Centro / volumes .. " + cab.CODCENCUS + " / " + cab.QTDVOL);
    rel.push("  Obs. Interna ...... " + cab.OBSINT);

    box("VENDA RECONSTRUIDA");
    rel.push("  Soma produtos " + f2(D.somaProdutos) +
             (D.kpDevolvido > 0 ? "  + KP devolvido " + f2(D.kpDevolvido) : "") +
             "  =  TOTAL " + f2(D.totalVenda));
    rel.push("  KP da faixa: " + (D.kp ? D.kp.nome + " = " + f2(D.kp.vl) : "nenhum"));

    box("ITENS - CALIBRACAO E VALORES NOVOS");
    for (var i = 0; i < D.novos.length; i++) {
        var n = D.novos[i], a = n.atual;
        rel.push("");
        rel.push("  seq " + n.sequencia + "  prod " + n.codprod + "  qtd " + n.qtdneg +
                 "  IPI " + f2(n.aliqipi) + "%  ICMS " + f2(n.aliqicms) + "%");
        if (!n.cal.ok) {
            rel.push("    *** NAO MODELAVEL ***");
            for (var z = 0; z < n.cal.motivos.length; z++) rel.push("    X " + n.cal.motivos[z]);
            continue;
        }
        rel.push("    calibrado: regime ICMS = " + n.cal.regimeIcms +
                 " (lido do estado atual)");
        rel.push("    campo      atual        ->  novo");
        rel.push("    VLRUNIT   " + padL(f2(a.vlrunit), 10) + "    ->  " + f2(n.unitNovo));
        rel.push("    VLRTOT    " + padL(f2(a.vlrtot), 10) + "    ->  " + f2(n.der.vlrtot));
        rel.push("    VLRDESC   " + padL(f2(a.vlrdesc), 10) + "    ->  " +
                 f2(n.der.vlrdesc) +
                 (n.der.vlrdesc > 0 ? "   (arredondamento)" : ""));
        rel.push("    PERCDESC  " + padL(f2(a.percdesc), 10) + "    ->  " + f2(n.der.percdesc));
        rel.push("    BASEIPI   " + padL(f2(a.baseipi), 10) + "    ->  " + f2(n.der.baseipi));
        rel.push("    VLRIPI    " + padL(f2(a.vlripi), 10) + "    ->  " + f2(n.der.vlripi));
        rel.push("    BASEICMS  " + padL(f2(a.baseicms), 10) + "    ->  " + f2(n.der.baseicms));
        rel.push("    VLRICMS   " + padL(f2(a.vlricms), 10) + "    ->  " + f2(n.der.vlricms));
        rel.push("    alvo da linha " + f2(n.der.alvo) + "  ->  fecha em " + f2(n.der.fecha) +
                 (perto(n.der.fecha, n.der.alvo) ? "  (exato)" : "  *** NAO FECHA ***"));
    }

    box("LINHA DE KP");
    for (var c = 0; c < D.kpExist.length; c++) {
        rel.push("  existente: seq " + D.kpExist[c].sequencia + " prod " +
                 D.kpExist[c].codprod + " a " + f2(D.kpExist[c].vlrunit));
    }
    if (D.kpExist.length === 0) rel.push("  existente: nenhuma");
    rel.push("  ACAO: " + D.acaoKp +
             (D.kp ? " -> " + D.kp.nome + " (SKU " + D.kp.sku + ") a " + f2(D.kp.vl) : ""));
    if (D.acaoKp === "INSERIR" || D.acaoKp === "ATUALIZAR") {
        rel.push("  (campos fiscais copiados de linha de KP real do mesmo SKU:");
        rel.push("   valor fixo por SKU, entao a copia e exata e nao estimada)");
    }

    box("CABECALHO");
    rel.push("  Dt. neg / mov ..... " + cab.DTNEG + " / " + cab.DTMOV +
             "  ->  " + ddmm());
    rel.push("  Centro resultado .. " + cab.CODCENCUS + "  ->  " + CODCENCUS_ALVO);
    rel.push("  Observacao ........ " + cab.OBSERVACAO + "  ->  " + nunota);
    var obsAcao;
    if (!cab.OBSINT_OK) obsAcao = "(campo ilegivel - nao altera)";
    else if (PRESERVAR_OBS_INTERNA && String(cab.OBSINT) !== "null" &&
             String(cab.OBSINT) !== "") obsAcao = "PRESERVADA (ja preenchida)";
    else obsAcao = D.obsInterna;
    rel.push("  Obs. Interna ...... " + cab.OBSINT + "  ->  " + obsAcao);
    rel.push("  Descontos rodape .. " + f2(cab.VLRDESCTOT) + " / " + f2(cab.PERCDESC) +
             "  ->  0.00 / 0.00");
    if (GRAVAR_DESCTOTITEM && cab.DESCITEM_OK) {
        rel.push("  Desc. total item .. " + f2(cab.DESCITEM) + "  ->  " +
                 (D.descItemAlvo === null ? "(indefinido)" : f2(D.descItemAlvo)) +
                 "   (soma dos descontos dos itens)");
    } else if (GRAVAR_DESCTOTITEM) {
        rel.push("  Desc. total item .. (campo " + CAMPO_DESCITEM + " ilegivel)");
    }
    rel.push("  Qtd. volumes ...... " + cab.QTDVOL + "  ->  " + D.qtdVol);
    rel.push("  Vlr. Nota ......... " + f2(cab.VLRNOTA) + "  ->  " +
             (D.vlrnotaAlvo === null ? "(indefinido)" : f2(D.vlrnotaAlvo)) +
             "   (venda " + f2(D.totalVenda) +
             (cab.VLRFRETE !== 0 ? " + frete " + f2(cab.VLRFRETE) : "") + ")");
    var tf;
    if (cab.VLRFRETE === 0 && TIPFRETE_EXTRANOTA !== null) {
        tf = TIPFRETE_EXTRANOTA + " (Extra nota - frete zero)";
    } else if (cab.VLRFRETE !== 0 && TIPFRETE_INCLUSO !== null) {
        tf = TIPFRETE_INCLUSO + " (Incluso - frete > 0)";
    } else {
        tf = "(TIPFRETE_INCLUSO nao confirmado - nao altera)";
    }
    rel.push("  TIPFRETE .......... " + cab.TIPFRETE + "  ->  " + tf);

    if (avisos.length > 0) {
        box("AVISOS");
        for (var w = 0; w < avisos.length; w++) rel.push("  ! " + avisos[w]);
    }
}


// ---------- gravacao ----------

function gravarItens(D, nunota) {
    var dao = JF.dao("ItemNota");
    for (var g = 0; g < D.novos.length; g++) {
        var n = D.novos[g];
        var vo = dao.findByPK([bd(nunota), bd(n.sequencia)]);
        dao.prepareToUpdate(vo)
           .set("VLRUNIT",  bd(f2(n.unitNovo)))
           .set("VLRTOT",   bd(f2(n.der.vlrtot)))
           .set("VLRDESC",  bd(f2(n.der.vlrdesc)))
           .set("PERCDESC", bd(f2(n.der.percdesc)))
           .set("BASEIPI",  bd(f2(n.der.baseipi)))
           .set("VLRIPI",   bd(f2(n.der.vlripi)))
           .set("BASEICMS", bd(f2(n.der.baseicms)))
           .set("VLRICMS",  bd(f2(n.der.vlricms)))
           .update();
        feitos.push("item seq " + n.sequencia + ": " + f2(n.atual.vlrunit) + " -> " +
                    f2(n.unitNovo) + ", desconto " + f2(n.atual.vlrdesc) + " -> " +
                    f2(n.der.vlrdesc) + (n.der.vlrdesc > 0 ? " (arredondamento)" : "") +
                    ", IPI/ICMS recalculados, fecha em " + f2(n.der.fecha));
    }
}

function gabaritoKp(sku, nunota) {
    var q = getQuery();
    q.nativeSelect("SELECT * FROM (SELECT I.NUNOTA, I.SEQUENCIA FROM " + SCH +
                   "TGFITE I JOIN " + SCH + "TGFCAB C ON C.NUNOTA = I.NUNOTA" +
                   " WHERE I.CODPROD = " + sku +
                   " AND C.CODTIPOPER = " + CODTIPOPER_ESPERADO +
                   " AND I.NUNOTA <> " + nunota +
                   " AND I.VLRDESC = 0" +
                   " ORDER BY I.NUNOTA DESC) WHERE ROWNUM = 1");
    if (!q.next()) return null;
    var gnu = q.getBigDecimal("NUNOTA"), gseq = q.getBigDecimal("SEQUENCIA");
    var vo = JF.dao("ItemNota").findByPK([gnu, gseq]);
    var g = { origem: String(gnu) + "/" + String(gseq), campos: {} };
    for (var i = 0; i < CAMPOS_KP.length; i++) {
        var k = CAMPOS_KP[i];
        try { g.campos[k] = vo.getProperty(k); } catch (e) { g.campos[k] = null; }
    }
    // confere que o gabarito tem o valor esperado do SKU
    g.vlrunit = Number(vo.asBigDecimalOrZero("VLRUNIT"));
    return g;
}

function proximaSequencia(nunota) {
    var q = getQuery();
    q.nativeSelect("SELECT NVL(MAX(SEQUENCIA),0) + 1 AS S FROM " + SCH +
                   "TGFITE WHERE NUNOTA = " + nunota);
    return q.next() ? Number(q.getBigDecimal("S")) : 1;
}

// estado de ciclo de vida de um item de produto do proprio pedido
function cicloDoPedido(D, nunota) {
    var o = {};
    if (D.produtos.length === 0) return o;
    try {
        var vo = JF.dao("ItemNota").findByPK([bd(nunota), bd(D.produtos[0].sequencia)]);
        for (var i = 0; i < CAMPOS_CICLO.length; i++) {
            try { o[CAMPOS_CICLO[i]] = vo.getProperty(CAMPOS_CICLO[i]); }
            catch (e) { }
        }
    } catch (e) { }
    return o;
}

function gravarKp(D, nunota) {
    if (D.acaoKp === "NENHUMA") return;
    var dao = JF.dao("ItemNota");

    if (D.acaoKp === "REMOVER" || D.acaoKp === "ATUALIZAR") {
        for (var r = 0; r < D.kpExist.length; r++) {
            dao.delete([bd(nunota), bd(D.kpExist[r].sequencia)]);
            feitos.push("KP removido: seq " + D.kpExist[r].sequencia);
        }
    }
    if (D.acaoKp !== "INSERIR" && D.acaoKp !== "ATUALIZAR") return;

    var gab = gabaritoKp(D.kp.sku, nunota);
    if (gab === null) {
        throw "sem linha de KP do SKU " + D.kp.sku + " (sem desconto) em outro " +
              "pedido " + CODTIPOPER_ESPERADO + " para copiar os campos fiscais. " +
              "Insira um KP dessa faixa a mao uma vez e repita.";
    }
    if (!perto(gab.vlrunit, D.kp.vl)) {
        throw "gabarito " + gab.origem + " tem VLRUNIT " + f2(gab.vlrunit) +
              " mas a tabela diz " + f2(D.kp.vl) + ". Nao copio fiscais de linha " +
              "com valor diferente - a base de calculo nao serviria.";
    }

    var seq = proximaSequencia(nunota);
    var c = dao.create()
               .set("NUNOTA",      bd(nunota))
               .set("SEQUENCIA",   bd(seq))
               .set("CODPROD",     bd(D.kp.sku))
               .set("QTDNEG",      bd("1"))
               .set("QTDENTREGUE", bd("0"))
               .set("VLRUNIT",     bd(f2(D.kp.vl)))
               .set("VLRTOT",      bd(f2(D.kp.vl)))
               .set("VLRDESC",     bd("0"))
               .set("PERCDESC",    bd("0"))
               .set("CODUSU",      getUsuarioLogado());
    var copiados = 0;
    for (var i = 0; i < CAMPOS_KP.length; i++) {
        var k = CAMPOS_KP[i], v = gab.campos[k];
        if (v === null || v === undefined) continue;
        try { c = c.set(k, v); copiados++; }
        catch (e) { avisos.push("campo " + k + " nao copiado: " + e); }
    }
    // ciclo de vida vem do proprio pedido, nao do gabarito faturado
    var ciclo = cicloDoPedido(D, nunota), doCiclo = [];
    for (var j = 0; j < CAMPOS_CICLO.length; j++) {
        var ck = CAMPOS_CICLO[j], cv = ciclo[ck];
        if (cv === null || cv === undefined) continue;
        try { c = c.set(ck, cv); doCiclo.push(ck + "=" + String(cv)); }
        catch (e) { avisos.push("campo " + ck + " nao aplicado: " + e); }
    }
    c.save();
    feitos.push("KP inserido: seq " + seq + " prod " + D.kp.sku + " (" + D.kp.nome +
                ") a " + f2(D.kp.vl) + " | gabarito " + gab.origem + " | " +
                copiados + " fiscais copiados | QTDENTREGUE=0" +
                (doCiclo.length > 0 ? " | ciclo do pedido: " + doCiclo.join(" ") : ""));
}

function gravarCabecalho(cab, D, nunota) {
    var reg = linhas[0], ts = tsHoje();
    reg.setCampo("DTNEG",      ts);
    reg.setCampo("DTMOV",      ts);
    reg.setCampo("CODCENCUS",  bd(CODCENCUS_ALVO));
    reg.setCampo("OBSERVACAO", String(nunota));
    reg.setCampo("VLRDESCTOT", bd("0"));
    reg.setCampo("PERCDESC",   bd("0"));
    reg.setCampo("QTDVOL",     bd(D.qtdVol));
    if (D.vlrnotaAlvo !== null && (GRAVAR_ITENS || GRAVAR_KP)) {
        reg.setCampo("VLRNOTA", bd(f2(D.vlrnotaAlvo)));
    }
    // agregado do rodape: nada recalcula, entao tem de ser gravado
    if (GRAVAR_DESCTOTITEM && (GRAVAR_ITENS || GRAVAR_KP) && D.descItemAlvo !== null) {
        if (cab.DESCITEM_OK)    reg.setCampo(CAMPO_DESCITEM, bd(f2(D.descItemAlvo)));
        if (cab.DESCITEMMOE_OK) reg.setCampo(CAMPO_DESCITEM_MOE, bd(f2(D.descItemAlvo)));
    }
    var podeObs = cab.OBSINT_OK &&
                  !(PRESERVAR_OBS_INTERNA && String(cab.OBSINT) !== "null" &&
                    String(cab.OBSINT) !== "");
    if (podeObs) reg.setCampo(CAMPO_OBS_INTERNA, D.obsInterna);
    // frete zero -> Extra nota; frete > 0 -> Incluso (se confirmado)
    if (cab.VLRFRETE === 0 && TIPFRETE_EXTRANOTA !== null) {
        reg.setCampo("TIPFRETE", TIPFRETE_EXTRANOTA);
    } else if (cab.VLRFRETE !== 0 && TIPFRETE_INCLUSO !== null) {
        reg.setCampo("TIPFRETE", TIPFRETE_INCLUSO);
    }
    reg.save();
    feitos.push("cabecalho: datas, centro, observacao, descontos zerados, volumes " +
                D.qtdVol + (podeObs ? ", obs. interna" : ", obs. interna PRESERVADA") +
                (D.vlrnotaAlvo !== null && (GRAVAR_ITENS || GRAVAR_KP)
                 ? ", VLRNOTA " + f2(D.vlrnotaAlvo) : "") +
                (GRAVAR_DESCTOTITEM && cab.DESCITEM_OK && D.descItemAlvo !== null &&
                 (GRAVAR_ITENS || GRAVAR_KP)
                 ? ", desc. total por item " + f2(D.descItemAlvo) : ""));
}


// ---------- verificacao (throw = rollback, comprovado) ----------

function verificar(D, nunota) {
    var f = [], it2 = lerItens(nunota), c2 = lerCabecalho(nunota);

    if (GRAVAR_ITENS) {
        for (var y = 0; y < D.novos.length; y++) {
            var esp = D.novos[y], ach = null;
            for (var z = 0; z < it2.length; z++) {
                if (it2[z].sequencia === esp.sequencia) { ach = it2[z]; break; }
            }
            if (ach === null) { f.push("seq " + esp.sequencia + " desapareceu"); continue; }
            if (!perto(ach.vlrunit, esp.unitNovo))   f.push("seq " + esp.sequencia + " VLRUNIT " + f2(ach.vlrunit));
            if (!perto(ach.vlrtot, esp.der.vlrtot))  f.push("seq " + esp.sequencia + " VLRTOT " + f2(ach.vlrtot));
            if (!perto(ach.vlrdesc, esp.der.vlrdesc)) f.push("seq " + esp.sequencia + " VLRDESC " + f2(ach.vlrdesc) + " esperado " + f2(esp.der.vlrdesc));
            if (!perto(ach.vlripi, esp.der.vlripi))  f.push("seq " + esp.sequencia + " VLRIPI " + f2(ach.vlripi));
            if (!perto(ach.baseicms, esp.der.baseicms)) f.push("seq " + esp.sequencia + " BASEICMS " + f2(ach.baseicms));
            if (!perto(ach.vlricms, esp.der.vlricms))   f.push("seq " + esp.sequencia + " VLRICMS " + f2(ach.vlricms));
        }
        rel.push("  itens conferidos: " + D.novos.length);
    }

    if (GRAVAR_KP) {
        var q = 0, vk = 0;
        for (var k = 0; k < it2.length; k++) {
            if (isKp(it2[k].codprod)) { q++; vk = it2[k].vlrunit; }
        }
        var esperado = D.kp ? 1 : 0;
        if (q !== esperado) f.push("linhas de KP: " + q + ", esperado " + esperado);
        else if (D.kp && !perto(vk, D.kp.vl)) f.push("KP com valor " + f2(vk));
        else rel.push("  KP: " + q + " linha(s)" + (D.kp ? " a " + f2(vk) : ""));
    }

    if (GRAVAR_CABECALHO) {
        if (c2.CODCENCUS !== CODCENCUS_ALVO) f.push("CODCENCUS " + c2.CODCENCUS);
        if (c2.QTDVOL !== D.qtdVol) f.push("QTDVOL " + c2.QTDVOL);
        rel.push("  cabecalho conferido");
    }

    // fechamento: os itens gravados devem reproduzir a VENDA (sem frete), e o
    // VLRNOTA deve ser a venda MAIS o frete.
    // BUG CORRIGIDO: antes eu somava o frete aos itens e comparava contra a
    // venda, que nao inclui frete - todo pedido com frete reprovava pela
    // diferenca exata do frete (visto no 202543: 29,90 + 10,83 = 40,73).
    if (GRAVAR_ITENS || GRAVAR_KP) {
        var s = 0;
        for (var i = 0; i < it2.length; i++) {
            s += it2[i].vlrtot + it2[i].vlripi - it2[i].vlrdesc;
        }
        s = round2(s);
        rel.push("  soma dos itens: " + f2(s) + "   (venda alvo " + f2(D.totalVenda) + ")");
        rel.push("  frete: " + f2(c2.VLRFRETE) + "   VLRNOTA: " + f2(c2.VLRNOTA) +
                 "   (alvo " + f2(round2(D.totalVenda + c2.VLRFRETE)) + ")");
        // fechamento EXATO: com o desconto de arredondamento nao ha motivo para
        // sobrar centavo. Tolerancia de 1,1 centavo aqui deixaria passar erro.
        if (Math.abs(s - D.totalVenda) >= 0.005) {
            f.push("soma dos itens " + f2(s) + " != venda " + f2(D.totalVenda) +
                   " (diferenca de " + f2(s - D.totalVenda) + ")");
        }
        if (GRAVAR_CABECALHO && GRAVAR_DESCTOTITEM && c2.DESCITEM_OK &&
            D.descItemAlvo !== null) {
            if (Math.abs(c2.DESCITEM - D.descItemAlvo) >= 0.005) {
                f.push(CAMPO_DESCITEM + " " + f2(c2.DESCITEM) + " != soma dos " +
                       "descontos dos itens " + f2(D.descItemAlvo));
            } else {
                rel.push("  desc. total por item: " + f2(c2.DESCITEM) + " (ok)");
            }
        }
        if (GRAVAR_CABECALHO) {
            var alvoNota = round2(D.totalVenda + c2.VLRFRETE);
            if (Math.abs(c2.VLRNOTA - alvoNota) >= 0.005) {
                f.push("VLRNOTA " + f2(c2.VLRNOTA) + " != venda + frete " + f2(alvoNota));
            }
        }
    }
    return f;
}


// ---------- main ----------

function main() {
    if (linhas.length !== 1) {
        throw "Selecione exatamente UM pedido (selecionados: " + linhas.length + ").";
    }
    var nunota = String(linhas[0].getCampo("NUNOTA"));

    rel.push("NORMALIZADOR DE PEDIDO DE MARKETPLACE - v5");
    rel.push("MODO: " + (SIMULACAO ? "SIMULACAO (nada sera gravado)" : "*** GRAVACAO ***"));
    if (!SIMULACAO) {
        rel.push("Chaves: CABECALHO=" + GRAVAR_CABECALHO + " ITENS=" + GRAVAR_ITENS +
                 " KP=" + GRAVAR_KP);
    }
    rel.push("Pix: " + (PIX_HABILITADO ? "ATIVA" : "DESLIGADA"));
    rel.push("Pedido: " + nunota + "   |   " + new Date());

    var cab = lerCabecalho(nunota);
    var itens = lerItens(nunota);
    if (itens.length === 0) erros.push("Pedido sem itens.");
    validar(cab, itens);

    var D = (erros.length === 0) ? calcular(cab, itens) : null;

    if (erros.length > 0) {
        box("PEDIDO RECUSADO - NADA SERA ALTERADO");
        for (var x = 0; x < erros.length; x++) rel.push("  X " + erros[x]);
        if (D !== null) {
            rel.push("");
            rel.push("Corrija pela TELA do Sankhya (digitar e salvar pela interface");
            rel.push("faz o motor recalcular) ou trate este pedido a mao.");
        }
        throw rel.join("\n");
    }

    relatorio(cab, D, nunota);

    if (SIMULACAO) {
        box("FIM");
        rel.push("SIMULACAO: nada foi gravado.");
        throw rel.join("\n");
    }

    box("GRAVACAO");
    try {
        if (GRAVAR_ITENS)     gravarItens(D, nunota);     else rel.push("  (ITENS off)");
        if (GRAVAR_KP)        gravarKp(D, nunota);        else rel.push("  (KP off)");
        if (GRAVAR_CABECALHO) gravarCabecalho(cab, D, nunota); else rel.push("  (CAB off)");
    } catch (e) {
        throw rel.join("\n") + "\n\n  FALHA: " + e + "\n  throw = ROLLBACK, nada mantido.";
    }
    for (var i = 0; i < feitos.length; i++) rel.push("  > " + feitos[i]);
    if (feitos.length === 0) rel.push("  (nenhuma chave ligada)");

    box("VERIFICACAO");
    var falhas = verificar(D, nunota);
    if (falhas.length > 0) {
        rel.push("");
        rel.push("  *** REPROVOU - DESFAZENDO (throw = rollback) ***");
        for (var fa = 0; fa < falhas.length; fa++) rel.push("  X " + falhas[fa]);
        throw rel.join("\n");
    }
    rel.push("  tudo conforme.");

    var msg = "Pedido " + nunota + " normalizado.\n" +
              "Venda " + f2(D.totalVenda) + " | KP " +
              (D.kp ? D.kp.nome + " " + f2(D.kp.vl) : "nenhum") + "\n" +
              feitos.length + " alteracao(oes) aplicada(s) e conferida(s).";
    if (avisos.length > 0) msg = msg + "\n\nAvisos:\n- " + avisos.join("\n- ");
    retornaMensagem(msg);
}

main();
