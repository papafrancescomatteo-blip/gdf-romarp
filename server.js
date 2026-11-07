require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { User, Grado, Link, Gestione, Categoria, Provvedimento, Log, Setting, Turno, ESITI } = require('./models');

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('Manca la variabile MONGODB_URI');
  process.exit(1);
}

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.locals.me = null;
app.locals.flash = null;
app.locals.csrf = '';
app.locals.path = '';
app.locals.ESITI = ESITI;
app.locals.d = (x) => (x ? new Date(x).toLocaleDateString('it-IT') : '—');
app.locals.dt = (x) => (x ? new Date(x).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—');
app.locals.fmtMin = (m) => `${Math.floor((m || 0) / 60)}h ${String((m || 0) % 60).padStart(2, '0')}m`;
app.locals.nomeCompleto = (u) => (u ? `${u.nome} ${u.cognome}`.trim() || u.username : '—');

app.use(express.urlencoded({ extended: true, limit: '200kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'cambia-questo-segreto',
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: MONGODB_URI }),
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 8,
    },
  })
);

const ah = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// ---------- contesto di sessione ----------
app.use(
  ah(async (req, res, next) => {
    if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
    res.locals.csrf = req.session.csrf;
    res.locals.flash = req.session.flash || null;
    delete req.session.flash;
    res.locals.path = req.path;
    res.locals.me = null;
    if (req.session.uid) {
      const u = await User.findById(req.session.uid).populate('grado');
      if (u && u.attivo) {
        req.user = u;
        res.locals.me = u;
      } else {
        req.session.uid = null;
      }
    }
    next();
  })
);

app.use((req, res, next) => {
  if (req.method === 'POST' && req.body._csrf !== req.session.csrf) {
    return res.status(403).render('errore', { msg: 'Sessione scaduta o richiesta non valida. Ricarica la pagina e riprova.' });
  }
  next();
});

const need = (...roles) => (req, res, next) => {
  if (!req.user) return res.redirect('/login');
  if (req.user.mustChangePassword && req.path !== '/password') return res.redirect('/password');
  if (roles.length && !roles.includes(req.user.ruolo)) {
    return res.status(403).render('errore', { msg: 'Non hai i permessi per accedere a questa sezione.' });
  }
  next();
};

const flash = (req, text, type = 'ok') => {
  req.session.flash = { text, type };
};
const log = (req, azione, descrizione, bersaglio = null) =>
  Log.create({ azione, descrizione, autore: req.user._id, bersaglio });
const getSetting = async (key) => (await Setting.findOne({ key }))?.value || '';
const setSetting = (key, value) => Setting.findOneAndUpdate({ key }, { value }, { upsert: true });
const isUrl = (s) => /^https?:\/\/\S+$/i.test(s || '');
const tempPassword = () => crypto.randomBytes(5).toString('hex');
const nomeU = (u) => (u ? `${u.nome} ${u.cognome}`.trim() || u.username : '—');

// matricola nel formato GF-xx ('' = vuota, null = non valida)
const normMatricola = (s) => {
  const t = String(s || '').trim().toUpperCase();
  if (!t) return '';
  const m = /^(?:GF-?)?(\d{1,4})$/.exec(t);
  return m ? `GF-${m[1].padStart(2, '0')}` : null;
};
const prossimaMatricola = async () => {
  const tutti = await User.find({ matricola: /^GF-\d+$/ }, 'matricola');
  const max = tutti.reduce((n, u) => Math.max(n, parseInt(u.matricola.slice(3), 10) || 0), 0);
  return `GF-${String(max + 1).padStart(2, '0')}`;
};

// settimane e turni
const lunedi = (d = new Date()) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
};
const isoDay = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const minutiRange = async (from, to, utente = null) => {
  const q = { inizio: { $gte: from, $lt: to } };
  if (utente) q.utente = utente;
  const out = {};
  for (const t of await Turno.find(q)) {
    const m = t.fine ? t.durataMin : Math.round((Date.now() - t.inizio) / 60000);
    out[t.utente] = (out[t.utente] || 0) + m;
  }
  return out;
};

// ruolo "In servizio" su Discord (opzionale: serve DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, DISCORD_ROLE_SERVIZIO)
const discordOn = () =>
  !!(process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_GUILD_ID && process.env.DISCORD_ROLE_SERVIZIO);
