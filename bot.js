// =====================================================
//  UP-RS Sistema - Google Apps Script (Code.gs)
//  API pura — o HTML está hospedado no Netlify.
//  Implanta como Web App: Execute como Você / Qualquer pessoa
// =====================================================

function doGet(e) {
  var cb = e && e.parameter && e.parameter.callback;

  // Busca URL de arquivo no Drive pelo nome (dentro da pasta/caminho indicado)
  if (e && e.parameter && e.parameter.action === 'getFileUrl') {
    var result;
    try {
      var folder = getFolderByPath(e.parameter.folder || 'Geral');
      var files = folder.getFilesByName(e.parameter.name);
      result = JSON.stringify(files.hasNext()
        ? { ok: true, url: 'https://drive.google.com/file/d/' + files.next().getId() + '/view' }
        : { ok: false });
    } catch(err) { result = JSON.stringify({ ok: false, error: err.message }); }
    return cb
      ? ContentService.createTextOutput(cb + '(' + result + ')').setMimeType(ContentService.MimeType.JAVASCRIPT)
      : ContentService.createTextOutput(result).setMimeType(ContentService.MimeType.JSON);
  }

  // Retorna todos os dados (GET normal ou JSONP)
  var data = getSheet().getRange('A2').getValue() || JSON.stringify({
    users: [{user:'admin', pass:'uprs2025'}],
    militantes:[], apoiadores:[], interessados:[],
    financas:[], inventario:[], livros:[],
    eventos:[], presencaEventos:[],
    metas:[], bancas:[], artes:[], cultura:[]
  });
  return cb
    ? ContentService.createTextOutput(cb + '(' + data + ')').setMimeType(ContentService.MimeType.JAVASCRIPT)
    : ContentService.createTextOutput(data).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  // Upload de ficheiro para o Drive — organizado por caminho de pasta
  if (e.parameter && e.parameter.action === 'upload') {
    try {
      var b64 = e.parameter.fileData;
      if (b64.indexOf(',') > -1) b64 = b64.split(',')[1];
      var blob = Utilities.newBlob(
        Utilities.base64Decode(b64),
        e.parameter.mimeType || 'application/octet-stream',
        e.parameter.fileName || 'arquivo'
      );
      var folder = getFolderByPath(e.parameter.folder || 'Geral');
      var file   = folder.createFile(blob);
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      return ContentService
        .createTextOutput(JSON.stringify({ ok: true, url: 'https://drive.google.com/file/d/' + file.getId() + '/view' }))
        .setMimeType(ContentService.MimeType.JSON);
    } catch(err) {
      return ContentService
        .createTextOutput(JSON.stringify({ ok: false, error: err.message }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  // Adicionar interessado/contato (vindo do bot WhatsApp)
  var postJson = null;
  try { postJson = JSON.parse(e.postData ? e.postData.contents : '{}'); } catch(x) { postJson = {}; }

  var action = (e.parameter && e.parameter.action) || postJson.action || '';

  if (action === 'addInteressado') {
    try {
      var nome        = (e.parameter && e.parameter.nome)        || postJson.nome        || '';
      var tel         = (e.parameter && e.parameter.tel)         || postJson.tel         || '';
      var indicadoPor = (e.parameter && e.parameter.indicadoPor) || postJson.indicadoPor || '';
      var ts          = (e.parameter && e.parameter.ts)          || postJson.ts          || new Date().toISOString();

      var sh  = getSheet();
      var raw = sh.getRange('A2').getValue() || '{}';
      var db  = JSON.parse(raw);
      if (!db.interessados) db.interessados = [];

      db.interessados.push({
        id:          'int_' + Date.now(),
        nome:        nome,
        tel:         tel,
        indicadoPor: indicadoPor,
        ts:          ts,
        status:      'novo'
      });

      sh.getRange('A1').setValue('Sync: ' + new Date().toLocaleString('pt-BR'));
      sh.getRange('A2').setValue(JSON.stringify(db));

      return ContentService
        .createTextOutput(JSON.stringify({ ok: true }))
        .setMimeType(ContentService.MimeType.JSON);
    } catch(err) {
      return ContentService
        .createTextOutput(JSON.stringify({ ok: false, error: err.message }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  // Guardar dados (sync completo do portal)
  var data = (e.parameter && e.parameter.data)
    ? e.parameter.data
    : (e.postData ? e.postData.contents : '{}');
  try {
    JSON.parse(data);
    var sh = getSheet();
    sh.getRange('A1').setValue('Sync: ' + new Date().toLocaleString('pt-BR'));
    sh.getRange('A2').setValue(data);
    return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(ContentService.MimeType.JSON);
  } catch(err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: err.message })).setMimeType(ContentService.MimeType.JSON);
  }
}

// ---- Planilha de dados ----
function getSheet() {
  var props = PropertiesService.getScriptProperties();
  var ssId  = props.getProperty('ssId');
  var ss;
  try { if (ssId) ss = SpreadsheetApp.openById(ssId); } catch(e) { ss = null; }
  if (!ss) {
    ss = SpreadsheetApp.create('UP-RS Sistema - Dados');
    props.setProperty('ssId', ss.getId());
  }
  return ss.getSheetByName('UPRS') || ss.insertSheet('UPRS');
}

// ---- Pastas do Drive: navega/cria por caminho, ex: "Militantes/João Silva" ou "Artes" ----
function getRootFolder() {
  var name = 'UP-RS Sistema';
  var folders = DriveApp.getFoldersByName(name);
  return folders.hasNext() ? folders.next() : DriveApp.createFolder(name);
}

function getFolderByPath(path) {
  var current = getRootFolder();
  var parts = (path || 'Geral').toString().split('/');
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i].trim();
    if (!part) continue;
    var folders = current.getFoldersByName(part);
    current = folders.hasNext() ? folders.next() : current.createFolder(part);
  }
  return current;
}
