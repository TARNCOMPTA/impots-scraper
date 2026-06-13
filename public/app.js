const $ = (s) => document.querySelector(s);

async function api(url, opts = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast-item ' + type;
  el.textContent = msg;
  $('#toast').appendChild(el);
  setTimeout(() => el.remove(), 5500);
}

// ---- Thème ----
$('#btn-theme').addEventListener('click', () => {
  const t = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('theme', t);
});

// ---- Comptes cabinet ------------------------------------------------------
let cabinetsCache = [];

async function chargerCabinets() {
  cabinetsCache = await api('/api/cabinets');
  const tbody = $('#table-cabinets tbody');
  tbody.innerHTML = '';
  $('#table-cabinets').hidden = cabinetsCache.length === 0;
  $('.vide-cab').hidden = cabinetsCache.length !== 0;
  for (const c of cabinetsCache) {
    const tr = document.createElement('tr');
    const pwd = '';
    tr.innerHTML = `
      <td>${esc(c.libelle || '—')}${pwd}</td>
      <td><span class="siret">${esc(c.login)}</span></td>
      <td>${c.nb_clients}</td>
      <td><div class="row-actions">
        <button class="btn small primary" data-cab="sync" data-id="${c.id}">↻ Synchroniser</button>
        <button class="btn small" data-cab="edit" data-id="${c.id}">Modifier</button>
        <button class="btn small danger" data-cab="del" data-id="${c.id}">Suppr.</button>
      </div></td>`;
    tbody.appendChild(tr);
  }
  remplirSelectCabinets();
}

function remplirSelectCabinets() {
  const sel = $('#client-cabinet');
  const courant = sel.value;
  sel.innerHTML = cabinetsCache.length
    ? cabinetsCache.map((c) => `<option value="${c.id}">${esc(c.libelle || c.login)}</option>`).join('')
    : '<option value="">(aucun — ajoute un compte)</option>';
  if (courant) sel.value = courant;
}

