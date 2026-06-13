import 'dotenv/config';
import express from 'express';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import {
  listClients, getClient, createClient, updateClient, deleteClient, getClientBySiret,
  listClientsByCabinet, importClients, listDocuments, listRuns, getSetting, setSetting,
  listCabinets, getCabinetFull, createCabinet, updateCabinet, deleteCabinet, cabinetsConfigure,
} from './src/db.js';
import { scrapeClient, listerClients, scrapeAll } from './src/scraper-impots.js';
import { verifierMaj, appliquerMaj, versionLocale } from './src/update.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(resolve(__dirname, 'public')));

const enCours = new Set();
let stopAll = false;

// ---- Comptes cabinet ------------------------------------------------------
app.get('/api/cabinets', (req, res) => res.json(listCabinets()));

app.post('/api/cabinets', (req, res) => {
  const { libelle, login, password } = req.body || {};
  // Connexion manuelle (captcha) : le mot de passe est facultatif (juste pour mémo).
  if (!login) return res.status(400).json({ error: 'Identifiant du cabinet (e-mail) requis.' });
  res.status(201).json(createCabinet({ libelle, login, password }));
});

app.put('/api/cabinets/:id', (req, res) => {
  const c = updateCabinet(Number(req.params.id), req.body || {});
  if (!c) return res.status(404).json({ error: 'Cabinet introuvable.' });
  res.json(c);
});

app.delete('/api/cabinets/:id', (req, res) => { deleteCabinet(Number(req.params.id)); res.json({ ok: true }); });

