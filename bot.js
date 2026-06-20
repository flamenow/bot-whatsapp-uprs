// =====================================================
//  Bot WhatsApp — UP-RS
//  Usa Evolution API como provedor de WhatsApp
//  Funcionalidades: cota, comprovante, livros, agenda
// =====================================================

const express = require('express');
const axios   = require('axios');
const FormData = require('form-data');

const app = express();
app.use(express.json({ limit: '50mb' }));

// ===== CONFIGURAÇÃO (via variáveis de ambiente no Railway) =====
const GAS_URL      = process.env.GAS_URL      || 'https://script.google.com/macros/s/AKfycbyCv6vnlaj1zw5Jy6t2b_2RurRJ_4Bt5q80EDsrjwtvOl5ARE4JR9Iq4nNuYvVuMjgD/exec';
const EVO_URL      = process.env.EVO_URL      || ''; // Ex: https://seu-evo.railway.app
const EVO_KEY      = process.env.EVO_KEY      || ''; // API Key do Evolution API
const EVO_INSTANCE = process.env.EVO_INSTANCE || 'up-rs';
const PORT         = process.env.PORT         || 3000;

// Sessões ativas (guarda estado de cada conversa em memória)
const sessoes = new Map(); // { numero: { estado, mes } }


// =====================================================
//  DADOS
// =====================================================

async function fetchDB() {
  try {
    const resp = await axios.get(GAS_URL, { timeout: 12000 });
    return resp.data;
  } catch (e) {
    console.error('Erro ao buscar DB do GAS:', e.message);
    return null;
  }
}

function encontrarMembro(db, numero) {
  const limpo = numero.replace(/\D/g, '');
  // Testa com e sem DDI 55
  const variantes = [limpo, '55' + limpo, limpo.replace(/^55/, '')];

  const mil = (db.militantes || []).find(m => {
    const tel = (m.tel || '').replace(/\D/g, '');
    return variantes.some(v => tel === v || tel.endsWith(v) || v.endsWith(tel));
  });
  if (mil) return { tipo: 'militante', dados: mil };

  const apo = (db.apoiadores || []).find(a => {
    const tel = (a.tel || '').replace(/\D/g, '');
    return variantes.some(v => tel === v || tel.endsWith(v) || v.endsWith(tel));
  });
  if (apo) return { tipo: 'apoiador', dados: apo };

  return null;
}

function statusCota(militante) {
  const hoje   = new Date();
  const cota   = parseFloat(militante.cota) || 0;
  const pagamentos = militante.pagamentos || [];
  const mesesDevendo = [];

  // Verifica os últimos 3 meses
  for (let i = 0; i < 3; i++) {
    const d  = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!pagamentos.some(p => p.mes === ym)) mesesDevendo.push(ym);
  }

  return { cota, mesesDevendo };
}

function proximosEventos(db) {
  const hoje = new Date().toISOString().slice(0, 10);
  return (db.eventos || [])
    .filter(e => e.data >= hoje)
    .sort((a, b) => a.data.localeCompare(b.data))
    .slice(0, 5);
}

function livrosDisponiveis(db) {
  return (db.livros || []).filter(l => parseInt(l.qtd) > 0);
}


// =====================================================
//  UTILITÁRIOS
// =====================================================

function fmtData(ym) {
  if (!ym) return ym;
  const [ano, mes] = ym.split('-');
  const nomes = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  return `${nomes[parseInt(mes) - 1]}/${ano}`;
}

function parseMes(texto) {
  const cmd = texto.toLowerCase().trim();
  const mesesNomes = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];

  // AAAA-MM ou AAAA/MM
  const m1 = cmd.match(/^(\d{4})[\/\-](\d{1,2})$/);
  if (m1) return `${m1[1]}-${m1[2].padStart(2, '0')}`;

  // MM/AAAA ou MM-AAAA
  const m2 = cmd.match(/^(\d{1,2})[\/\-](\d{4})$/);
  if (m2) return `${m2[2]}-${m2[1].padStart(2, '0')}`;

  // "junho 2025" ou "jun 2025" ou "jun/2025"
  const idx = mesesNomes.findIndex(n => cmd.includes(n));
  if (idx >= 0) {
    const ano = (cmd.match(/\d{4}/) || [new Date().getFullYear()])[0];
    return `${ano}-${String(idx + 1).padStart(2, '0')}`;
  }

  return null;
}


// =====================================================
//  ENVIO DE MENSAGEM
// =====================================================