const formCab = $('#form-cabinet');
formCab.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = { libelle: formCab.libelle.value.trim(), login: formCab.login.value.trim(), password: formCab.password.value };
  const id = formCab.id.value;
  try {
    if (id) {
      await api(`/api/cabinets/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
      toast('Cabinet mis à jour.', 'ok');
    } else {
      if (!payload.login) return toast('Identifiant (e-mail) du compte requis.', 'err');
      await api('/api/cabinets', { method: 'POST', body: JSON.stringify(payload) });
      toast('Compte ajouté.', 'ok');
    }
    resetCab();
    chargerCabinets();
  } catch (err) { toast(err.message, 'err'); }
});
function resetCab() {
  formCab.reset(); formCab.id.value = '';
  $('#cab-submit').textContent = 'Ajouter le cabinet';
  $('#cab-cancel').hidden = true;
}
$('#cab-cancel').addEventListener('click', resetCab);

$('#table-cabinets').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-cab]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const act = btn.dataset.cab;
  const cab = cabinetsCache.find((c) => c.id === id);
  if (act === 'sync') {
    btn.disabled = true; btn.textContent = '↻ Sync…';
    try {
      const r = await api(`/api/cabinets/${id}/sync`, { method: 'POST' });
      let msg = `${r.total} client(s) : ${r.crees} ajouté(s), ${r.maj} mis à jour`;
      if (r.erreurs?.length) msg += `, ${r.erreurs.length} erreur(s)`;
      toast(msg, 'ok');
      rafraichir();
    } catch (err) { toast(err.message, 'err'); }
    finally { btn.disabled = false; btn.textContent = '↻ Synchroniser'; }
  } else if (act === 'edit') {
    formCab.id.value = cab.id; formCab.libelle.value = cab.libelle || ''; formCab.login.value = cab.login; formCab.password.value = '';
    $('#cab-submit').textContent = 'Mettre à jour'; $('#cab-cancel').hidden = false;
    formCab.scrollIntoView({ behavior: 'smooth' });
  } else if (act === 'del') {
    if (confirm(`Supprimer le cabinet « ${cab.libelle || cab.login} » ?\nSes clients ne seront plus rattachés (à réaffecter ou supprimer).`)) {
      await api(`/api/cabinets/${id}`, { method: 'DELETE' });
      toast('Cabinet supprimé.'); rafraichir();
    }
  }
});

// ---- Pagination (utilitaire reutilisable) ---------------------------------
function renderPagination(el, page, totalPages, onGo, total) {
  el.innerHTML = '';
  if (totalPages <= 1) { el.style.display = 'none'; return; }
  el.style.display = 'flex';
  const mk = (label, p, opts = {}) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (opts.actif) b.className = 'actif';
    b.disabled = !!opts.disabled;
    if (!opts.disabled && p) b.onclick = () => onGo(p);
    return b;
  };
  el.appendChild(mk('«', 1, { disabled: page === 1 }));
  el.appendChild(mk('‹', page - 1, { disabled: page === 1 }));
  const info = document.createElement('span');
  info.className = 'info';
  info.textContent = `Page ${page} / ${totalPages} · ${total} élément(s)`;
  el.appendChild(info);
  el.appendChild(mk('›', page + 1, { disabled: page === totalPages }));
  el.appendChild(mk('»', totalPages, { disabled: page === totalPages }));
}

// ---- Clients --------------------------------------------------------------
let clientsAll = [];
let clientsPage = 1;
let clientsTri = { col: 'nom', dir: 1 };
const selection = new Set();

// Renvoie la liste filtree + triee (sans pagination).
function clientsFiltres() {
  const q = ($('#clients-recherche').value || '').toLowerCase().trim();
  const cabFiltre = $('#clients-filtre-cabinet').value;
  let liste = clientsAll.slice();
  if (cabFiltre) liste = liste.filter((c) => String(c.cabinet_id) === cabFiltre);
  if (q) liste = liste.filter((c) => `${c.nom} ${c.siret} ${c.cabinet_libelle || ''}`.toLowerCase().includes(q));
  const { col, dir } = clientsTri;
  const val = (c) => ({
    nom: (c.nom || '').toLowerCase(),
    siret: (c.siret || '').toLowerCase(),
    cabinet: (c.cabinet_libelle || '').toLowerCase(),
    docs: c.nb_docs || 0,
    run: c.dernier_run || '',
  }[col]);
  liste.sort((a, b) => { const x = val(a), y = val(b); return x < y ? -dir : x > y ? dir : 0; });
  return liste;
}

function renderClients() {
  const liste = clientsFiltres();
  const taille = Number($('#clients-taille').value) || 50;
  const totalPages = Math.max(1, Math.ceil(liste.length / taille));
  if (clientsPage > totalPages) clientsPage = totalPages;
  if (clientsPage < 1) clientsPage = 1;
  const debut = (clientsPage - 1) * taille;
  const slice = liste.slice(debut, debut + taille);

  $('#clients-compte').textContent = liste.length === clientsAll.length ? `${clientsAll.length}` : `${liste.length} / ${clientsAll.length}`;
  $('#table-clients').hidden = clientsAll.length === 0;
  $('.vide').hidden = clientsAll.length !== 0;

  const tbody = $('#table-clients tbody');
  tbody.innerHTML = '';
  for (const c of slice) {
    const tr = document.createElement('tr');
    if (selection.has(c.id)) tr.className = 'selectionne';
    const cab = c.cabinet_libelle ? `<span class="badge cab">${esc(c.cabinet_libelle)}</span>` : '<span class="badge err">aucun</span>';
    tr.innerHTML = `
      <td class="col-check"><input type="checkbox" class="row-check" data-id="${c.id}" ${selection.has(c.id) ? 'checked' : ''} /></td>
      <td>${esc(c.nom)}</td>
      <td><span class="siret">${esc(c.siret)}</span></td>
      <td>${cab}</td>
      <td>${c.nb_docs}</td>
      <td>${c.dernier_run ? new Date(c.dernier_run + 'Z').toLocaleString('fr-FR') : '—'}</td>
      <td><div class="row-actions">
        <button class="btn small primary" data-act="scrape" data-id="${c.id}">Récupérer</button>
        <button class="btn small" data-act="docs" data-id="${c.id}" data-nom="${esc(c.nom)}">Documents</button>
        <button class="btn small" data-act="edit" data-id="${c.id}">Modifier</button>
        <button class="btn small danger" data-act="del" data-id="${c.id}">Suppr.</button>
      </div></td>`;
    tbody.appendChild(tr);
  }
  // En-tetes : indicateur de tri
  document.querySelectorAll('#table-clients th.triable').forEach((th) => {
    th.classList.toggle('tri-asc', th.dataset.sort === clientsTri.col && clientsTri.dir === 1);
    th.classList.toggle('tri-desc', th.dataset.sort === clientsTri.col && clientsTri.dir === -1);
  });
  // Case "tout selectionner" : cochee si tous les filtres sont selectionnes
  const idsFiltres = liste.map((c) => c.id);
  $('#check-all').checked = idsFiltres.length > 0 && idsFiltres.every((id) => selection.has(id));
  majBoutonSelection();
  renderPagination($('#clients-pagination'), clientsPage, totalPages, (p) => { clientsPage = p; renderClients(); }, liste.length);
}

function majBoutonSelection() {
  const n = selection.size;
  const b = $('#btn-scrape-selection');
  b.textContent = `Récupérer la sélection (${n})`;
  b.disabled = n === 0;
}

async function chargerClients() {
  clientsAll = await api('/api/clients');
  // Purge la selection des clients disparus
  const ids = new Set(clientsAll.map((c) => c.id));
  for (const id of [...selection]) if (!ids.has(id)) selection.delete(id);
  // Filtre par cabinet (alimente depuis le cache des cabinets)
  const sel = $('#clients-filtre-cabinet');
  const courant = sel.value;
  sel.innerHTML = '<option value="">Tous les cabinets</option>' +
    cabinetsCache.map((c) => `<option value="${c.id}">${esc(c.libelle || c.login)}</option>`).join('');
  sel.value = courant;
  renderClients();
}

$('#clients-recherche').addEventListener('input', () => { clientsPage = 1; renderClients(); });
$('#clients-filtre-cabinet').addEventListener('change', () => { clientsPage = 1; renderClients(); });
$('#clients-taille').addEventListener('change', () => { clientsPage = 1; renderClients(); });

// Tri par clic sur l'en-tete
document.querySelectorAll('#table-clients th.triable').forEach((th) => {
  th.addEventListener('click', () => {
    const col = th.dataset.sort;
    if (clientsTri.col === col) clientsTri.dir = -clientsTri.dir;
    else clientsTri = { col, dir: 1 };
    renderClients();
  });
});

// Selection : cases a cocher
$('#table-clients').addEventListener('change', (e) => {
  const cb = e.target.closest('.row-check');
  if (!cb) return;
  const id = Number(cb.dataset.id);
  if (cb.checked) selection.add(id); else selection.delete(id);
  cb.closest('tr').classList.toggle('selectionne', cb.checked);
  $('#check-all').checked = clientsFiltres().every((c) => selection.has(c.id));
  majBoutonSelection();
});
$('#check-all').addEventListener('change', (e) => {
  const ids = clientsFiltres().map((c) => c.id);
  if (e.target.checked) ids.forEach((id) => selection.add(id));
  else ids.forEach((id) => selection.delete(id));
  renderClients();
});

// Export CSV de la liste filtree
$('#btn-export-csv').addEventListener('click', () => {
  const liste = clientsFiltres();
  if (!liste.length) return toast('Aucun client à exporter.', 'err');
  const esc2 = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const lignes = [['Nom', 'SIRET / n° compte', 'Cabinet', 'Documents', 'Dernier run']
    .map(esc2).join(';')];
  for (const c of liste) {
    lignes.push([c.nom, c.siret, c.cabinet_libelle || '', c.nb_docs,
      c.dernier_run ? new Date(c.dernier_run + 'Z').toLocaleString('fr-FR') : ''].map(esc2).join(';'));
  }
  const blob = new Blob(['﻿' + lignes.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `clients_urssaf_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`${liste.length} client(s) exporté(s).`, 'ok');
});