async function discordRole(user, add) {
  if (!discordOn() || !user.discordId) return { ok: false, skipped: true };
  try {
    const r = await fetch(
      `https://discord.com/api/v10/guilds/${process.env.DISCORD_GUILD_ID}/members/${user.discordId}/roles/${process.env.DISCORD_ROLE_SERVIZIO}`,
      {
        method: add ? 'PUT' : 'DELETE',
        headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`, 'X-Audit-Log-Reason': 'Turno GdF Roma RP' },
      }
    );
    return { ok: r.ok };
  } catch (e) {
    console.error('Discord:', e.message);
    return { ok: false };
  }
}
async function chiudiTurno(t, user, chiusoDa = null) {
  t.fine = new Date();
  t.durataMin = Math.max(0, Math.round((t.fine - t.inizio) / 60000));
  t.chiusoDa = chiusoDa;
  await t.save();
  return discordRole(user, false);
}

// spalline: collega public/gradi/<nome-del-grado>.png ai gradi senza immagine
const slug = (x) =>
  String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const ORDINE_CATEGORIE = [
  ['generali', 700],
  ['superiori', 600],
  ['inferiori', 500],
  ['subalterni', 400],
  ['sottufficiali', 300],
  ['qs', 200],
];
const baseCategoria = (cat) => (ORDINE_CATEGORIE.find(([k]) => slug(cat).includes(k)) || [0, 100])[1];
function leggiSpalline() {
  const root = path.join(__dirname, 'public', 'gradi');
  const out = [];
  const walk = (dir, cat) => {
    let voci = [];
    try {
      voci = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {}
    for (const v of voci) {
      const full = path.join(dir, v.name);
      if (v.isDirectory()) walk(full, cat || v.name);
      else if (/\.(png|jpe?g|webp|svg|gif)$/i.test(v.name)) {
        const rel = path.relative(root, full).split(path.sep).map(encodeURIComponent).join('/');
        out.push({ url: '/gradi/' + rel, stem: v.name.replace(/\.[^.]+$/, ''), categoria: cat || '' });
      }
    }
  };
  walk(root, '');
  return out;
}
async function syncSpalline(creaMancanti = false) {
  const files = leggiSpalline();
  const map = new Map(files.map((f) => [slug(f.stem), f]));
  const usati = new Set();
  let collegati = 0;
  let creati = 0;
  const senza = [];
  for (const g of await Grado.find()) {
    const f = map.get(slug(g.nome));
    if (f) {
      usati.add(slug(f.stem));
      let mod = false;
      if (!g.immagine) {
        g.immagine = f.url;
        collegati += 1;
        mod = true;
      }
      if (!g.categoria && f.categoria) {
        g.categoria = f.categoria;
        mod = true;
      }
      if (mod) await g.save();
    } else if (!g.immagine) senza.push(g.nome);
  }
  const nonAbbinati = files.filter((f) => !usati.has(slug(f.stem)));
  if (creaMancanti) {
    for (const f of nonAbbinati) {
      const nome = f.stem.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\p{L}/gu, (c) => c.toUpperCase());
      if (await Grado.exists({ nome })) continue;
      await Grado.create({ nome, immagine: f.url, categoria: f.categoria, ordine: baseCategoria(f.categoria) });
      creati += 1;
    }
  }
  return { collegati, creati, senza, file: files.length, nonAbbinati: creaMancanti ? [] : nonAbbinati.map((f) => f.stem) };
}

// ---------- login ----------
const tentativi = new Map();
app.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('login', { title: 'Accesso' });
});

app.post(
  '/login',
  ah(async (req, res) => {
    const ip = req.ip;
    const t = tentativi.get(ip) || { n: 0, until: 0 };
    if (t.until > Date.now()) {
      flash(req, 'Troppi tentativi. Riprova tra qualche minuto.', 'err');
      return res.redirect('/login');
    }
    const u = await User.findOne({ username: String(req.body.username || '').toLowerCase().trim() });
    const ok = u && u.attivo && (await bcrypt.compare(String(req.body.password || ''), u.passwordHash));
    if (!ok) {
      t.n += 1;
      if (t.n >= 6) {
        t.until = Date.now() + 5 * 60 * 1000;
        t.n = 0;
      }
      tentativi.set(ip, t);
      flash(req, 'Credenziali non valide.', 'err');
      return res.redirect('/login');
    }
    tentativi.delete(ip);
    req.session.regenerate((err) => {
      if (err) throw err;
      req.session.uid = String(u._id);
      req.session.csrf = crypto.randomBytes(24).toString('hex');
      res.redirect('/');
    });
  })
);

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.get('/password', need(), (req, res) => res.render('password', { title: 'Cambio password' }));
app.post(
  '/password',
  need(),
  ah(async (req, res) => {
    const { vecchia, nuova, conferma } = req.body;
    if (!(await bcrypt.compare(vecchia || '', req.user.passwordHash))) {
      flash(req, 'La password attuale non è corretta.', 'err');
      return res.redirect('/password');
    }
    if (!nuova || nuova.length < 8 || nuova !== conferma) {
      flash(req, 'La nuova password deve avere almeno 8 caratteri e coincidere con la conferma.', 'err');
      return res.redirect('/password');
    }
    req.user.passwordHash = await bcrypt.hash(nuova, 10);
    req.user.mustChangePassword = false;
    await req.user.save();
    flash(req, 'Password aggiornata.');
    res.redirect('/');
  })
);

// ---------- home ----------
app.get(
  '/',
  need(),
  ah(async (req, res) => {
    const r = req.user.ruolo;
    const data = { title: 'Home', turno: null, minSettimana: 0, discordOn: discordOn() };
    if (r !== 'prefettura') {
      data.turno = await Turno.findOne({ utente: req.user._id, fine: null });
      const da = lunedi();
      data.minSettimana = (await minutiRange(da, new Date(da.getTime() + 7 * 864e5), req.user._id))[req.user._id] || 0;
    }
    if (r === 'finanziere') {
      const gest = await Gestione.find({ 'voci.utente': req.user._id }).sort({ settimana: -1 }).limit(2);
      data.gestioni = gest.map((g) => ({
        settimana: g.settimana,
        etichetta: g.etichetta,
        voce: g.voci.find((v) => String(v.utente) === String(req.user._id)),
      }));
      data.provvedimenti = await Provvedimento.find({ utente: req.user._id, attivo: true }).sort({ createdAt: -1 });
      data.supervisioneUrl = await getSetting('supervisioneUrl');
      data.direttive = await Link.find({ sezione: 'direttive' }).sort({ ordine: 1, titolo: 1 });
    } else if (r === 'ufficiale') {
      data.nFinanzieri = await User.countDocuments({ ruolo: 'finanziere', attivo: true });
      data.nProvvAttivi = await Provvedimento.countDocuments({ attivo: true });
      data.inServizio = await Turno.countDocuments({ fine: null });
      data.ultimaGestione = await Gestione.findOne().sort({ settimana: -1 });
      data.logs = await Log.find().sort({ createdAt: -1 }).limit(6).populate('autore bersaglio');
      // finanzieri senza gestione nell'ultima settimana registrata
      if (data.ultimaGestione) {
        const inGestione = new Set(data.ultimaGestione.voci.map((v) => String(v.utente)));
        const tutti = await User.find({ ruolo: 'finanziere', attivo: true });
        data.mancanti = tutti.filter((u) => !inGestione.has(String(u._id)));
      }
      // sospensioni in scadenza / scadute ancora attive
      data.scadute = await Provvedimento.find({ attivo: true, dataScadenza: { $ne: null, $lt: new Date() } }).populate('utente');
    } else {
      data.gestioni = await Gestione.find().sort({ settimana: -1 }).limit(3);
      data.nFinanzieri = await User.countDocuments({ ruolo: 'finanziere', attivo: true });
    }
    res.render('home', data);
  })
);

// ---------- direttive e linee guida ----------
app.get(
  '/direttive',
  need(),
  ah(async (req, res) => {
    const sezioni = req.user.ruolo === 'finanziere' ? ['direttive'] : ['direttive', 'linee_guida'];
    const links = await Link.find({ sezione: { $in: sezioni } }).sort({ ordine: 1, titolo: 1 });
    res.render('direttive', { title: 'Direttive e linee guida', links, sezioni });
  })
);

app.post(
  '/direttive',
  need('ufficiale'),
  ah(async (req, res) => {
    const { sezione, titolo, url, descrizione, ordine } = req.body;
    if (!['direttive', 'linee_guida'].includes(sezione) || !titolo || !isUrl(url)) {
      flash(req, 'Compila titolo e inserisci un link valido (http/https).', 'err');
      return res.redirect('/direttive');
    }
    const l = await Link.create({ sezione, titolo, url, descrizione, ordine: Number(ordine) || 0 });
    await log(req, 'link_aggiunto', `Aggiunto "${l.titolo}" in ${sezione}`);
    flash(req, 'Link aggiunto.');
    res.redirect('/direttive');
  })
);

app.post(
  '/direttive/:id',
  need('ufficiale'),
  ah(async (req, res) => {
    const { titolo, url, descrizione, ordine } = req.body;
    if (!titolo || !isUrl(url)) {
      flash(req, 'Titolo o link non validi.', 'err');
      return res.redirect('/direttive');
    }
    const l = await Link.findByIdAndUpdate(req.params.id, { titolo, url, descrizione, ordine: Number(ordine) || 0 });
    if (l) await log(req, 'link_modificato', `Modificato "${titolo}"`);
    flash(req, 'Link aggiornato.');
    res.redirect('/direttive');
  })
);

app.post(
  '/direttive/:id/elimina',
  need('ufficiale'),
  ah(async (req, res) => {
    const l = await Link.findByIdAndDelete(req.params.id);
    if (l) await log(req, 'link_eliminato', `Eliminato "${l.titolo}"`);
    flash(req, 'Link eliminato.');
    res.redirect('/direttive');
  })
);

// ---------- foglio matricole ----------
app.get(
  '/matricole',
  need('ufficiale', 'prefettura'),
  ah(async (req, res) => {
    const utenti = await User.find({ attivo: true }).populate('grado');
    utenti.sort((a, b) => (b.grado?.ordine || 0) - (a.grado?.ordine || 0) || a.cognome.localeCompare(b.cognome));
    const gradi = await Grado.find().sort({ ordine: -1 });
    res.render('matricole', { title: 'Foglio matricole', utenti, gradi });
  })
);

app.post(
  '/matricole/:id',
  need('ufficiale'),
  ah(async (req, res) => {
    const u = await User.findById(req.params.id).populate('grado');
    if (!u) return res.redirect('/matricole');
    const matricola = normMatricola(req.body.matricola);
    if (matricola === null) {
      flash(req, 'La matricola deve avere il formato GF-xx (es. GF-07).', 'err');
      return res.redirect('/matricole');
    }
    if (matricola) {
      const dup = await User.findOne({ matricola, _id: { $ne: u._id } });
      if (dup) {
        flash(req, `La matricola ${matricola} è già assegnata a ${nomeU(dup)}.`, 'err');
        return res.redirect('/matricole');
      }
    }
    const nuovoGrado = mongoose.isValidObjectId(req.body.grado) ? await Grado.findById(req.body.grado) : null;
    const cambi = [];
    if (u.matricola !== matricola) cambi.push(`matricola ${u.matricola || '—'} → ${matricola || '—'}`);
    if (String(u.grado?._id || '') !== String(nuovoGrado?._id || '')) {
      cambi.push(`grado ${u.grado?.nome || '—'} → ${nuovoGrado?.nome || '—'}`);
    }
    u.matricola = matricola;
    u.grado = nuovoGrado?._id || null;
    await u.save();
    if (cambi.length) await log(req, 'matricola_modificata', `${nomeU(u)}: ${cambi.join('; ')}`, u._id);
    flash(req, 'Scheda aggiornata.');
    res.redirect('/matricole');
  })
);

// ---------- gestioni settimanali ----------
app.get(
  '/gestioni',
  need('ufficiale', 'prefettura'),
  ah(async (req, res) => {
    const limit = req.user.ruolo === 'prefettura' ? 3 : 60;
    const gestioni = await Gestione.find()
      .sort({ settimana: -1 })
      .limit(limit)
      .populate('voci.utente', 'nome cognome matricola')
      .populate('creataDa', 'nome cognome');
    res.render('gestioni', { title: 'Gestioni settimanali', gestioni });
  })
);

app.get(
  '/gestioni/nuova',
  need('ufficiale'),
  ah(async (req, res) => {
    const finanzieri = await User.find({ ruolo: 'finanziere', attivo: true }).populate('grado');
    finanzieri.sort((a, b) => (b.grado?.ordine || 0) - (a.grado?.ordine || 0) || a.cognome.localeCompare(b.cognome));
    const da = req.query.settimana ? lunedi(new Date(req.query.settimana + 'T12:00:00')) : lunedi();
    const mins = await minutiRange(da, new Date(da.getTime() + 7 * 864e5));
    const ore = {};
    finanzieri.forEach((u) => {
      ore[u._id] = Math.round(((mins[u._id] || 0) / 60) * 2) / 2;
    });
    res.render('gestione-nuova', { title: 'Nuova gestione', finanzieri, ore, settimana: isoDay(da) });
  })
);

app.post(
  '/gestioni',
  need('ufficiale'),
  ah(async (req, res) => {
    const { settimana, etichetta } = req.body;
    const voci = req.body.voci || {};
    const lista = Object.entries(voci)
      .filter(([id, v]) => mongoose.isValidObjectId(id) && ESITI.includes(v.esito))
      .map(([id, v]) => ({
        utente: id,
        ore: Math.max(0, Number(v.ore) || 0),
        esito: v.esito,
        note: String(v.note || '').trim().slice(0, 500),
      }));
    if (!settimana || !lista.length) {
      flash(req, 'Indica la settimana e compila almeno un finanziere (esito).', 'err');
      return res.redirect('/gestioni/nuova');
    }
    const g = await Gestione.create({
      settimana: new Date(settimana),
      etichetta: (etichetta || '').trim(),
      creataDa: req.user._id,
      voci: lista,
    });
    await log(req, 'gestione_creata', `Gestione settimanale del ${new Date(settimana).toLocaleDateString('it-IT')} (${lista.length} finanzieri)`);
    flash(req, 'Gestione salvata.');
    res.redirect('/gestioni');
  })
);

// ---------- provvedimenti ----------
app.get(
  '/provvedimenti',
  need('finanziere', 'ufficiale'),
  ah(async (req, res) => {
    if (req.user.ruolo === 'finanziere') {
      const miei = await Provvedimento.find({ utente: req.user._id }).sort({ createdAt: -1 }).populate('emessoDa', 'nome cognome');
      return res.render('provvedimenti-miei', { title: 'I miei provvedimenti', miei });
    }
    const [lista, finanzieri, categorie, gradi] = await Promise.all([
      Provvedimento.find().sort({ createdAt: -1 }).limit(200).populate('utente emessoDa', 'nome cognome matricola'),
      User.find({ attivo: true, ruolo: { $ne: 'prefettura' } }).sort({ cognome: 1 }),
      Categoria.find().sort({ nome: 1 }),
      Grado.find().sort({ ordine: -1 }),
    ]);
    res.render('provvedimenti', { title: 'Provvedimenti', lista, finanzieri, categorie, gradi });
  })
);

app.post(
  '/provvedimenti',
  need('ufficiale'),
  ah(async (req, res) => {
    const { utente, categoria, motivo, dataScadenza, grado } = req.body;
    const cat = mongoose.isValidObjectId(categoria) ? await Categoria.findById(categoria) : null;
    const u = mongoose.isValidObjectId(utente) ? await User.findById(utente) : null;
    if (!cat || !u || !(motivo || '').trim()) {
      flash(req, 'Seleziona finanziere, categoria e indica il motivo.', 'err');
      return res.redirect('/provvedimenti');
    }
    let extra = '';
    if (cat.tipo === 'promozione' || cat.tipo === 'degradazione') {
      const ng = mongoose.isValidObjectId(grado) ? await Grado.findById(grado) : null;
      if (!ng) {
        flash(req, 'Per promozioni e degradazioni scegli il nuovo grado.', 'err');
        return res.redirect('/provvedimenti');
      }
      const vecchio = u.grado ? (await Grado.findById(u.grado))?.nome : null;
      u.grado = ng._id;
      await u.save();
      extra = ` [${vecchio || '—'} → ${ng.nome}]`;
    }
    if (cat.tipo === 'licenziamento') {
      if (String(u._id) === String(req.user._id)) {
        flash(req, 'Non puoi licenziare te stesso.', 'err');
        return res.redirect('/provvedimenti');
      }
      const aperto = await Turno.findOne({ utente: u._id, fine: null });
      if (aperto) await chiudiTurno(aperto, u, req.user._id);
      u.attivo = false;
      await u.save();
      extra = ' [account disattivato]';
    }
    await Provvedimento.create({
      utente: u._id,
      categoria: cat.nome,
      tipo: cat.tipo,
      motivo: motivo.trim().slice(0, 1000) + extra,
      emessoDa: req.user._id,
      attivo: ['avvertimento', 'sospensione', 'restrizione'].includes(cat.tipo),
      dataScadenza: dataScadenza ? new Date(dataScadenza) : null,
    });
    await log(req, 'provvedimento_applicato', `${cat.nome} a ${nomeU(u)}: ${motivo.trim().slice(0, 200)}${extra}`, u._id);
    flash(req, 'Provvedimento registrato.');
    res.redirect('/provvedimenti');
  })
);

app.post(
  '/provvedimenti/:id/revoca',
  need('ufficiale'),
  ah(async (req, res) => {
    const p = await Provvedimento.findById(req.params.id).populate('utente');
    if (p && p.attivo) {
      p.attivo = false;
      p.revocatoDa = req.user._id;
      await p.save();
      await log(req, 'provvedimento_revocato', `Revocato/chiuso: ${p.categoria} a ${nomeU(p.utente)}`, p.utente._id);
    }
    flash(req, 'Provvedimento chiuso.');
    res.redirect('/provvedimenti');
  })
);

// ---------- turni (shift) ----------
app.post(
  '/turno/inizio',
  need('finanziere', 'ufficiale'),
  ah(async (req, res) => {
    if (await Turno.exists({ utente: req.user._id, fine: null })) {
      flash(req, 'Sei già in servizio.', 'err');
      return res.redirect('/');
    }
    const sosp = await Provvedimento.findOne({
      utente: req.user._id,
      tipo: 'sospensione',
      attivo: true,
      $or: [{ dataScadenza: null }, { dataScadenza: { $gt: new Date() } }],
    });
    if (sosp) {
      flash(req, `Sei sospeso dal servizio (${sosp.categoria}): non puoi iniziare un turno.`, 'err');
      return res.redirect('/');
    }
    await Turno.create({ utente: req.user._id, inizio: new Date() });
    const d = await discordRole(req.user, true);
    if (d.skipped || d.ok) flash(req, d.ok ? 'Turno iniziato: ruolo "In servizio" assegnato su Discord.' : 'Turno iniziato.');
    else flash(req, 'Turno iniziato, ma non sono riuscito ad assegnare il ruolo su Discord.', 'err');
    res.redirect('/');
  })
);

app.post(
  '/turno/fine',
  need('finanziere', 'ufficiale'),
  ah(async (req, res) => {
    const t = await Turno.findOne({ utente: req.user._id, fine: null });
    if (!t) {
      flash(req, 'Non hai un turno in corso.', 'err');
      return res.redirect('/');
    }
    const d = await chiudiTurno(t, req.user, req.user._id);
    const durata = app.locals.fmtMin(t.durataMin);
    if (d.skipped || d.ok) flash(req, `Turno concluso: ${durata}.${d.ok ? ' Ruolo "In servizio" rimosso.' : ''}`);
    else flash(req, `Turno concluso (${durata}), ma non sono riuscito a rimuovere il ruolo su Discord.`, 'err');
    res.redirect('/');
  })
);

app.get(
  '/turni',
  need('ufficiale'),
  ah(async (req, res) => {
    const aperti = await Turno.find({ fine: null }).populate({ path: 'utente', populate: { path: 'grado' } }).sort({ inizio: 1 });
    const da = lunedi();
    const mins = await minutiRange(da, new Date(da.getTime() + 7 * 864e5));
    const tutti = await User.find({ ruolo: 'finanziere', attivo: true }).populate('grado');
    const classifica = tutti.map((u) => ({ u, min: mins[u._id] || 0 })).sort((a, b) => b.min - a.min);
    res.render('turni', { title: 'Turni', aperti, classifica, da, discordOn: discordOn() });
  })
);

app.post(
  '/turni/:id/chiudi',
  need('ufficiale'),
  ah(async (req, res) => {
    const t = await Turno.findById(req.params.id).populate('utente');
    if (t && !t.fine) {
      await chiudiTurno(t, t.utente, req.user._id);
      await log(req, 'turno_chiuso_forzato', `Chiuso il turno di ${nomeU(t.utente)} (${app.locals.fmtMin(t.durataMin)})`, t.utente._id);
    }
    flash(req, 'Turno chiuso.');
    res.redirect('/turni');
  })
);

// ---------- registro (log) ----------
app.get(
  '/logs',
  need('ufficiale'),
  ah(async (req, res) => {
    const filtro = {};
    if (req.query.azione) filtro.azione = String(req.query.azione);
    const logs = await Log.find(filtro).sort({ createdAt: -1 }).limit(300).populate('autore bersaglio', 'nome cognome username');
    const azioni = await Log.distinct('azione');
    res.render('logs', { title: 'Registro attività', logs, azioni, azione: req.query.azione || '' });
  })
);

// ---------- utenti ----------
app.get(
  '/utenti',
  need('ufficiale'),
  ah(async (req, res) => {
    const utenti = await User.find().populate('grado').sort({ attivo: -1, cognome: 1 });
    const gradi = await Grado.find().sort({ ordine: -1 });
    res.render('utenti', { title: 'Utenti', utenti, gradi });
  })
);

app.post(
  '/utenti',
  need('ufficiale'),
  ah(async (req, res) => {
    const { username, nome, cognome, ruolo, matricola, grado, discordId } = req.body;
    if (!username || !nome || !cognome || !['finanziere', 'ufficiale', 'prefettura'].includes(ruolo)) {
      flash(req, 'Compila username, nome, cognome e ruolo.', 'err');
      return res.redirect('/utenti');
    }
    if (await User.findOne({ username: username.toLowerCase().trim() })) {
      flash(req, 'Username già esistente.', 'err');
      return res.redirect('/utenti');
    }
    let mat = normMatricola(matricola);
    if (mat === null) {
      flash(req, 'La matricola deve avere il formato GF-xx (es. GF-07).', 'err');
      return res.redirect('/utenti');
    }
    if (mat && (await User.exists({ matricola: mat }))) {
      flash(req, `La matricola ${mat} è già assegnata.`, 'err');
      return res.redirect('/utenti');
    }
    if (!mat && ruolo !== 'prefettura') mat = await prossimaMatricola();
    const pwd = tempPassword();
    const u = await User.create({
      username,
      nome,
      cognome,
      ruolo,
      discordId: /^\d{17,20}$/.test(discordId || '') ? discordId : '',
      matricola: mat,
      grado: mongoose.isValidObjectId(grado) ? grado : null,
      passwordHash: await bcrypt.hash(pwd, 10),
    });
    await log(req, 'utente_creato', `Creato ${u.username} (${ruolo})`, u._id);
    flash(req, `Utente ${u.username} creato. Password temporanea (mostrata una sola volta): ${pwd}`);
    res.redirect('/utenti');
  })
);

app.post(
  '/utenti/:id/ruolo',
  need('ufficiale'),
  ah(async (req, res) => {
    const u = await User.findById(req.params.id);
    if (u && ['finanziere', 'ufficiale', 'prefettura'].includes(req.body.ruolo)) {
      if (String(u._id) === String(req.user._id) && req.body.ruolo !== 'ufficiale') {
        flash(req, 'Non puoi togliere a te stesso il ruolo di ufficiale.', 'err');
        return res.redirect('/utenti');
      }
      const prima = u.ruolo;
      u.ruolo = req.body.ruolo;
      await u.save();
      if (prima !== u.ruolo) await log(req, 'ruolo_modificato', `${u.username}: ${prima} → ${u.ruolo}`, u._id);
    }
    flash(req, 'Ruolo aggiornato.');
    res.redirect('/utenti');
  })
);

app.post(
  '/utenti/:id/reset',
  need('ufficiale'),
  ah(async (req, res) => {
    const u = await User.findById(req.params.id);
    if (!u) return res.redirect('/utenti');
    const pwd = tempPassword();
    u.passwordHash = await bcrypt.hash(pwd, 10);
    u.mustChangePassword = true;
    await u.save();
    await log(req, 'password_reimpostata', `Reimpostata password di ${u.username}`, u._id);
    flash(req, `Nuova password temporanea per ${u.username}: ${pwd}`);
    res.redirect('/utenti');
  })
);

app.post(
  '/utenti/:id/discord',
  need('ufficiale'),
  ah(async (req, res) => {
    const id = String(req.body.discordId || '').trim();
    if (id && !/^\d{17,20}$/.test(id)) {
      flash(req, "L'ID Discord è un numero di 17-20 cifre.", 'err');
      return res.redirect('/utenti');
    }
    const u = await User.findByIdAndUpdate(req.params.id, { discordId: id });
    if (u) await log(req, 'discord_collegato', `${u.username}: ID Discord ${id || 'rimosso'}`, u._id);
    flash(req, 'ID Discord aggiornato.');
    res.redirect('/utenti');
  })
);

app.post(
  '/utenti/:id/attivo',
  need('ufficiale'),
  ah(async (req, res) => {
    const u = await User.findById(req.params.id);
    if (!u) return res.redirect('/utenti');
    if (String(u._id) === String(req.user._id)) {
      flash(req, 'Non puoi disattivare il tuo account.', 'err');
      return res.redirect('/utenti');
    }
    u.attivo = !u.attivo;
    await u.save();
    await log(req, u.attivo ? 'utente_riattivato' : 'utente_disattivato', u.username, u._id);
    flash(req, u.attivo ? 'Utente riattivato.' : 'Utente disattivato.');
    res.redirect('/utenti');
  })
);

// ---------- gradi ----------
app.get(
  '/gradi',
  need('ufficiale'),
  ah(async (req, res) => {
    const gradi = await Grado.find().sort({ ordine: -1 });
    res.render('gradi', { title: 'Gradi', gradi });
  })
);

app.post(
  '/gradi',
  need('ufficiale'),
  ah(async (req, res) => {
    const { nome, ordine, immagine } = req.body;
    if (!nome) {
      flash(req, 'Indica il nome del grado.', 'err');
      return res.redirect('/gradi');
    }
    await Grado.create({ nome, ordine: Number(ordine) || 0, immagine: (immagine || '').trim() });
    await log(req, 'grado_aggiunto', nome);
    flash(req, 'Grado aggiunto.');
    res.redirect('/gradi');
  })
);

app.post(
  '/gradi/sync',
  need('ufficiale'),
  ah(async (req, res) => {
    const r = await syncSpalline(req.body.crea === '1');
    if (!r.file) flash(req, 'Nessuna immagine trovata in public/gradi (sottocartelle comprese).', 'err');
    else {
      let msg = `Collegate ${r.collegati} spalline` + (r.creati ? `, creati ${r.creati} gradi nuovi` : '') + '.';
      if (r.nonAbbinati.length) msg += ` File senza grado corrispondente: ${r.nonAbbinati.join(', ')}. Rinominali come il grado oppure usa "Crea i gradi mancanti".`;
      flash(req, msg);
    }
    res.redirect('/gradi');
  })
);

app.post(
  '/gradi/:id',
  need('ufficiale'),
  ah(async (req, res) => {
    const { nome, ordine, immagine } = req.body;
    await Grado.findByIdAndUpdate(req.params.id, { nome, ordine: Number(ordine) || 0, immagine: (immagine || '').trim() });
    await log(req, 'grado_modificato', nome);
    flash(req, 'Grado aggiornato.');
    res.redirect('/gradi');
  })
);

app.post(
  '/gradi/:id/elimina',
  need('ufficiale'),
  ah(async (req, res) => {
    if (await User.exists({ grado: req.params.id })) {
      flash(req, 'Impossibile eliminare: ci sono utenti con questo grado.', 'err');
      return res.redirect('/gradi');
    }
    const g = await Grado.findByIdAndDelete(req.params.id);
    if (g) await log(req, 'grado_eliminato', g.nome);
    flash(req, 'Grado eliminato.');
    res.redirect('/gradi');
  })
);

// ---------- impostazioni ----------
app.get(
  '/impostazioni',
  need('ufficiale'),
  ah(async (req, res) => {
    res.render('impostazioni', {
      title: 'Impostazioni',
      supervisioneUrl: await getSetting('supervisioneUrl'),
      categorie: await Categoria.find().sort({ nome: 1 }),
    });
  })
);

app.post(
  '/impostazioni',
  need('ufficiale'),
  ah(async (req, res) => {
    const url = (req.body.supervisioneUrl || '').trim();
    if (url && !isUrl(url)) {
      flash(req, 'Link non valido.', 'err');
      return res.redirect('/impostazioni');
    }
    await setSetting('supervisioneUrl', url);
    await log(req, 'impostazioni_modificate', 'Aggiornato link supervisione allievi');
    flash(req, 'Impostazioni salvate.');
    res.redirect('/impostazioni');
  })
);

app.post(
  '/impostazioni/categorie',
  need('ufficiale'),
  ah(async (req, res) => {
    const { nome, tipo } = req.body;
    if (!nome || !['avvertimento', 'sospensione', 'altro'].includes(tipo)) {
      flash(req, 'Indica nome e tipo.', 'err');
      return res.redirect('/impostazioni');
    }
    await Categoria.create({ nome, tipo });
    await log(req, 'categoria_aggiunta', nome);
    flash(req, 'Categoria aggiunta.');
    res.redirect('/impostazioni');
  })
);

app.post(
  '/impostazioni/categorie/:id/elimina',
  need('ufficiale'),
  ah(async (req, res) => {
    const c = await Categoria.findByIdAndDelete(req.params.id);
    if (c) await log(req, 'categoria_eliminata', c.nome);
    flash(req, 'Categoria eliminata.');
    res.redirect('/impostazioni');
  })
);

// ---------- errori ----------
app.use((req, res) => res.status(404).render('errore', { msg: 'Pagina non trovata.' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('errore', { msg: 'Errore interno del server.' });
});

// ---------- avvio e dati iniziali ----------
async function seed() {
  if (!(await Grado.countDocuments())) {
    const S = 'Sottufficiali', Q = 'QS';
    const gradi = [
      ['Allievo Finanziere', S], ['Finanziere', S], ['Finanziere Scelto', S], ['Appuntato', S],
      ['Appuntato Scelto', S], ['Appuntato Scelto QS', Q], ['Vice Brigadiere', S], ['Brigadiere', S],
      ['Brigadiere Capo', S], ['Brigadiere Capo QS', Q], ['Maresciallo', S], ['Maresciallo Ordinario', S],
      ['Maresciallo Capo', S], ['Maresciallo Aiutante', S], ['Luogotenente', S],
      ['Sottotenente', 'Ufficiali Subalterni'], ['Tenente', 'Ufficiali Subalterni'],
      ['Capitano', 'Ufficiali Inferiori'],
      ['Maggiore', 'Ufficiali Superiori'], ['Tenente Colonnello', 'Ufficiali Superiori'], ['Colonnello', 'Ufficiali Superiori'],
      ['Generale di Brigata', 'Ufficiali Generali'], ['Generale di Divisione', 'Ufficiali Generali'],
      ["Generale di Corpo d'Armata", 'Ufficiali Generali'],
    ];
    await Grado.insertMany(gradi.map(([nome, categoria], i) => ({ nome, categoria, ordine: i + 1 })));
  }
  const categorie = [
    ['Promozione', 'promozione'],
    ['Nota di Merito', 'merito'],
    ['Degradazione', 'degradazione'],
    ['Licenziamento', 'licenziamento'],
    ['Avvertimento Inattività', 'avvertimento'],
    ['Messaggio DM', 'altro'],
    ['N/A', 'altro'],
    ['Inattività Concordata', 'altro'],
    ['Avvertimento', 'avvertimento'],
    ['Sospensione dalla Guida', 'restrizione'],
    ['Sospensione', 'sospensione'],
    ['Avvertimento+Messaggio DM', 'avvertimento'],
    ['Sospensione dal Serv. + Avv.', 'sospensione'],
  ];
  for (const [nome, tipo] of categorie) {
    if (!(await Categoria.exists({ nome }))) await Categoria.create({ nome, tipo });
  }
  await syncSpalline();
  if (!(await User.exists({ ruolo: 'ufficiale' }))) {
    const username = (process.env.ADMIN_USERNAME || 'admin').toLowerCase();
    const pwd = process.env.ADMIN_PASSWORD || tempPassword();
    await User.create({
      username,
      nome: 'Comando',
      cognome: 'Generale',
      ruolo: 'ufficiale',
      passwordHash: await bcrypt.hash(pwd, 10),
    });
    console.log('==============================================');
    console.log(`Creato primo ufficiale: ${username} / ${pwd}`);
    console.log('Al primo accesso verrà chiesto di cambiare la password.');
    console.log('==============================================');
  }
}

mongoose
  .connect(MONGODB_URI)
  .then(seed)
  .then(() => {
    const port = process.env.PORT || 3000;
    app.listen(port, () => console.log(`Portale GdF Roma RP in ascolto sulla porta ${port}`));
  })
  .catch((e) => {
    console.error('Errore di avvio:', e);
    process.exit(1);
  });
