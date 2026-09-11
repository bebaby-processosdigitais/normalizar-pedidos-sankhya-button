// ============================================================
//  NORMALIZADOR DE PEDIDO DE MARKETPLACE - v6
//  Acao de tabela sobre TGFCAB · botao NORMALIZAR PEDIDO
//
//  ============ O QUE MUDOU DA v5 ============
//  A v5 REPLICAVA o motor fiscal: calculava BASEIPI, VLRIPI,
//  BASEICMS e VLRICMS por conta propria, com auto-calibracao
//  para descobrir qual regime de ICMS valia em cada item.
//
//  Descobriu-se depois que o motor E alcancavel por script:
//    br.com.sankhya.modelcore.comercial.impostos.ImpostosHelpper
//      .setForcarRecalculo(true)
//      .calcularImpostos(nunota)
//
//  Provado no 202443: gravando VLRUNIT/VLRTOT = 100,00 pelo Jape
//  e chamando o recalculo, o Sankhya produziu BASEIPI 100,00,
//  VLRIPI 6,50, BASEICMS -154,40 e VLRICMS -27,79 - exatamente a
//  formula, inclusive nos negativos (o desconto de 260,90 seguia
//  intacto no teste). O VLRNOTA tambem recalcula junto.
//
//  E o ImpostosHelpper RESPEITA A TRANSACAO: apos o throw, o
//  pedido voltou integralmente ao estado anterior.
//
//  RESULTADO: este script grava APENAS VALORES -
//  VLRUNIT, VLRTOT, VLRDESC, PERCDESC - e o ERP calcula o fiscal.
//  Saiu a auto-calibracao, saiu o calculo de bases e impostos,
//  saiu a gravacao do VLRNOTA, saiu a ressalva de arquitetura
//  sobre replicar o motor fiscal.
//
//  O que o script ainda decide (regra da casa, nao do ERP):
//    - reconstrucao do preco de venda do canal
//    - desconto Pix por canal (Shopee absorve, ML so zera)
//    - faixa de KP e idempotencia
//    - desconto de 1 centavo por arredondamento
//    - campos de cabecalho
//
//  Motor Rhino: ES5, tudo em funcoes (o topo tem limite de offset
//  de 16 bits). NAO nomear nada como 'contexto'.
// ============================================================

// ---------- configuracao ----------

var SIMULACAO        = true;
var GRAVAR_CABECALHO = false;
var GRAVAR_ITENS     = false;
var GRAVAR_KP        = false;

// Recalculo fiscal pelo motor do Sankhya. So faz sentido com
// GRAVAR_ITENS ou GRAVAR_KP ligados.
var RECALCULAR_IMPOSTOS = true;

// Refaz o desdobramento financeiro via CACSP. Resolve o bug do
// "Vlr. do desdobramento" que trava a confirmacao, MAS ainda nao
// foi testado se respeita a transacao do script. Ligar so depois
// de validar isolado em pedido de teste.
var GRAVAR_FINANCEIRO = false;

// ---- Pix, por canal de marketplace ----
var PIX_HABILITADO      = true;
var CAMPO_CANAL         = "AD_CANAL_MKTPLACE";
var CANAL_ABSORVE_PIX   = "SHOPEE";
var CANAL_SO_ZERA       = "MERCADO_LIVRE";
var RECUSAR_CANAL_DESCONHECIDO = true;

var CODCENCUS_ALVO      = 20000000;
var CODTIPOPER_ESPERADO = 1755;
var CAMPO_OBS_INTERNA   = "AD_INTERNAOBS";
var CAMPO_NOME_USUARIO  = "NOMEUSU";
var PRESERVAR_OBS_INTERNA = true;
var CAMPO_DESCITEM      = "VLRDESCTOTITEM";
var CAMPO_DESCITEM_MOE  = "VLRDESCTOTITEMMOE";
var TIPFRETE_EXTRANOTA  = "N";     // confirmado na tela
var TIPFRETE_INCLUSO    = null;    // "S" apos confirmar na tela
var SCH                 = "";
var TOL                 = 0.011;
var DESC_TOTAL_LINHA    = true;

var CLS_IMPOSTOS = "br.com.sankhya.modelcore.comercial.impostos.ImpostosHelpper";

var KP_TABLE = [
  { sku: 2310, nome: 'KP1',  vl:  29.90, min:   74.75, max:  200.00 },
  { sku: 2311, nome: 'KP3',  vl:  89.70, min:  200.00, max:  448.50 },
  { sku: 2312, nome: 'KP6',  vl: 179.40, min:  448.50, max:  897.00 },
  { sku: 2313, nome: 'KP9',  vl: 269.10, min:  897.00, max: 1345.50 },
  { sku: 2314, nome: 'KP12', vl: 358.80, min: 1345.50, max: 1794.00 },
  { sku: 2315, nome: 'KP18', vl: 538.20, min: 1794.00, max: 2691.00 },
  { sku: 2316, nome: 'KP24', vl: 717.60, min: 2691.00, max: 3588.00 }
];