// Recuperer la selection
$('#btn-scrape-selection').addEventListener('click', async () => {
  const ids = [...selection];
  if (!ids.length) return;
  if (!confirm(`Récupérer les appels de cotisations pour ${ids.length} client(s) sélectionné(s) ?`)) return;
  try {
    const r = await api('/api/scrape-selection', { method: 'POST', body: JSON.stringify({ ids }) });
    toast(`Récupération lancée pour ${r.total} client(s).`, 'ok');
    majEtatGlobal(true);
  } catch (err) { toast(err.message, 'err'); }
});

$('#table-clients').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const act = btn.dataset.act;
  if (act === 'scrape') {
    btn.disabled = true; btn.textContent = '…';
    try { await api(`/api/clients/${id}/scrape`, { method: 'POST' }); toast('Récupération lancée. Suis l\'avancement dans l\'historique.', 'ok'); }
    catch (err) { toast(err.message, 'err'); }
    finally { setTimeout(() => { btn.disabled = false; btn.textContent = 'Récupérer'; rafraichir(); }, 1500); }
  } else if (act === 'docs') { ouvrirDocs(id, btn.dataset.nom); }
  else if (act === 'edit') { remplir(id); }
  else if (act === 'del') {
    if (confirm('Supprimer ce client et ses documents enregistrés ?')) {
      await api(`/api/clients/${id}`, { method: 'DELETE' }); toast('Client supprimé.'); chargerClients();
    }
  }
});

