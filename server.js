require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { User, Grado, Link, Gestione, Categoria, Provvedimento, Log, Setting, ESITI } = require('./models');

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
    const data = { title: 'Home' };
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
    const matricola = (req.body.matricola || '').trim();
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
    res.render('gestione-nuova', { title: 'Nuova gestione', finanzieri });
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
    const [lista, finanzieri, categorie] = await Promise.all([
      Provvedimento.find().sort({ createdAt: -1 }).limit(200).populate('utente emessoDa', 'nome cognome matricola'),
      User.find({ attivo: true, ruolo: { $ne: 'prefettura' } }).sort({ cognome: 1 }),
      Categoria.find().sort({ nome: 1 }),
    ]);
    res.render('provvedimenti', { title: 'Provvedimenti', lista, finanzieri, categorie });
  })
);

app.post(
  '/provvedimenti',
  need('ufficiale'),
  ah(async (req, res) => {
    const { utente, categoria, motivo, dataScadenza } = req.body;
    const cat = mongoose.isValidObjectId(categoria) ? await Categoria.findById(categoria) : null;
    const u = mongoose.isValidObjectId(utente) ? await User.findById(utente) : null;
    if (!cat || !u || !(motivo || '').trim()) {
      flash(req, 'Seleziona finanziere, categoria e indica il motivo.', 'err');
      return res.redirect('/provvedimenti');
    }
    await Provvedimento.create({
      utente: u._id,
      categoria: cat.nome,
      tipo: cat.tipo,
      motivo: motivo.trim().slice(0, 1000),
      emessoDa: req.user._id,
      dataScadenza: dataScadenza ? new Date(dataScadenza) : null,
    });
    await log(req, 'provvedimento_applicato', `${cat.nome} a ${nomeU(u)}: ${motivo.trim().slice(0, 200)}`, u._id);
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
    const { username, nome, cognome, ruolo, matricola, grado } = req.body;
    if (!username || !nome || !cognome || !['finanziere', 'ufficiale', 'prefettura'].includes(ruolo)) {
      flash(req, 'Compila username, nome, cognome e ruolo.', 'err');
      return res.redirect('/utenti');
    }
    if (await User.findOne({ username: username.toLowerCase().trim() })) {
      flash(req, 'Username già esistente.', 'err');
      return res.redirect('/utenti');
    }
    const pwd = tempPassword();
    const u = await User.create({
      username,
      nome,
      cognome,
      ruolo,
      matricola: (matricola || '').trim(),
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
    const gradi = [
      'Allievo Finanziere', 'Finanziere', 'Finanziere Scelto', 'Appuntato', 'Appuntato Scelto',
      'Vice Brigadiere', 'Brigadiere', 'Brigadiere Capo', 'Maresciallo', 'Maresciallo Ordinario',
      'Maresciallo Capo', 'Maresciallo Aiutante', 'Luogotenente', 'Sottotenente', 'Tenente',
      'Capitano', 'Maggiore', 'Tenente Colonnello', 'Colonnello', 'Generale',
    ];
    await Grado.insertMany(gradi.map((nome, i) => ({ nome, ordine: i + 1 })));
  }
  if (!(await Categoria.countDocuments())) {
    await Categoria.insertMany([
      { nome: 'Richiamo verbale', tipo: 'avvertimento' },
      { nome: 'Avvertimento scritto', tipo: 'avvertimento' },
      { nome: 'Sospensione', tipo: 'sospensione' },
    ]);
  }
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