// Campos copiados da linha de KP gabarito. Com o recalculo pelo
// motor, os fiscais nem seriam necessarios - mas manter a copia
// garante que a linha nasca completa caso o recalculo nao cubra
// algum campo do cadastro do produto.
// NAO inclui ciclo de vida: o gabarito vem de pedido ja faturado,
// onde QTDENTREGUE=1 e PENDENTE='N' tornariam a linha inexcluivel.
var CAMPOS_KP = ["CODEMP", "CODLOCALORIG", "USOPROD", "CODCFO", "CODVOL",
                 "CODTRIB", "ATUALESTOQUE", "RESERVA", "FATURAR",
                 "CSTIPI", "CODBENEFNAUF", "CODSIT08EFD", "GERAPRODUCAO",
                 "ORIGPROD", "ATUALESTTERC", "TERCEIROS", "SOLCOMPRA",
                 "STATUSLOTE", "NUTAB", "PRODUTONFE", "INDDEVOLUCAONFCOM",
                 "CODVEND", "ALIQIPI", "ALIQICMS", "CODENQIPI", "BASICMMOD",
                 "ALIQICMSRED", "CODANTECIPST"];
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
function exato(a, b) { return Math.abs(Number(a) - Number(b)) < 0.005; }

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

// As globais 'mensagem' e 'mensagemErro' chegam NULL: sao variaveis
// lidas pelo motor APOS o script, nao objetos. NUNCA lanca.
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

    c.OBSINT_OK = false;
    try { c.OBSINT = String(vo.asString(CAMPO_OBS_INTERNA)); c.OBSINT_OK = true; }
    catch (e) { c.OBSINT = "(ilegivel)"; }

    c.CANAL_OK = false;
    try { c.CANAL = String(vo.asString(CAMPO_CANAL)); c.CANAL_OK = true; }
    catch (e) { c.CANAL = null; }
    if (c.CANAL === null || c.CANAL === "null") c.CANAL = "";

    c.DESCITEM_OK = false;
    try { c.DESCITEM = Number(vo.asBigDecimalOrZero(CAMPO_DESCITEM)); c.DESCITEM_OK = true; }
    catch (e) { c.DESCITEM = null; }
    c.DESCITEMMOE_OK = false;
    try { c.DESCITEMMOE = Number(vo.asBigDecimalOrZero(CAMPO_DESCITEM_MOE));
          c.DESCITEMMOE_OK = true; }
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

function lerFinanceiro(nunota) {
    var out = [], q = getQuery();
    try {
        q.nativeSelect("SELECT NUFIN, VLRDESDOB FROM " + SCH + "TGFFIN" +
                       " WHERE NUNOTA = " + nunota + " ORDER BY NUFIN");
        while (q.next()) {
            out.push({ nufin: String(q.getBigDecimal("NUFIN")),
                       vlr: Number(q.getBigDecimal("VLRDESDOB")) });
        }
    } catch (e) { }
    return out;
}

function somaFinanceiro(lista) {
    var s = 0;
    for (var i = 0; i < lista.length; i++) s += lista[i].vlr;
    return round2(s);
}


// ---------- guarda de consistencia ----------

// Item alterado sem recalculo tem VLRTOT fora de VLRUNIT x QTDNEG.
// Calcular sobre esse estado daria venda errada (visto no 202443
// apos gravacao parcial: a venda caiu de 139,00 para 109,10).
function validarConsistencia(itens) {
    var ruins = [];
    for (var i = 0; i < itens.length; i++) {
        var it = itens[i];
        var esp = round2(it.vlrunit * (it.qtdneg || 1));
        if (!perto(it.vlrtot, esp)) {
            ruins.push("seq " + it.sequencia + " (prod " + it.codprod + "): VLRTOT " +
                       f2(it.vlrtot) + " mas VLRUNIT x QTDNEG = " + f2(esp));
        }
    }
    if (ruins.length > 0) {
        erros.push("PEDIDO INCONSISTENTE - item alterado sem recalculo:");
        for (var r = 0; r < ruins.length; r++) erros.push("   " + ruins[r]);
        erros.push("Corrija pela TELA (digitar e salvar faz o motor recalcular) " +
                   "e rode o botao de novo.");
    }
}


// ---------- regra de Pix por canal ----------

