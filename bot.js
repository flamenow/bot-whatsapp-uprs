// Bot WhatsApp - UP-RS
const express = require('express');
const axios   = require('axios');
const FormData = require('form-data');

const app = express();
app.use(express.json({ limit: '50mb' }));

const GAS_URL      = process.env.GAS_URL      || 'https://script.google.com/macros/s/AKfycbyCv6vnlaj1zw5Jy6t2b_2RurRJ_4Bt5q80EDsrjwtvOl5ARE4JR9Iq4nNuYvVuMjgD/exec';
const EVO_URL      = process.env.EVO_URL      || '';
const EVO_KEY      = process.env.EVO_KEY      || '';
const EVO_INSTANCE = process.env.EVO_INSTANCE || 'up-rs';
const PORT         = process.env.PORT         || 3000;

const sessoes = new Map();

async function fetchDB() {
  try {
    const resp = await axios.get(GAS_URL, { timeout: 12000 });
    return resp.data;
  } catch (e) {
    console.error('Erro ao buscar DB:', e.message);
    return null;
  }
}

// Busca membro por telefone, consultando lidMap se for JID @lid
function encontrarMembro(db, numero) {
  let numParaBusca = numero;

  // Se for JID com @lid, resolve via lidMap salvo no GAS
  if (typeof numero === 'string' && numero.includes('@lid')) {
    const lidNum = numero.replace('@lid', '');
    const lidMap = db.lidMap || {};
    if (lidMap[lidNum]) {
      numParaBusca = lidMap[lidNum];
    } else {
      return null; // LID ainda nao vinculado
    }
  }

  const limpo = numParaBusca.replace(/\D/g, '');
  const variantes = [limpo, '55' + limpo, limpo.replace(/^55/, '')];

  const mil = (db.militantes || []).find(m => {
    const tel = (m.tel || '').replace(/\D/g, '');
    if (!tel) return false;
    return variantes.some(v => tel === v || tel.endsWith(v) || v.endsWith(tel));
  });
  if (mil) return { tipo: 'militante', dados: mil };

  const apo = (db.apoiadores || []).find(a => {
    const tel = (a.tel || '').replace(/\D/g, '');
    if (!tel) return false;
    return variantes.some(v => tel === v || tel.endsWith(v) || v.endsWith(tel));
  });
  if (apo) return { tipo: 'apoiador', dados: apo };

  return null;
}

// Busca membro por CPF
function encontrarMembroPorCpf(db, cpf) {
  const limpo = cpf.replace(/\D/g, '');
  const mil = (db.militantes || []).find(m => (m.cpf || '').replace(/\D/g, '') === limpo);
  if (mil) return { tipo: 'militante', dados: mil };
  const apo = (db.apoiadores || []).find(a => (a.cpf || '').replace(/\D/g, '') === limpo);
  if (apo) return { tipo: 'apoiador', dados: apo };
  return null;
}

// Salva mapeamento LID -> telefone no GAS para uso futuro
async function salvarLidMap(lid, phone) {
  try {
    await axios.post(GAS_URL, { action: 'saveLidMap', lid, phone }, { timeout: 10000 });
  } catch(e) {
    console.error('Erro ao salvar lidMap:', e.message);
  }
}

