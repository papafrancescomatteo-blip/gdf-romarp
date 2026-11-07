# Portale Guardia di Finanza Roma RP

Node.js + Express + MongoDB (Atlas), deploy su Render.

## Ruoli
- **Finanziere**: direttive operative, propria matricola/grado, ultime 2 gestioni, avvertimenti/sospensioni, link supervisione allievi.
- **Ufficiale**: gestisce link (linee guida/direttive), gestioni settimanali, matricole e gradi, provvedimenti, utenti, registro attività, impostazioni.
- **Prefettura**: sola lettura di linee guida, direttive, ultime 3 gestioni e foglio matricole.

## Funzioni principali
- **Turni (shift)**: pulsante Inizia/Termina turno con timer; le ore alimentano in automatico le gestioni settimanali. Chi ha una sospensione attiva non può iniziare il turno.
- **Ruolo Discord automatico**: con `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_ROLE_SERVIZIO` il bot assegna/toglie il ruolo "In servizio". Il bot deve avere il permesso *Gestisci ruoli* e il suo ruolo sopra quello di servizio. Ogni utente ha un ID Discord impostato dagli ufficiali (pagina Utenti).
- **Matricole** nel formato `GF-xx`, assegnate in automatico se lasciate vuote.
- **Provvedimenti**: promozione/degradazione cambiano il grado, il licenziamento disattiva l'account, la sospensione blocca i turni.
- **Spalline**: file in `public/gradi/` chiamati come il grado (`finanziere-scelto.png`), collegati in automatico.

## Avvio in locale
```
cp .env.example .env   # compila MONGODB_URI
npm install
npm start
```
Al primo avvio viene creato un ufficiale (`ADMIN_USERNAME`/`ADMIN_PASSWORD`, oppure password casuale stampata nei log) che deve cambiare password al primo accesso.

## Deploy su Render
1. Carica la cartella su GitHub.
2. Render → New → Web Service (o Blueprint con `render.yaml`).
3. Build: `npm install` · Start: `npm start`.
4. Variabili: `MONGODB_URI`, `SESSION_SECRET`, `NODE_ENV=production`, opzionali `ADMIN_USERNAME`/`ADMIN_PASSWORD`.
5. Su MongoDB Atlas, in Network Access, consenti l'accesso da Render (0.0.0.0/0 se non hai IP fissi).

## Spalline
Metti le immagini in `public/gradi/` (vanno committate su GitHub: il disco di Render non è persistente) e imposta il percorso dalla pagina **Gradi**.