function decidirPix(cab) {
    var temDesc = (cab.VLRDESCTOT !== 0 || cab.PERCDESC !== 0);

    if (!PIX_HABILITADO) {
        if (temDesc) {
            return { pix: 0, origem: "regra DESLIGADA",
                     erro: "Pedido tem desconto no rodape (Vlr " + f2(cab.VLRDESCTOT) +
                           " / Perc " + f2(cab.PERCDESC) + ") e PIX_HABILITADO = false. " +
                           "Tratar a mao." };
        }
        return { pix: 0, origem: "regra desligada; sem desconto no rodape", erro: null };
    }
    if (!temDesc) {
        return { pix: 0, origem: "sem desconto no rodape (canal " +
                 (cab.CANAL === "" ? "-" : cab.CANAL) + ")", erro: null };
    }
    if (cab.CANAL === CANAL_ABSORVE_PIX) {
        return { pix: (cab.VLRDESCTOT !== 0 ? round2(cab.VLRDESCTOT) : null),
                 origem: CANAL_ABSORVE_PIX + ": Pix entra na base", erro: null };
    }
    if (cab.CANAL === CANAL_SO_ZERA) {
        return { pix: 0, origem: CANAL_SO_ZERA + ": desconto apenas zerado, nao " +
                 "absorvido (valor do pedido sobe " + f2(cab.VLRDESCTOT) + ")",
                 erro: null };
    }
    if (RECUSAR_CANAL_DESCONHECIDO) {
        return { pix: 0, origem: "canal NAO RECONHECIDO",
                 erro: "Canal '" + (cab.CANAL === "" ? "(vazio)" : cab.CANAL) +
                       "' nao reconhecido e o pedido tem desconto no rodape (Vlr " +
                       f2(cab.VLRDESCTOT) + "). A regra de Pix so esta definida para " +
                       CANAL_ABSORVE_PIX + " e " + CANAL_SO_ZERA + ". Tratar a mao." };
    }
    return { pix: 0, origem: "canal nao reconhecido; desconto apenas zerado", erro: null };
}


// ---------- calculo ----------

function faixaKp(total) {
    for (var k = 0; k < KP_TABLE.length; k++) {
        if (total >= KP_TABLE[k].min && total < KP_TABLE[k].max) return KP_TABLE[k];
    }
    var u = KP_TABLE[KP_TABLE.length - 1];
    return (total >= u.max) ? u : null;
}

// Decide VLRUNIT e o desconto de arredondamento para um alvo bruto.
// O IPI so e usado para DECIDIR o valor - nao e gravado. O motor
// calcula o IPI de verdade; a verificacao confere se bateu.
function derivarValor(alvoLinha, qtd, aliqipi) {
    var f = fIpi(aliqipi);
    var unit = round2((alvoLinha / f) / qtd);
    for (var t = 0; t < 4; t++) {
        var vlrtot = round2(unit * qtd);
        var ipiEsp = round2(vlrtot * aliqipi / 100);
        var bruto  = round2(vlrtot + ipiEsp);
        var resid  = round2(bruto - alvoLinha);
        if (resid < -0.0001) { unit = round2(unit + 0.01); continue; }
        return { unit: unit, vlrtot: vlrtot, vlrdesc: resid, alvo: alvoLinha,
                 ipiEsperado: ipiEsp, fecha: round2(bruto - resid),
                 percdesc: (vlrtot > 0 && resid > 0) ? round2(resid / vlrtot * 100) : 0 };
    }
    return null;
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

    // venda reconstruida: VLRUNIT*(1+IPI) - desconto_unitario
    var soma = 0;
    for (var j = 0; j < D.produtos.length; j++) {
        var it = D.produtos[j], qtd = it.qtdneg || 1;
        var du = DESC_TOTAL_LINHA ? (it.vlrdesc / qtd) : it.vlrdesc;
        it._qtd = qtd;
        it._vendaUnit  = round2(it.vlrunit * fIpi(it.aliqipi) - du);
        it._vendaLinha = round2(it._vendaUnit * qtd);
        if (it._vendaUnit <= 0) {
            erros.push("Item seq " + it.sequencia + ": venda reconstruida em " +
                       f2(it._vendaUnit) + ". Desconto maior que o preco.");
        }
        soma += it._vendaLinha;
    }
    D.somaProdutos = round2(soma);

    // IDEMPOTENCIA: devolve o KP existente a base. A faixa e decidida pelo
    // TOTAL da venda, nao pelos produtos apos a extracao (7 de 7 pedidos ja
    // normalizados confirmam; a base "produtos apenas" erraria 2 deles).
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

    // Pix
    var dpix = decidirPix(cab);
    D.pix = dpix.pix;
    if (D.pix === null) {
        D.pix = round2(D.totalVenda * cab.PERCDESC / 100);
        dpix.origem = dpix.origem + " (percentual " + f2(cab.PERCDESC) + "%)";
    }
    D.pixOrigem = dpix.origem;

    D.kp = faixaKp(D.totalVenda);
    if (D.kp === null && D.totalVenda < KP_TABLE[0].min) {
        avisos.push("Total " + f2(D.totalVenda) + " abaixo do piso de KP. Sem KP.");
    }
    var kpVl = D.kp ? D.kp.vl : 0;

    D.brutoAlvo = round2(D.totalVenda - D.pix);
    var alvoTotal = round2(D.brutoAlvo - kpVl);

    // alvo por linha, com a sobra da distribuicao na maior
    var alvos = [], somaAlvos = 0;
    for (var n = 0; n < D.produtos.length; n++) {
        var q0 = D.produtos[n];
        var prop = D.totalVenda > 0 ? (q0._vendaLinha / D.totalVenda)
                                    : (1 / D.produtos.length);
        var a = round2(q0._vendaLinha - (kpVl + D.pix) * prop);
        alvos.push(a); somaAlvos += a;
    }
    var sobra = round2(alvoTotal - round2(somaAlvos));
    if (sobra !== 0 && alvos.length > 0) {
        var maior = 0;
        for (var mm = 1; mm < alvos.length; mm++) if (alvos[mm] > alvos[maior]) maior = mm;
        alvos[maior] = round2(alvos[maior] + sobra);
    }

    D.novos = [];
    for (var n2 = 0; n2 < D.produtos.length; n2++) {
        var q = D.produtos[n2];
        var der = derivarValor(alvos[n2], q._qtd, q.aliqipi);
        if (der === null) {
            erros.push("Item seq " + q.sequencia + ": nao consegui fechar o alvo de " +
                       f2(alvos[n2]) + " com 2 decimais.");
        } else {
            var maxResid = round2(0.01 * q._qtd + 0.01);
            if (der.vlrdesc > maxResid) {
                avisos.push("Item seq " + q.sequencia + ": desconto de arredondamento " +
                            f2(der.vlrdesc) + " acima do esperado (" + f2(maxResid) + ").");
            }
        }
        D.novos.push({ sequencia: q.sequencia, codprod: q.codprod, qtdneg: q._qtd,
                       aliqipi: q.aliqipi, atual: q, der: der, alvo: alvos[n2] });
    }

    if (D.kp && D.kpExist.length === 0)      D.acaoKp = "INSERIR";
    else if (D.kp && D.kpExist.length >= 1)  D.acaoKp = "ATUALIZAR";
    else if (!D.kp && D.kpExist.length >= 1) D.acaoKp = "REMOVER";
    else                                      D.acaoKp = "NENHUMA";

    D.qtdVol = 0;
    for (var v = 0; v < D.produtos.length; v++) D.qtdVol += D.produtos[v]._qtd;
    D.obsInterna = nomeUsuario() + " - " + ddmm();

    var sd = 0, sdOk = true;
    for (var y = 0; y < D.novos.length; y++) {
        if (D.novos[y].der === null) { sdOk = false; break; }
        sd += D.novos[y].der.vlrdesc;
    }
    D.descItemAlvo = sdOk ? round2(sd) : null;
    D.vlrnotaAlvo  = round2(D.brutoAlvo + cab.VLRFRETE);
    return D;
}