// ---- Formulaire client ----
const form = $('#form-client');
async function remplir(id) {
  const c = (await api('/api/clients')).find((x) => x.id === id);
  if (!c) return;
  form.id.value = c.id; form.nom.value = c.nom; form.siret.value = c.siret; form.dossier.value = c.dossier || '';
  remplirSelectCabinets(); if (c.cabinet_id) form.cabinet_id.value = c.cabinet_id;
  $('#btn-submit').textContent = 'Mettre à jour'; $('#btn-cancel').hidden = false;
  form.scrollIntoView({ behavior: 'smooth' });
}
function reset() { form.reset(); form.id.value = ''; $('#btn-submit').textContent = 'Enregistrer'; $('#btn-cancel').hidden = true; }
$('#btn-cancel').addEventListener('click', reset);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    nom: form.nom.value.trim(), siret: form.siret.value.replace(/\s+/g, ''),
    dossier: form.dossier.value.trim(), cabinet_id: form.cabinet_id.value ? Number(form.cabinet_id.value) : null,
  };
  if (!/^\d{9,14}$/.test(payload.siret)) return toast('SIREN invalide (9 chiffres — ou un SIRET, on garde le SIREN).', 'err');
  if (!payload.cabinet_id) return toast('Choisis un compte de rattachement (ajoute-en un si nécessaire).', 'err');
  const id = form.id.value;
  try {
    if (id) { await api(`/api/clients/${id}`, { method: 'PUT', body: JSON.stringify(payload) }); toast('Client mis à jour.', 'ok'); }
    else { await api('/api/clients', { method: 'POST', body: JSON.stringify(payload) }); toast('Client ajouté.', 'ok'); }
    reset(); chargerClients();
  } catch (err) { toast(err.message, 'err'); }
});

// ---- Dossier de destination + sélecteur natif ----
async function choisirDossier() { const r = await api('/api/pick-folder', { method: 'POST' }); return r.folder || null; }
$('#pick-global').addEventListener('click', async () => { try { const f = await choisirDossier(); if (f) $('#dest-global').value = f; } catch (err) { toast(err.message, 'err'); } });
$('#save-global').addEventListener('click', async () => {
  try { await api('/api/settings', { method: 'POST', body: JSON.stringify({ destinationFolder: $('#dest-global').value.trim() }) }); toast('Dossier de destination enregistré.', 'ok'); }
  catch (err) { toast(err.message, 'err'); }
});
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-pick]');
  if (!btn) return;
  try { const f = await choisirDossier(); if (f) { const champ = form[btn.dataset.pick]; if (champ) champ.value = f; } }
  catch (err) { toast(err.message, 'err'); }
});
async function chargerReglages() {
  try { const s = await api('/api/settings'); $('#dest-global').value = s.destinationFolder || ''; } catch { /* ignore */ }
}

// ---- Tout récupérer (une session par cabinet) ----
$('#btn-scrape-all').addEventListener('click', async () => {
  if (!confirm('Lancer la récupération pour TOUS les clients ?\n(Une connexion par cabinet, puis enchaînement de ses clients.)')) return;
  try {
    const r = await api('/api/scrape-all', { method: 'POST' });
    toast(`Récupération lancée : ${r.total} client(s) sur ${r.cabinets} cabinet(s).`, 'ok');
    majEtatGlobal(true);
  } catch (err) { toast(err.message, 'err'); }
});
$('#btn-stop-all').addEventListener('click', async () => {
  try { await api('/api/scrape-all/stop', { method: 'POST' }); toast('Arrêt demandé — fin après le client en cours.', 'ok'); }
  catch (err) { toast(err.message, 'err'); }
});
function majEtatGlobal(enCours) {
  $('#btn-scrape-all').disabled = enCours;
  $('#btn-scrape-all').textContent = enCours ? 'Récupération en cours…' : 'Tout récupérer';
  $('#btn-stop-all').hidden = !enCours;
}
async function suivreEtat() {
  try { const s = await api('/api/status'); majEtatGlobal(Array.isArray(s.enCours) && s.enCours.includes('all')); } catch { /* ignore */ }
}
setInterval(suivreEtat, 4000);