async function enviarMsg(numero, texto) {
  if (!EVO_URL || !EVO_KEY) {
    // Modo simulação (útil para testar localmente)
    console.log(`\n[→ ${numero}]\n${texto}\n`);
    return;
  }
  try {
    await axios.post(
      `${EVO_URL}/message/sendText/${EVO_INSTANCE}`,
      { number: numero, text: texto },
      { headers: { apikey: EVO_KEY } }
    );
  } catch (e) {
    console.error('Erro ao enviar mensagem:', e.message);
  }
}


// =====================================================
//  LÓGICA PRINCIPAL
// =====================================================

async function processarMensagem(numero, texto, tipoMsg, mediaBase64) {
  const db = await fetchDB();
  if (!db) {
    await enviarMsg(numero, '❌ Sistema indisponível no momento. Tente em alguns minutos.');
    return;
  }

  const membro = encontrarMembro(db, numero);
  const sessao = sessoes.get(numero) || {};
  const cmd    = (texto || '').toLowerCase().trim();

  // --------------------------------------------------
  //  ESTADO: Aguardando imagem do comprovante
  // --------------------------------------------------
  if (sessao.estado === 'aguardando_comprovante' && tipoMsg === 'imageMessage') {
    await enviarMsg(numero, '⏳ Recebi! Enviando ao sistema...');

    try {
      const mes        = sessao.mes;
      const uniqueName = `comp_${numero.replace(/\D/g, '')}_${mes}_${Date.now()}.jpg`;
      const fd = new FormData();
      fd.append('action',   'uploadFile');
      fd.append('fileName', uniqueName);
      fd.append('mimeType', 'image/jpeg');
      fd.append('fileData', mediaBase64);
      fd.append('folder',   'Comprovantes');

      await axios.post(GAS_URL, fd, { headers: fd.getHeaders(), timeout: 30000 });

      await enviarMsg(numero,
        `✅ Comprovante enviado!\n\n` +
        `Mês: *${fmtData(mes)}*\n` +
        `A direção vai confirmar o pagamento em breve. Obrigado! 🙏`
      );
    } catch (e) {
      console.error('Erro no upload:', e.message);
      await enviarMsg(numero, '⚠️ Erro ao enviar o arquivo. Tente novamente ou entre em contato com o núcleo.');
    }

    sessoes.delete(numero);
    return;
  }

  // --------------------------------------------------
  //  ESTADO: Aguardando mês antes de receber comprovante
  // --------------------------------------------------
  if (sessao.estado === 'aguardando_mes') {
    const mes = parseMes(cmd);
    if (!mes) {
      const hoje = new Date();
      const ex   = `${String(hoje.getMonth() + 1).padStart(2, '0')}/${hoje.getFullYear()}`;
      await enviarMsg(numero, `❓ Não entendi o mês. Manda assim: *${ex}*`);
      return;
    }

    sessoes.set(numero, { estado: 'aguardando_comprovante', mes });
    await enviarMsg(numero, `📎 Agora me manda a *foto do comprovante* referente a *${fmtData(mes)}*.`);
    return;
  }

  // --------------------------------------------------
  //  COMANDOS
  // --------------------------------------------------

  // COTA
  if (['cota', 'cotas', 'pagamento', 'paguei'].includes(cmd)) {
    if (!membro || membro.tipo !== 'militante') {
      await enviarMsg(numero, '❓ Não encontrei seu cadastro no sistema.\nFala com a direção do seu núcleo.');
      return;
    }

    const { cota, mesesDevendo } = statusCota(membro.dados);
    const nome = membro.dados.nome.split(' ')[0];

    if (mesesDevendo.length === 0) {
      await enviarMsg(numero,
        `✅ Olá, *${nome}*! Suas cotas estão em dia. 🎉\n\n` +
        `Cota mensal: R$ ${cota},00\n\n` +
        `Obrigado pelo comprometimento!`
      );
    } else {
      const lista  = mesesDevendo.map(m => `  • ${fmtData(m)} — R$ ${cota},00`).join('\n');
      const total  = cota * mesesDevendo.length;
      await enviarMsg(numero,
        `⚠️ Olá, *${nome}*! Cotas pendentes:\n\n${lista}\n\n` +
        `Total: R$ ${total},00\n\n` +
        `Para enviar um comprovante, manda *comprovante* aqui.`
      );
    }
    return;
  }

  // COMPROVANTE
  if (['comprovante', 'comp', 'pagar'].includes(cmd)) {
    if (!membro || membro.tipo !== 'militante') {
      await enviarMsg(numero, '❓ Não encontrei seu cadastro. Fala com o núcleo.');
      return;
    }

    sessoes.set(numero, { estado: 'aguardando_mes' });
    const hoje = new Date();
    const ex   = `${String(hoje.getMonth() + 1).padStart(2, '0')}/${hoje.getFullYear()}`;
    await enviarMsg(numero, `📅 Qual mês é o comprovante?\n\nEx: *${ex}*`);
    return;
  }

  // LIVROS
  if (['livros', 'livro', 'loja', 'comprar'].includes(cmd)) {
    const livros = livrosDisponiveis(db);
    if (livros.length === 0) {
      await enviarMsg(numero, '📚 Não há livros disponíveis no momento.');
      return;
    }

    const lista = livros.map((l, i) => {
      const preco = l.val2
        ? `R$ ${l.val2} (militante) / R$ ${l.val} (externo)`
        : `R$ ${l.val}`;
      return `*${i + 1}. ${l.titulo}*\n   ${l.autor || ''}\n   ${preco} · Estoque: ${l.qtd} un.`;
    }).join('\n\n');

    await enviarMsg(numero, `📚 *Livros disponíveis:*\n\n${lista}\n\nPara solicitar, fala com a banca.`);
    return;
  }

  // AGENDA / CALENDÁRIO
  if (['agenda', 'calendario', 'calendário', 'eventos', 'evento'].includes(cmd)) {
    const eventos = proximosEventos(db);
    if (eventos.length === 0) {
      await enviarMsg(numero, '📅 Nenhum evento agendado para os próximos dias.');
      return;
    }

    const emojiTipo = { reuniao: '🟢', 'brigada-nacional': '⚫', 'brigada-operaria': '🟠', ato: '🟣' };
    const lista = eventos.map(e => {
      const emoji    = emojiTipo[e.tipo] || '📌';
      const [a, m, d] = e.data.split('-');
      return (
        `${emoji} *${e.titulo}*\n` +
        `   📆 ${d}/${m}/${a}${e.hora ? ' às ' + e.hora : ''}\n` +
        `   📍 ${e.local || 'Local a confirmar'}`
      );
    }).join('\n\n');

    await enviarMsg(numero, `📅 *Próximos eventos:*\n\n${lista}`);
    return;
  }

  // MENU (qualquer outra mensagem)
  const saudacao = membro ? `Olá, *${membro.dados.nome.split(' ')[0]}*! ` : 'Olá! ';
  await enviarMsg(numero,
    `${saudacao}Sou o bot da *UP-RS* 🤖\n\n` +
    `Digite uma opção:\n\n` +
    `💰 *cota* — ver status das suas cotas\n` +
    `📎 *comprovante* — enviar comprovante de pagamento\n` +
    `📚 *livros* — ver livros disponíveis\n` +
    `📅 *agenda* — próximos eventos`
  );
}