// ---------- validacao ----------

function validar(cab) {
    if (cab.CODTIPOPER !== CODTIPOPER_ESPERADO) {
        erros.push("TOP " + cab.CODTIPOPER + ", esperado " + CODTIPOPER_ESPERADO + ".");
    }
    var dp = decidirPix(cab);
    if (dp.erro !== null) erros.push(dp.erro);
    if (RECALCULAR_IMPOSTOS) {
        try { java.lang.Class.forName(CLS_IMPOSTOS); }
        catch (e) {
            erros.push("RECALCULAR_IMPOSTOS ligado mas a classe " + CLS_IMPOSTOS +
                       " nao existe neste ambiente.");
        }
    }
}


// ---------- relatorio ----------

function relatorio(cab, D, nunota, fin) {
    box("SITUACAO ATUAL");
    rel.push("  TOP / negociacao .. " + cab.CODTIPOPER + " / " + cab.CODTIPVENDA);
    rel.push("  Canal ............. " + (cab.CANAL === "" ? "(vazio)" : cab.CANAL));
    rel.push("  Vlr. Nota ......... " + f2(cab.VLRNOTA));
    rel.push("  Centro / volumes .. " + cab.CODCENCUS + " / " + cab.QTDVOL);
    rel.push("  Obs. Interna ...... " + cab.OBSINT);
    if (fin.length > 0) {
        rel.push("  Financeiro ........ " + fin.length + " linha(s), soma " +
                 f2(somaFinanceiro(fin)));
    }

    box("VENDA RECONSTRUIDA");
    rel.push("  Soma produtos " + f2(D.somaProdutos) +
             (D.kpDevolvido > 0 ? "  + KP devolvido " + f2(D.kpDevolvido) : "") +
             "  =  TOTAL " + f2(D.totalVenda));
    rel.push("  Pix ......... " + f2(D.pix) + "   [" + D.pixOrigem + "]");
    rel.push("  KP .......... " + (D.kp ? D.kp.nome + " = " + f2(D.kp.vl) : "nenhum"));
    rel.push("  BRUTO ALVO (itens + KP): " + f2(D.brutoAlvo));

    box("ITENS - VALORES A GRAVAR");
    rel.push("  (o script grava so VALORES; BASEIPI/VLRIPI/BASEICMS/VLRICMS");
    rel.push("   sao calculados pelo motor do Sankhya apos a gravacao)");
    rel.push("");
    rel.push("  seq  prod   qtd   VLRUNIT atual ->  novo    VLRDESC ->  novo    alvo");
    for (var i = 0; i < D.novos.length; i++) {
        var n = D.novos[i], a = n.atual;
        if (n.der === null) {
            rel.push("  " + padL(n.sequencia, 3) + "  " + padL(n.codprod, 5) +
                     "   *** NAO FOI POSSIVEL DERIVAR ***");
            continue;
        }
        var mk = (a.vlrunit !== n.der.unit || a.vlrdesc !== n.der.vlrdesc) ? " *" : "  ";
        rel.push(mk + padL(n.sequencia, 3) + "  " + padL(n.codprod, 5) + "  " +
                 padL(n.qtdneg, 3) + "  " + padL(f2(a.vlrunit), 11) + " -> " +
                 padL(f2(n.der.unit), 8) + "  " + padL(f2(a.vlrdesc), 8) + " -> " +
                 padL(f2(n.der.vlrdesc), 6) + "  " + padL(f2(n.der.alvo), 9) +
                 (n.der.vlrdesc > 0 ? "  (arred.)" : ""));
        rel.push("      IPI " + f2(n.aliqipi) + "% -> o motor deve calcular " +
                 f2(n.der.ipiEsperado) + "   fecha em " + f2(n.der.fecha));
    }

    box("LINHA DE KP");
    for (var c = 0; c < D.kpExist.length; c++) {
        rel.push("  existente: seq " + D.kpExist[c].sequencia + " prod " +
                 D.kpExist[c].codprod + " a " + f2(D.kpExist[c].vlrunit));
    }
    if (D.kpExist.length === 0) rel.push("  existente: nenhuma");
    rel.push("  ACAO: " + D.acaoKp +
             (D.kp ? " -> " + D.kp.nome + " (SKU " + D.kp.sku + ") a " + f2(D.kp.vl) : ""));

    box("CABECALHO");
    rel.push("  Dt. neg / mov ..... " + cab.DTNEG + " / " + cab.DTMOV + "  ->  " + ddmm());
    rel.push("  Centro resultado .. " + cab.CODCENCUS + "  ->  " + CODCENCUS_ALVO);
    rel.push("  Observacao ........ " + cab.OBSERVACAO + "  ->  " + nunota);
    var obsAcao;
    if (!cab.OBSINT_OK) obsAcao = "(ilegivel - nao altera)";
    else if (PRESERVAR_OBS_INTERNA && String(cab.OBSINT) !== "null" &&
             String(cab.OBSINT) !== "") obsAcao = "PRESERVADA (ja preenchida)";
    else obsAcao = D.obsInterna;
    rel.push("  Obs. Interna ...... " + cab.OBSINT + "  ->  " + obsAcao);
    rel.push("  Descontos rodape .. " + f2(cab.VLRDESCTOT) + " / " + f2(cab.PERCDESC) +
             "  ->  0.00 / 0.00");
    if (cab.DESCITEM_OK) {
        rel.push("  Desc. total item .. " + f2(cab.DESCITEM) + "  ->  " +
                 (D.descItemAlvo === null ? "?" : f2(D.descItemAlvo)));
    }
    rel.push("  Qtd. volumes ...... " + cab.QTDVOL + "  ->  " + D.qtdVol);
    rel.push("  Vlr. Nota ......... " + f2(cab.VLRNOTA) + "  ->  " + f2(D.vlrnotaAlvo) +
             "   (calculado pelo MOTOR: venda " + f2(D.totalVenda) +
             (D.pix > 0 ? " - Pix " + f2(D.pix) : "") +
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

    box("O QUE SERA EXECUTADO");
    rel.push("  cabecalho ......... " + (GRAVAR_CABECALHO ? "SIM" : "nao"));
    rel.push("  itens (valores) ... " + (GRAVAR_ITENS ? "SIM" : "nao"));
    rel.push("  linha de KP ....... " + (GRAVAR_KP ? "SIM" : "nao"));
    rel.push("  recalculo fiscal .. " + (RECALCULAR_IMPOSTOS ? "SIM (ImpostosHelpper)" : "nao"));
    rel.push("  financeiro ........ " + (GRAVAR_FINANCEIRO ? "SIM (CACSP)" : "nao"));

    if (avisos.length > 0) {
        box("AVISOS");
        for (var w = 0; w < avisos.length; w++) rel.push("  ! " + avisos[w]);
    }
}


// ---------- gravacao ----------

function gravarCabecalho(cab, D, nunota) {
    var reg = linhas[0], ts = tsHoje();
    reg.setCampo("DTNEG",      ts);
    reg.setCampo("DTMOV",      ts);
    reg.setCampo("CODCENCUS",  bd(CODCENCUS_ALVO));
    reg.setCampo("OBSERVACAO", String(nunota));
    reg.setCampo("VLRDESCTOT", bd("0"));
    reg.setCampo("PERCDESC",   bd("0"));
    reg.setCampo("QTDVOL",     bd(D.qtdVol));
    if (D.descItemAlvo !== null && (GRAVAR_ITENS || GRAVAR_KP)) {
        if (cab.DESCITEM_OK)    reg.setCampo(CAMPO_DESCITEM, bd(f2(D.descItemAlvo)));
        if (cab.DESCITEMMOE_OK) reg.setCampo(CAMPO_DESCITEM_MOE, bd(f2(D.descItemAlvo)));
    }
    var podeObs = cab.OBSINT_OK &&
                  !(PRESERVAR_OBS_INTERNA && String(cab.OBSINT) !== "null" &&
                    String(cab.OBSINT) !== "");
    if (podeObs) reg.setCampo(CAMPO_OBS_INTERNA, D.obsInterna);
    if (cab.VLRFRETE === 0 && TIPFRETE_EXTRANOTA !== null) {
        reg.setCampo("TIPFRETE", TIPFRETE_EXTRANOTA);
    } else if (cab.VLRFRETE !== 0 && TIPFRETE_INCLUSO !== null) {
        reg.setCampo("TIPFRETE", TIPFRETE_INCLUSO);
    }
    reg.save();
    feitos.push("cabecalho: datas, centro " + CODCENCUS_ALVO + ", observacao, " +
                "descontos zerados, volumes " + D.qtdVol +
                (podeObs ? ", obs. interna" : ", obs. interna PRESERVADA"));
}

function gravarItens(D, nunota) {
    var dao = JF.dao("ItemNota");
    for (var g = 0; g < D.novos.length; g++) {
        var n = D.novos[g];
        if (n.der === null) throw "item seq " + n.sequencia + " sem valores derivados";
        var vo = dao.findByPK([bd(nunota), bd(n.sequencia)]);
        dao.prepareToUpdate(vo)
           .set("VLRUNIT",  bd(f2(n.der.unit)))
           .set("VLRTOT",   bd(f2(n.der.vlrtot)))
           .set("VLRDESC",  bd(f2(n.der.vlrdesc)))
           .set("PERCDESC", bd(f2(n.der.percdesc)))
           .update();
        feitos.push("item seq " + n.sequencia + ": " + f2(n.atual.vlrunit) + " -> " +
                    f2(n.der.unit) + ", desconto " + f2(n.atual.vlrdesc) + " -> " +
                    f2(n.der.vlrdesc) + (n.der.vlrdesc > 0 ? " (arred.)" : ""));
    }
}

function gabaritoKp(sku, nunota) {
    var q = getQuery();
    q.nativeSelect("SELECT * FROM (SELECT I.NUNOTA, I.SEQUENCIA FROM " + SCH +
                   "TGFITE I JOIN " + SCH + "TGFCAB C ON C.NUNOTA = I.NUNOTA" +
                   " WHERE I.CODPROD = " + sku + " AND C.CODTIPOPER = " +
                   CODTIPOPER_ESPERADO + " AND I.NUNOTA <> " + nunota +
                   " AND I.VLRDESC = 0 ORDER BY I.NUNOTA DESC) WHERE ROWNUM = 1");
    if (!q.next()) return null;
    var gnu = q.getBigDecimal("NUNOTA"), gseq = q.getBigDecimal("SEQUENCIA");
    var vo = JF.dao("ItemNota").findByPK([gnu, gseq]);
    var g = { origem: String(gnu) + "/" + String(gseq), campos: {} };
    for (var i = 0; i < CAMPOS_KP.length; i++) {
        var k = CAMPOS_KP[i];
        try { g.campos[k] = vo.getProperty(k); } catch (e) { g.campos[k] = null; }
    }
    g.vlrunit = Number(vo.asBigDecimalOrZero("VLRUNIT"));
    return g;
}

function proximaSequencia(nunota) {
    var q = getQuery();
    q.nativeSelect("SELECT NVL(MAX(SEQUENCIA),0) + 1 AS S FROM " + SCH +
                   "TGFITE WHERE NUNOTA = " + nunota);
    return q.next() ? Number(q.getBigDecimal("S")) : 1;
}

function cicloDoPedido(D, nunota) {
    var o = {};
    if (D.produtos.length === 0) return o;
    try {
        var vo = JF.dao("ItemNota").findByPK([bd(nunota), bd(D.produtos[0].sequencia)]);
        for (var i = 0; i < CAMPOS_CICLO.length; i++) {
            try { o[CAMPOS_CICLO[i]] = vo.getProperty(CAMPOS_CICLO[i]); } catch (e) { }
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
        throw "sem linha de KP do SKU " + D.kp.sku + " (sem desconto) em outro pedido " +
              CODTIPOPER_ESPERADO + " para copiar os campos do produto. " +
              "Insira um KP dessa faixa a mao uma vez e repita.";
    }
    if (!perto(gab.vlrunit, D.kp.vl)) {
        throw "gabarito " + gab.origem + " tem VLRUNIT " + f2(gab.vlrunit) +
              " mas a tabela diz " + f2(D.kp.vl) + ".";
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
    var ciclo = cicloDoPedido(D, nunota), doCiclo = [];
    for (var j = 0; j < CAMPOS_CICLO.length; j++) {
        var ck = CAMPOS_CICLO[j], cv = ciclo[ck];
        if (cv === null || cv === undefined) continue;
        try { c = c.set(ck, cv); doCiclo.push(ck + "=" + String(cv)); } catch (e) { }
    }
    c.save();
    feitos.push("KP inserido: seq " + seq + " prod " + D.kp.sku + " (" + D.kp.nome +
                ") a " + f2(D.kp.vl) + " | gabarito " + gab.origem + " | " +
                copiados + " campos copiados | QTDENTREGUE=0" +
                (doCiclo.length > 0 ? " | " + doCiclo.join(" ") : ""));
}

// Motor fiscal do Sankhya. Provado no 202443 e respeita a transacao.
function recalcularImpostos(nunota) {
    var IH = newJava(CLS_IMPOSTOS);
    IH.setForcarRecalculo(true);
    IH.calcularImpostos(linhas[0].getCampo("NUNOTA"));
    feitos.push("impostos recalculados pelo motor do Sankhya (ImpostosHelpper)");
}

// Refaz o desdobramento. AINDA NAO VALIDADO quanto a transacao.
function refazerFinanceiro(nunota) {
    var json = "{'nota':{'nunota':" + nunota + "}}";
    getQuery().update("EXEC " + SCH + "ENVIACOMANDO_JSON 'mgecom', " +
                      "'CACSP.refazerFinanceiro', '" + json + "'");
    getQuery().update("EXEC " + SCH + "ENVIACOMANDO_JSON 'mgecom', " +
                      "'CACSP.gerarFinanceiro', '" + json + "'");
    feitos.push("financeiro refeito via CACSP");
}


// ---------- verificacao ----------

function verificar(cab, D, nunota) {
    var f = [], it2 = lerItens(nunota), c2 = lerCabecalho(nunota);

    if (GRAVAR_ITENS) {
        for (var y = 0; y < D.novos.length; y++) {
            var esp = D.novos[y], ach = null;
            for (var z = 0; z < it2.length; z++) {
                if (it2[z].sequencia === esp.sequencia) { ach = it2[z]; break; }
            }
            if (ach === null) { f.push("seq " + esp.sequencia + " desapareceu"); continue; }
            if (!perto(ach.vlrunit, esp.der.unit)) {
                f.push("seq " + esp.sequencia + " VLRUNIT " + f2(ach.vlrunit) +
                       " esperado " + f2(esp.der.unit));
            }
            if (!perto(ach.vlrdesc, esp.der.vlrdesc)) {
                f.push("seq " + esp.sequencia + " VLRDESC " + f2(ach.vlrdesc) +
                       " esperado " + f2(esp.der.vlrdesc));
            }
            // o IPI que o MOTOR calculou deve bater com o que guiou o valor
            if (RECALCULAR_IMPOSTOS && !perto(ach.vlripi, esp.der.ipiEsperado)) {
                f.push("seq " + esp.sequencia + " VLRIPI do motor " + f2(ach.vlripi) +
                       " != " + f2(esp.der.ipiEsperado) + " usado no calculo do valor");
            }
        }
        rel.push("  itens conferidos: " + D.novos.length);
    }

    if (GRAVAR_KP) {
        var q = 0, vk = 0;
        for (var k = 0; k < it2.length; k++) {
            if (isKp(it2[k].codprod)) { q++; vk = it2[k].vlrunit; }
        }
        var espKp = D.kp ? 1 : 0;
        if (q !== espKp) f.push("linhas de KP: " + q + ", esperado " + espKp);
        else if (D.kp && !perto(vk, D.kp.vl)) f.push("KP com valor " + f2(vk));
        else rel.push("  KP: " + q + " linha(s)" + (D.kp ? " a " + f2(vk) : ""));
    }

    if (GRAVAR_CABECALHO) {
        if (c2.CODCENCUS !== CODCENCUS_ALVO) f.push("CODCENCUS " + c2.CODCENCUS);
        if (c2.QTDVOL !== D.qtdVol) f.push("QTDVOL " + c2.QTDVOL);
        if (!exato(c2.VLRDESCTOT, 0)) f.push("VLRDESCTOT " + f2(c2.VLRDESCTOT));
        rel.push("  cabecalho conferido");
    }

    // fechamento: soma dos itens contra o alvo, e VLRNOTA contra alvo + frete
    if (GRAVAR_ITENS || GRAVAR_KP) {
        var s = 0;
        for (var i = 0; i < it2.length; i++) {
            s += it2[i].vlrtot + it2[i].vlripi - it2[i].vlrdesc;
        }
        s = round2(s);
        rel.push("  soma dos itens: " + f2(s) + "   (alvo " + f2(D.brutoAlvo) + ")");
        rel.push("  VLRNOTA: " + f2(c2.VLRNOTA) + "   (alvo " + f2(D.vlrnotaAlvo) + ")");
        if (!exato(s, D.brutoAlvo)) {
            f.push("soma dos itens " + f2(s) + " != alvo " + f2(D.brutoAlvo) +
                   " (diferenca " + f2(s - D.brutoAlvo) + ")");
        }
        if (RECALCULAR_IMPOSTOS && !exato(c2.VLRNOTA, D.vlrnotaAlvo)) {
            f.push("VLRNOTA " + f2(c2.VLRNOTA) + " != alvo " + f2(D.vlrnotaAlvo) +
                   " (o motor recalcula o VLRNOTA; divergencia indica erro no alvo)");
        }
    }

    // financeiro: so reporta quando nao foi refeito
    var fin2 = lerFinanceiro(nunota);
    if (fin2.length > 0) {
        var sf = somaFinanceiro(fin2);
        rel.push("  financeiro: soma " + f2(sf) + " vs VLRNOTA " + f2(c2.VLRNOTA));
        if (!exato(sf, c2.VLRNOTA)) {
            if (GRAVAR_FINANCEIRO) {
                f.push("financeiro " + f2(sf) + " != VLRNOTA " + f2(c2.VLRNOTA) +
                       " mesmo apos refazer");
            } else {
                avisos.push("Financeiro em " + f2(sf) + " contra VLRNOTA " +
                            f2(c2.VLRNOTA) + ". O operador NAO vai conseguir confirmar. " +
                            "Contorno: no item, zerar o desconto e salvar, depois " +
                            "recolocar e salvar. Ou ligar GRAVAR_FINANCEIRO.");
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

    rel.push("NORMALIZADOR DE PEDIDO DE MARKETPLACE - v6");
    rel.push("MODO: " + (SIMULACAO ? "SIMULACAO (nada sera gravado)" : "*** GRAVACAO ***"));
    rel.push("Pedido: " + nunota + "   |   " + new Date());

    var cab = lerCabecalho(nunota);
    var itens = lerItens(nunota);
    var fin = lerFinanceiro(nunota);
    if (itens.length === 0) erros.push("Pedido sem itens.");
    else validarConsistencia(itens);
    validar(cab);

    var D = (erros.length === 0) ? calcular(cab, itens) : null;

    if (erros.length > 0) {
        box("PEDIDO RECUSADO - NADA SERA ALTERADO");
        for (var x = 0; x < erros.length; x++) rel.push("  X " + erros[x]);
        throw rel.join("\n");
    }

    relatorio(cab, D, nunota, fin);

    if (SIMULACAO) {
        box("FIM");
        rel.push("SIMULACAO: nada foi gravado.");
        throw rel.join("\n");
    }

    box("GRAVACAO");
    try {
        // cabecalho ANTES dos itens: o save do Registro usa o snapshot em
        // memoria e sobrescreveria o VLRNOTA que o motor calcular depois
        if (GRAVAR_CABECALHO) gravarCabecalho(cab, D, nunota); else rel.push("  (CAB off)");
        if (GRAVAR_ITENS)     gravarItens(D, nunota);          else rel.push("  (ITENS off)");
        if (GRAVAR_KP)        gravarKp(D, nunota);             else rel.push("  (KP off)");
        if (RECALCULAR_IMPOSTOS && (GRAVAR_ITENS || GRAVAR_KP)) recalcularImpostos(nunota);
        if (GRAVAR_FINANCEIRO && (GRAVAR_ITENS || GRAVAR_KP))   refazerFinanceiro(nunota);
    } catch (e) {
        throw rel.join("\n") + "\n\n  FALHA: " + e + "\n  throw = ROLLBACK.";
    }
    for (var i = 0; i < feitos.length; i++) rel.push("  > " + feitos[i]);
    if (feitos.length === 0) rel.push("  (nenhuma chave ligada)");

    box("VERIFICACAO");
    var falhas = verificar(cab, D, nunota);
    if (falhas.length > 0) {
        rel.push("");
        rel.push("  *** REPROVOU - DESFAZENDO (throw = rollback) ***");
        for (var fa = 0; fa < falhas.length; fa++) rel.push("  X " + falhas[fa]);
        throw rel.join("\n");
    }
    rel.push("  tudo conforme.");

    var msg = "Pedido " + nunota + " normalizado.\n" +
              "Venda " + f2(D.totalVenda) +
              (D.pix > 0 ? " | Pix " + f2(D.pix) : "") +
              " | KP " + (D.kp ? D.kp.nome + " " + f2(D.kp.vl) : "nenhum") +
              " | Vlr. Nota " + f2(D.vlrnotaAlvo) + "\n" +
              feitos.length + " operacao(oes) aplicada(s) e conferida(s).";
    if (avisos.length > 0) msg = msg + "\n\nAvisos:\n- " + avisos.join("\n- ");
    retornaMensagem(msg);
}

main();