// Synchronise le portefeuille d'UN cabinet (importe ses clients, rattaches a ce cabinet).
app.post('/api/cabinets/:id/sync', async (req, res) => {
  const id = Number(req.params.id);
  const cab = getCabinetFull(id);
  if (!cab) return res.status(404).json({ error: 'Cabinet introuvable.' });
  const key = 'sync:' + id;
  if (enCours.has(key)) return res.status(409).json({ error: 'Synchronisation déjà en cours pour ce cabinet.' });
  enCours.add(key);
  try {
    const rows = await listerClients(cab);
    const bilan = importClients(rows, id);
    res.json({ ...bilan, total: rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    enCours.delete(key);
  }
});

// ---- Clients --------------------------------------------------------------
app.get('/api/clients', (req, res) => res.json(listClients()));

app.post('/api/clients', (req, res) => {
  const { nom, siret, dossier, cabinet_id } = req.body || {};
  if (!nom || !siret) return res.status(400).json({ error: 'nom et SIRET sont requis.' });
  if (getClientBySiret(siret)) return res.status(409).json({ error: 'Un client avec ce SIRET existe déjà.' });
  res.status(201).json(createClient({ nom, siret, dossier, cabinet_id: cabinet_id || null }));
});

app.post('/api/clients/import', (req, res) => {
  const clients = req.body?.clients;
  if (!Array.isArray(clients) || clients.length === 0) return res.status(400).json({ error: 'Aucune ligne à importer.' });
  if (clients.length > 5000) return res.status(400).json({ error: 'Trop de lignes (max 5000).' });
  res.json(importClients(clients, req.body?.cabinet_id || null));
});

app.put('/api/clients/:id', (req, res) => {
  const c = updateClient(Number(req.params.id), req.body || {});
  if (!c) return res.status(404).json({ error: 'Client introuvable.' });
  res.json(c);
});

app.delete('/api/clients/:id', (req, res) => { deleteClient(Number(req.params.id)); res.json({ ok: true }); });

app.get('/api/clients/:id/documents', (req, res) => res.json(listDocuments(Number(req.params.id))));

app.get('/api/documents/file', (req, res) => {
  const f = String(req.query.path || '');
  if (!f || !existsSync(f)) return res.status(404).end();
  res.sendFile(f);
});

// ---- Reglages -------------------------------------------------------------
app.get('/api/settings', (req, res) => res.json({ destinationFolder: getSetting('destination_folder', '') }));
app.post('/api/settings', (req, res) => {
  if (typeof req.body?.destinationFolder === 'string') setSetting('destination_folder', req.body.destinationFolder.trim());
  res.json({ destinationFolder: getSetting('destination_folder', '') });
});

// Selecteur de dossier natif Windows
app.post('/api/pick-folder', (req, res) => {
  const script =
    'Add-Type -AssemblyName System.Windows.Forms;' +
    '$f = New-Object System.Windows.Forms.FolderBrowserDialog;' +
    '$f.Description = "Dossier de destination des appels de cotisations";' +
    '$top = New-Object System.Windows.Forms.Form; $top.TopMost = $true; $top.ShowInTaskbar = $false;' +
    'if ($f.ShowDialog($top) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($f.SelectedPath) }';
  const ps = spawn('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-Command', script], { windowsHide: true });
  let out = '';
  const t = setTimeout(() => ps.kill(), 120000);
  ps.stdout.on('data', (d) => (out += d));
  ps.on('close', () => { clearTimeout(t); const p = out.trim(); res.json(p ? { folder: p } : { folder: null, annule: true }); });
  ps.on('error', (e) => { clearTimeout(t); res.status(500).json({ error: e.message }); });
});

// ---- Recuperation ---------------------------------------------------------
async function lancer(clientId, res) {
  const c = getClient(clientId);
  if (!c) return res?.status(404).json({ error: 'Client introuvable.' });
  if (!c.cabinet_id) return res?.status(400).json({ error: 'Ce client n\'est rattaché à aucun cabinet.' });
  const cab = getCabinetFull(c.cabinet_id);
  if (!cab) return res?.status(400).json({ error: 'Le cabinet de ce client est introuvable.' });
  if (enCours.has(clientId)) return res?.status(409).json({ error: 'Récupération déjà en cours pour ce client.' });
  enCours.add(clientId);
  res?.json({ started: true, client: c.nom });
  try {
    await scrapeClient(c, { cabinet: cab, baseFolder: getSetting('destination_folder') });
  } finally { enCours.delete(clientId); }
}

app.post('/api/clients/:id/scrape', (req, res) => lancer(Number(req.params.id), res));

// Traite un lot de clients : groupe par cabinet, UNE session par cabinet.
async function lancerLot(clients) {
  const baseFolder = getSetting('destination_folder');
  const parCabinet = new Map();
  for (const c of clients) {
    if (!c.cabinet_id) continue;
    if (!parCabinet.has(c.cabinet_id)) parCabinet.set(c.cabinet_id, []);
    parCabinet.get(c.cabinet_id).push(c);
  }
  for (const [cabinetId, sousClients] of parCabinet) {
    if (stopAll) break;
    const cab = getCabinetFull(cabinetId);
    if (!cab) continue;
    await scrapeAll(sousClients, { cabinet: cab, baseFolder, shouldStop: () => stopAll });
  }
}

// Tout recuperer : tous les clients de tous les cabinets.
app.post('/api/scrape-all', async (req, res) => {
  if (!cabinetsConfigure()) return res.status(400).json({ error: 'Configure d\'abord au moins un compte cabinet.' });
  if (enCours.has('all')) return res.status(409).json({ error: 'Une récupération globale est déjà en cours.' });
  const clients = listClients();
  const total = clients.filter((c) => c.cabinet_id).length;
  enCours.add('all');
  stopAll = false;
  res.json({ started: true, total });
  try { await lancerLot(clients); } finally { enCours.delete('all'); }
});

// Recuperer une SELECTION de clients (par ids).
app.post('/api/scrape-selection', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
  if (!ids.length) return res.status(400).json({ error: 'Aucun client sélectionné.' });
  if (!cabinetsConfigure()) return res.status(400).json({ error: 'Configure d\'abord au moins un compte cabinet.' });
  if (enCours.has('all')) return res.status(409).json({ error: 'Une récupération est déjà en cours.' });
  const clients = ids.map((id) => getClient(id)).filter(Boolean);
  enCours.add('all');
  stopAll = false;
  res.json({ started: true, total: clients.filter((c) => c.cabinet_id).length });
  try { await lancerLot(clients); } finally { enCours.delete('all'); }
});

app.post('/api/scrape-all/stop', (req, res) => { stopAll = true; res.json({ ok: true }); });

// ---- Mise a jour ----------------------------------------------------------
app.get('/api/version', (req, res) => res.json({ version: versionLocale() }));
app.get('/api/update/check', async (req, res) => res.json(await verifierMaj()));
app.post('/api/update/apply', async (req, res) => {
  try { res.json(await appliquerMaj()); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- Historique -----------------------------------------------------------
app.get('/api/runs', (req, res) => res.json(listRuns(500)));
app.get('/api/status', (req, res) => res.json({ enCours: [...enCours], cabinets: cabinetsConfigure() }));

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => console.log(`\n  Impots pro scraper -> http://localhost:${PORT}\n`));