function statusCota(militante) {
  const hoje     = new Date();
  const cota     = parseFloat(militante.cota) || 0;
  const pagamentos = militante.pagamentos || [];
  const mesesDevendo = [];

  let inicio;
  if (militante.filiacao) {
    inicio = new Date(militante.filiacao);
    inicio.setDate(1);
  } else {
    inicio = new Date(hoje.getFullYear(), hoje.getMonth() - 12, 1);
  }

  const cursor = new Date(inicio.getFullYear(), inicio.getMonth(), 1);
  const fimMes = new Date(hoje.getFullYear(), hoje.getMonth(), 1);

  while (cursor <= fimMes) {
    const ym = cursor.getFullYear() + '-' + String(cursor.getMonth() + 1).padStart(2, '0');
    if (!pagamentos.some(p => p.mes === ym)) mesesDevendo.push(ym);
    cursor.setMonth(cursor.getMonth() + 1);
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

function fmtData(ym) {
  if (!ym) return ym;
  const [ano, mes] = ym.split('-');
  const nomes = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  return nomes[parseInt(mes) - 1] + '/' + ano;
}

function parseMes(texto) {
  const cmd = texto.toLowerCase().trim();
  const mesesNomes = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];

  const m1 = cmd.match(/^(\d{4})[\/\-](\d{1,2})$/);
  if (m1) return m1[1] + '-' + m1[2].padStart(2, '0');

  const m2 = cmd.match(/^(\d{1,2})[\/\-](\d{4})$/);
  if (m2) return m2[2] + '-' + m2[1].padStart(2, '0');

  const idx = mesesNomes.findIndex(n => cmd.includes(n));
  if (idx >= 0) {
    const ano = (cmd.match(/\d{4}/) || [new Date().getFullYear()])[0];
    return ano + '-' + String(idx + 1).padStart(2, '0');
  }

  return null;
}

async function enviarMsg(numero, texto) {
  if (!EVO_URL || !EVO_KEY) {
    console.log('[-> ' + numero + ']\n' + texto + '\n');
    return;
  }
  try {
    await axios.post(
      EVO_URL + '/message/sendText/' + EVO_INSTANCE,
      { number: numero, text: texto },
      { headers: { apikey: EVO_KEY } }
    );
  } catch (e) {
    console.error('Erro ao enviar mensagem para ' + numero + ':', e.message);
  }
}

function msgCota(membro, numero) {
  const { cota, mesesDevendo } = statusCota(membro.dados);
  const nome = membro.dados.nome.split(' ')[0];
  if (mesesDevendo.length === 0) {
    return 'Ola, ' + nome + '! Suas cotas estao em dia.\n\nCota mensal: R$ ' + cota + ',00\n\nObrigado pelo comprometimento!';
  }
  const lista = mesesDevendo.map(m => '  - ' + fmtData(m) + ' - R$ ' + cota + ',00').join('\n');
  const total = cota * mesesDevendo.length;
  return 'Ola, ' + nome + '! Cotas pendentes:\n\n' + lista + '\n\nTotal: R$ ' + total + ',00\n\nPara enviar comprovante, manda *comprovante* aqui.';
}

async function processarMensagem(numero, texto, tipoMsg, mediaBase64, contextoGrupo) {
  const db = await fetchDB();
  if (!db) {
    await enviarMsg(numero, 'Sistema indisponivel no momento. Tente em alguns minutos.');
    return;
  }

  const membro = encontrarMembro(db, numero);
  const sessao = sessoes.get(numero) || {};
  const cmd    = (texto || '').toLowerCase().trim();
  const isLid  = typeof numero === 'string' && numero.includes('@lid');

  // Estado: aguardando comprovante (imagem)
  if (sessao.estado === 'aguardando_comprovante' && tipoMsg === 'imageMessage') {
    await enviarMsg(numero, 'Recebi! Enviando ao sistema...');
    try {
      const mes        = sessao.mes;
      const uniqueName = 'comp_' + numero.replace(/\D/g, '') + '_' + mes + '_' + Date.now() + '.jpg';
      const fd = new FormData();
      fd.append('action',   'upload');
      fd.append('fileName', uniqueName);
      fd.append('mimeType', 'image/jpeg');
      fd.append('fileData', mediaBase64);
      fd.append('folder',   'Comprovantes');
      await axios.post(GAS_URL, fd, { headers: fd.getHeaders(), timeout: 30000 });
      await enviarMsg(numero, 'Comprovante enviado!\n\nMes: ' + fmtData(mes) + '\nA direcao vai confirmar em breve. Obrigado!');
    } catch (e) {
      console.error('Erro no upload:', e.message);
      await enviarMsg(numero, 'Erro ao enviar o arquivo. Tente novamente ou entre em contato com o nucleo.');
    }
    sessoes.delete(numero);
    return;
  }

  // Estado: aguardando mes do comprovante
  if (sessao.estado === 'aguardando_mes') {
    const mes = parseMes(cmd);
    if (!mes) {
      const hoje = new Date();
      const ex   = String(hoje.getMonth() + 1).padStart(2, '0') + '/' + hoje.getFullYear();
      await enviarMsg(numero, 'Nao entendi o mes. Manda assim: ' + ex);
      return;
    }
    sessoes.set(numero, { estado: 'aguardando_comprovante', mes });
    await enviarMsg(numero, 'Agora me manda a foto do comprovante referente a ' + fmtData(mes) + '.');
    return;
  }

  // Estado: aguardando CPF para vincular LID (primeiro uso no grupo)
  if (sessao.estado === 'aguardando_cpf_lid') {
    const cpf = texto.replace(/\D/g, '');
    if (cpf.length !== 11) {
      await enviarMsg(numero, 'CPF invalido. Manda os 11 digitos sem pontos ou traco:\nEx: 12345678901');
      return;
    }
    const membroCpf = encontrarMembroPorCpf(db, cpf);
    if (!membroCpf) {
      sessoes.delete(numero);
      await enviarMsg(numero, 'CPF nao encontrado no cadastro. Fala com a direcao do teu nucleo.');
      return;
    }
    // Salva o vinculo LID -> telefone no GAS
    const lidNum = numero.replace('@lid', '');
    const phone  = (membroCpf.dados.tel || '').replace(/\D/g, '');
    await salvarLidMap(lidNum, phone);

    const cmdPendente = sessao.cmdPendente || 'cota';
    sessoes.delete(numero);

    // Mostra resultado do comando pendente
    await enviarMsg(numero, 'Cadastro vinculado com sucesso!');
    if (['cota', 'cotas', 'pagamento', 'paguei'].includes(cmdPendente) && membroCpf.tipo === 'militante') {
      await enviarMsg(numero, msgCota(membroCpf, numero));
    } else if (['comprovante', 'comp', 'pagar'].includes(cmdPendente) && membroCpf.tipo === 'militante') {
      sessoes.set(numero, { estado: 'aguardando_mes' });
      const hoje = new Date();
      const ex   = String(hoje.getMonth() + 1).padStart(2, '0') + '/' + hoje.getFullYear();
      await enviarMsg(numero, 'Qual mes e o comprovante?\n\nEx: ' + ex);
    } else {
      await enviarMsg(numero, 'Agora voce pode usar todos os comandos no grupo. Tenta de novo!');
    }
    return;
  }

  // Estado: indicar contato - nome
  if (sessao.estado === 'indicar_nome') {
    const nome = texto.trim();
    if (!nome || nome.length < 3) {
      await enviarMsg(numero, 'Nao entendi. Me manda o nome completo da pessoa.');
      return;
    }
    sessoes.set(numero, { estado: 'indicar_tel', nome });
    await enviarMsg(numero, 'Qual o numero de WhatsApp dessa pessoa?\n\nEx: 53999990000');
    return;
  }

  // Estado: indicar contato - telefone
  if (sessao.estado === 'indicar_tel') {
    const tel = texto.replace(/\D/g, '');
    if (tel.length < 8) {
      await enviarMsg(numero, 'Numero invalido. Manda so os digitos, ex: 53999990000');
      return;
    }
    const { nome } = sessao;
    const indicadoPor = membro ? membro.dados.nome : numero;
    sessoes.delete(numero);
    try {
      await axios.post(GAS_URL, {
        action: 'addInteressado',
        nome,
        tel,
        indicadoPor,
        ts: new Date().toISOString()
      }, { timeout: 10000 });
    } catch (e) {
      console.error('Erro ao salvar interessado:', e.message);
    }
    await enviarMsg(numero, 'Contato de ' + nome + ' registrado!\nA direcao vai entrar em contato em breve. Valeu pela indicacao!');
    return;
  }

  // Comandos principais

  if (['cota', 'cotas', 'pagamento', 'paguei'].includes(cmd)) {
    if (!membro || membro.tipo !== 'militante') {
      if (isLid) {
        sessoes.set(numero, { estado: 'aguardando_cpf_lid', cmdPendente: cmd });
        await enviarMsg(numero, 'Para verificar seu cadastro, me manda seu CPF (so os 11 digitos, sem pontos):');
        return;
      }
      await enviarMsg(numero, 'Nao encontrei seu cadastro. Fala com a direcao do teu nucleo.');
      return;
    }
    await enviarMsg(numero, msgCota(membro, numero));
    return;
  }

  if (['comprovante', 'comp', 'pagar'].includes(cmd)) {
    if (!membro || membro.tipo !== 'militante') {
      if (isLid) {
        sessoes.set(numero, { estado: 'aguardando_cpf_lid', cmdPendente: cmd });
        await enviarMsg(numero, 'Para verificar seu cadastro, me manda seu CPF (so os 11 digitos, sem pontos):');
        return;
      }
      await enviarMsg(numero, 'Nao encontrei seu cadastro. Fala com o nucleo.');
      return;
    }
    sessoes.set(numero, { estado: 'aguardando_mes' });
    const hoje = new Date();
    const ex   = String(hoje.getMonth() + 1).padStart(2, '0') + '/' + hoje.getFullYear();
    await enviarMsg(numero, 'Qual mes e o comprovante?\n\nEx: ' + ex);
    return;
  }

  if (['livros', 'livro', 'loja', 'comprar'].includes(cmd)) {
    const livros = livrosDisponiveis(db);
    if (livros.length === 0) {
      await enviarMsg(numero, 'Nao ha livros disponiveis no momento.');
      return;
    }
    const lista = livros.map((l, i) => {
      const preco = l.val2 ? 'R$ ' + l.val2 + ' (militante) / R$ ' + l.val + ' (externo)' : 'R$ ' + l.val;
      return (i+1) + '. ' + l.titulo + '\n   ' + (l.autor || '') + '\n   ' + preco + ' - Estoque: ' + l.qtd + ' un.';
    }).join('\n\n');
    await enviarMsg(numero, 'Livros disponiveis:\n\n' + lista + '\n\nPara solicitar, fala com a banca.');
    return;
  }

  if (['agenda', 'calendario', 'eventos', 'evento'].includes(cmd)) {
    const eventos = proximosEventos(db);
    if (eventos.length === 0) {
      await enviarMsg(numero, 'Nenhum evento agendado para os proximos dias.');
      return;
    }
    const lista = eventos.map(e => {
      const partes = e.data.split('-');
      const dataFmt = partes[2] + '/' + partes[1] + '/' + partes[0];
      return e.titulo + '\n   Data: ' + dataFmt + (e.hora ? ' as ' + e.hora : '') + '\n   Local: ' + (e.local || 'A confirmar');
    }).join('\n\n');
    await enviarMsg(numero, 'Proximos eventos:\n\n' + lista);
    return;
  }

  if (['cadastro', 'portal', 'entrar', 'login'].includes(cmd)) {
    const codigo = db.codigoConvite || null;
    if (membro) {
      await enviarMsg(numero, 'Portal UP-RS:\nhttps://sistema-upsul.netlify.app/\n\nLa voce pode ver suas cotas, eventos, livros e muito mais.');
    } else {
      const msgCodigo = codigo
        ? '\n\nCodigo de convite: ' + codigo + '\n\nUse esse codigo para criar seu login de filiado no portal.'
        : '\n\nPara criar sua conta, entre em contato com a direcao do seu nucleo para obter o codigo de convite.';
      await enviarMsg(numero, 'Portal UP-RS:\nhttps://sistema-upsul.netlify.app/' + msgCodigo);
    }
    return;
  }

  if (['contato', 'indicar', 'interessado'].includes(cmd)) {
    sessoes.set(numero, { estado: 'indicar_nome' });
    await enviarMsg(numero, 'Qual o nome completo da pessoa que voce quer indicar?');
    return;
  }

  // Menu (so no privado)
  if (contextoGrupo) return;
  const saudacao = membro ? 'Ola, ' + membro.dados.nome.split(' ')[0] + '! ' : 'Ola! ';
  await enviarMsg(numero,
    saudacao + 'Sou o bot da UP-RS\n\n' +
    'Digite uma opcao:\n\n' +
    '*cota* - ver status das suas cotas\n' +
    '*comprovante* - enviar comprovante de pagamento\n' +
    '*livros* - ver livros disponiveis\n' +
    '*agenda* - proximos eventos\n' +
    '*cadastro* - acessar o portal UP-RS\n' +
    '*contato* - registrar contato de pessoa interessada'
  );
}

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  const body = req.body;
  if (!body || !body.data) return;

  const { key, message, messageType } = body.data;
  if (!key || !key.remoteJid) return;
  if (key.fromMe) return;

  const isGrupo = key.remoteJid.endsWith('@g.us');
  const PREFIXO = '/up';

  let numero, texto, mediaB64, contextoGrupo;
  mediaB64      = null;
  contextoGrupo = null;

  if (message && message.conversation)                                              texto = message.conversation;
  else if (message && message.extendedTextMessage && message.extendedTextMessage.text) texto = message.extendedTextMessage.text;
  else if (message && message.imageMessage && message.imageMessage.caption)         texto = message.imageMessage.caption;
  else texto = '';

  if (isGrupo) {
    const trimmed      = (texto || '').trim();
    const trimmedLower = trimmed.toLowerCase();

    const ehComandoUp      = trimmedLower.startsWith(PREFIXO);
    const ehComandoContato = trimmedLower === '/contato';

    if (!ehComandoUp && !ehComandoContato) return;

    const participantRaw = body.data.participant || key.participant || '';

    // Se for LID, mantemos o JID completo — Evolution API consegue entregar no privado
    if (participantRaw.endsWith('@lid')) {
      numero = participantRaw; // ex: "57316523167927@lid"
    } else {
      numero = participantRaw.replace('@s.whatsapp.net', '');
    }

    texto         = ehComandoContato ? 'contato' : trimmed.slice(PREFIXO.length).trim();
    contextoGrupo = { grupoJid: key.remoteJid };

    await enviarMsg(key.remoteJid, 'Te respondi no privado!');
  } else {
    numero = key.remoteJid.replace('@s.whatsapp.net', '');
  }

  if (!numero) return;

  if (messageType === 'imageMessage' && EVO_URL) {
    try {
      const resp = await axios.post(
        EVO_URL + '/chat/getBase64FromMediaMessage/' + EVO_INSTANCE,
        { key },
        { headers: { apikey: EVO_KEY }, timeout: 20000 }
      );
      mediaB64 = resp.data && resp.data.base64;
    } catch (e) {
      console.error('Erro ao baixar midia:', e.message);
    }
  }

  await processarMensagem(numero, texto, messageType, mediaB64, contextoGrupo);
});

app.get('/health', function(_, res) { res.json({ ok: true, ts: new Date().toISOString() }); });

app.listen(PORT, function() {
  console.log('Bot UP-RS rodando na porta ' + PORT);
});