// =====================================================
//  WEBHOOK (recebe mensagens do Evolution API)
// =====================================================

app.post('/webhook', async (req, res) => {
  // Responde 200 imediatamente para o Evolution não reenviar
  res.sendStatus(200);

  const body = req.body;
  if (!body?.data) return;

  const { key, message, messageType } = body.data;
  if (!key?.remoteJid) return;
  if (key.fromMe) return; // Ignora mensagens do próprio bot

  const numero = key.remoteJid.replace('@s.whatsapp.net', '');
  let texto     = '';
  let mediaB64  = null;

  // Extrai texto
  if (message?.conversation)                  texto = message.conversation;
  else if (message?.extendedTextMessage?.text) texto = message.extendedTextMessage.text;
  else if (message?.imageMessage?.caption)     texto = message.imageMessage.caption;

  // Baixa imagem se necessário
  if (messageType === 'imageMessage' && EVO_URL) {
    try {
      const resp = await axios.post(
        `${EVO_URL}/chat/getBase64FromMediaMessage/${EVO_INSTANCE}`,
        { key },
        { headers: { apikey: EVO_KEY }, timeout: 20000 }
      );
      mediaB64 = resp.data?.base64;
    } catch (e) {
      console.error('Erro ao baixar mídia:', e.message);
    }
  }

  await processarMensagem(numero, texto, messageType, mediaB64);
});

// Health check
app.get('/health', (_, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`\n🤖 Bot UP-RS rodando na porta ${PORT}`);
  if (!EVO_URL) console.log('⚠️  EVO_URL não definida — rodando em modo simulação (logs no console)\n');
});
