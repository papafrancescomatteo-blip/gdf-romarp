const mongoose = require('mongoose');
const { Schema } = mongoose;

const ESITI = [
  'Eccellente',
  'Regolare',
  'Da migliorare',
  'Insufficiente',
  'Assente giustificato',
  'Assente ingiustificato',
];

const User = mongoose.model(
  'User',
  new Schema(
    {
      username: { type: String, unique: true, required: true, lowercase: true, trim: true },
      passwordHash: { type: String, required: true },
      mustChangePassword: { type: Boolean, default: true },
      nome: { type: String, trim: true, default: '' },
      cognome: { type: String, trim: true, default: '' },
      ruolo: { type: String, enum: ['finanziere', 'ufficiale', 'prefettura'], default: 'finanziere' },
      matricola: { type: String, trim: true, default: '' },
      grado: { type: Schema.Types.ObjectId, ref: 'Grado', default: null },
      attivo: { type: Boolean, default: true },
      discordId: { type: String, trim: true, default: '' },
    },
    { timestamps: true }
  )
);

const Grado = mongoose.model(
  'Grado',
  new Schema({
    nome: { type: String, required: true, trim: true },
    ordine: { type: Number, default: 0 }, // più alto = grado più alto
    immagine: { type: String, default: '' }, // es. /gradi/finanziere.png
  })
);

const Link = mongoose.model(
  'Link',
  new Schema(
    {
      sezione: { type: String, enum: ['direttive', 'linee_guida'], required: true },
      titolo: { type: String, required: true, trim: true },
      url: { type: String, required: true, trim: true },
      descrizione: { type: String, default: '', trim: true },
      ordine: { type: Number, default: 0 },
    },
    { timestamps: true }
  )
);

const Gestione = mongoose.model(
  'Gestione',
  new Schema(
    {
      settimana: { type: Date, required: true }, // lunedì della settimana
      etichetta: { type: String, default: '', trim: true },
      creataDa: { type: Schema.Types.ObjectId, ref: 'User' },
      voci: [
        {
          utente: { type: Schema.Types.ObjectId, ref: 'User' },
          ore: { type: Number, default: 0 },
          esito: { type: String, enum: ESITI },
          note: { type: String, default: '' },
        },
      ],
    },
    { timestamps: true }
  )
);

const Categoria = mongoose.model(
  'Categoria',
  new Schema({
    nome: { type: String, required: true, trim: true },
    tipo: { type: String, enum: ['avvertimento', 'sospensione', 'restrizione', 'promozione', 'merito', 'degradazione', 'licenziamento', 'altro'], default: 'avvertimento' },
  })
);

const Provvedimento = mongoose.model(
  'Provvedimento',
  new Schema(
    {
      utente: { type: Schema.Types.ObjectId, ref: 'User', required: true },
      categoria: { type: String, required: true },
      tipo: { type: String, enum: ['avvertimento', 'sospensione', 'restrizione', 'promozione', 'merito', 'degradazione', 'licenziamento', 'altro'], default: 'avvertimento' },
      motivo: { type: String, default: '' },
      emessoDa: { type: Schema.Types.ObjectId, ref: 'User' },
      dataScadenza: { type: Date, default: null },
      attivo: { type: Boolean, default: true },
      revocatoDa: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    },
    { timestamps: true }
  )
);

const Log = mongoose.model(
  'Log',
  new Schema(
    {
      azione: { type: String, required: true },
      descrizione: { type: String, default: '' },
      autore: { type: Schema.Types.ObjectId, ref: 'User' },
      bersaglio: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    },
    { timestamps: true }
  )
);

const Turno = mongoose.model(
  'Turno',
  new Schema(
    {
      utente: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
      inizio: { type: Date, required: true },
      fine: { type: Date, default: null },
      durataMin: { type: Number, default: 0 },
      chiusoDa: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    },
    { timestamps: true }
  )
);

const Setting = mongoose.model(
  'Setting',
  new Schema({ key: { type: String, unique: true }, value: String })
);

module.exports = { User, Grado, Link, Gestione, Categoria, Provvedimento, Log, Setting, Turno, ESITI };