// ---- Documents ----
const dialogDocs = $('#dialog-docs');
async function ouvrirDocs(id, nom) {
  const docs = await api(`/api/clients/${id}/documents`);
  $('#docs-titre').textContent = `Documents — ${nom}`;
  const ul = $('#docs-liste');
  ul.innerHTML = docs.length ? '' : '<li class="vide">Aucun document récupéré.</li>';
  for (const d of docs) {
    const li = document.createElement('li');
    li.innerHTML = `<span><span class="lib">${esc(d.libelle || d.fichier.split(/[\\/]/).pop())}</span><br/>
      <span class="date">${new Date(d.recupere_le + 'Z').toLocaleString('fr-FR')}</span></span>
      <a class="btn small" href="/api/documents/file?path=${encodeURIComponent(d.fichier)}" target="_blank">Ouvrir</a>`;
    ul.appendChild(li);
  }
  dialogDocs.showModal();
}
$('#docs-fermer').addEventListener('click', () => dialogDocs.close());

// ---- Historique ----
let runsAll = [];
let runsPage = 1;
const RUNS_TAILLE = 25;

function renderRuns() {
  const totalPages = Math.max(1, Math.ceil(runsAll.length / RUNS_TAILLE));
  if (runsPage > totalPages) runsPage = totalPages;
  const debut = (runsPage - 1) * RUNS_TAILLE;
  const slice = runsAll.slice(debut, debut + RUNS_TAILLE);
  const tbody = $('#table-runs tbody');
  tbody.innerHTML = '';
  for (const r of slice) {
    const cls = r.statut === 'succes' ? 'ok' : 'err';
    const lib = { succes: 'succès', echec: 'échec', echec_mdp: '🔒 mot de passe' }[r.statut] || r.statut;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${new Date(r.lance_le + 'Z').toLocaleString('fr-FR')}</td>
      <td>${esc(r.client_nom || '—')}</td><td><span class="badge ${cls}">${lib}</span></td>
      <td>${r.nb_docs}</td><td>${esc(r.message || '')}</td>`;
    tbody.appendChild(tr);
  }
  renderPagination($('#runs-pagination'), runsPage, totalPages, (p) => { runsPage = p; renderRuns(); }, runsAll.length);
}

async function chargerRuns() {
  runsAll = await api('/api/runs');
  renderRuns();
}

// ---- Mise a jour ----------------------------------------------------------
let majLatest = null;
async function verifierMaj() {
  try { const v = await api('/api/version'); $('#pied-version').textContent = 'v' + v.version; } catch { /* ignore */ }
  let dispo = false;
  try {
    const m = await api('/api/update/check');
    const ignoree = localStorage.getItem('maj_ignoree');
    // Le bandeau n'apparait QUE s'il y a une version plus recente, non deja repoussee.
    if (m.updateAvailable && m.latest && m.latest !== ignoree) {
      majLatest = m.latest;
      $('#maj-texte').textContent = `Mise à jour disponible : v${m.latest}` + (m.notes ? ` — ${m.notes}` : '');
      dispo = true;
    }
  } catch { /* hors-ligne : pas de bandeau */ }
  $('#maj-banner').hidden = !dispo;
}
$('#maj-plustard').addEventListener('click', () => {
  if (majLatest) localStorage.setItem('maj_ignoree', majLatest); // ne plus proposer cette version
  $('#maj-banner').hidden = true;
});
$('#maj-install').addEventListener('click', async () => {
  const btn = $('#maj-install');
  btn.disabled = true; btn.textContent = 'Installation…';
  try {
    await api('/api/update/apply', { method: 'POST' });
    $('#maj-texte').textContent = 'Mise à jour en cours, redémarrage de l\'application…';
    $('#maj-plustard').hidden = true;
    let essais = 0;
    const timer = setInterval(async () => {
      essais++;
      try { const r = await fetch('/api/version', { cache: 'no-store' }); if (r.ok) { clearInterval(timer); location.reload(); } } catch { /* pas encore */ }
      if (essais > 60) { clearInterval(timer); toast('Le redémarrage prend du temps — recharge la page.', 'err'); }
    }, 1500);
  } catch (err) { toast(err.message, 'err'); btn.disabled = false; btn.textContent = 'Installer'; }
});

async function rafraichir() { await chargerCabinets(); await Promise.all([chargerClients(), chargerRuns()]); }
rafraichir();
chargerReglages();
suivreEtat();
verifierMaj();
setInterval(chargerRuns, 5000);
