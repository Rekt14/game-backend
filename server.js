// server.js
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const { MongoClient, ObjectId } = require("mongodb");

const gameStates = {};

const pendingInvitations = {}; // { inviterSocketId: { invitedSocketId: string, timeoutId: Timeout } }

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});
  
// DB setup
const uri = process.env.MONGO_URI;
const dbName = "gameDB";
let recordsCollection;
let matchesCollection;
let onlinePlayersCollection;

app.use(cors());
app.use(express.json());

async function connectToDatabase() {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);
  recordsCollection = db.collection("records");
  matchesCollection = db.collection("matches");
  onlinePlayersCollection = db.collection("onlinePlayers");
  console.log("✅ Connesso a MongoDB");
}

// 🌐 REST API
app.post("/records", async (req, res) => {
  const { name, score } = req.body;
  if (!name || typeof score !== "number") return res.status(400).send("Dati non validi");
  try {
    const result = await recordsCollection.insertOne({ name, score, date: new Date() });
    res.status(200).json({ message: "Record salvato!", id: result.insertedId });
  } catch (err) {
    res.status(500).send("Errore nel salvataggio");
  }
});

app.get("/records", async (req, res) => {
  try {
    const records = await recordsCollection.find().sort({ score: -1, date: 1 }).limit(5).toArray();
    res.status(200).json(records);
  } catch (err) {
    res.status(500).send("Errore nel recupero");
  }
});

// ✅ Nuova API: numero giocatori online
app.get("/online-players", async (req, res) => {
    try {
        const cutoff = new Date(Date.now() - 30 * 1000);
        await onlinePlayersCollection.deleteMany({ lastSeen: { $lt: cutoff } });

        // Includiamo isInGame nella projection
        const onlinePlayers = await onlinePlayersCollection.find({}, { projection: { name: 1, socketId: 1, isInGame: 1, _id: 0 } }).toArray();

        res.json({ online: onlinePlayers.length, players: onlinePlayers });
    } catch (err) {
        console.error("❌ Errore nel conteggio/recupero giocatori online:", err);
        res.status(500).send("Errore nel recupero dei giocatori online");
    }
});

// 🎮 Socket.io - gestione giocatori online e game logic
io.on("connection", (socket) => {
    console.log("🟢 Connessione socket:", socket.id);
    let heartbeatInterval; // Dichiarata nello scope di 'connection'

    // ✅ Registrazione giocatore online
    socket.on("registerPlayer", async (name) => {
        console.log(`🧍 Registrazione giocatore: ${name} (${socket.id})`);
        try {
            await onlinePlayersCollection.insertOne({
                socketId: socket.id,
                name,
                lastSeen: new Date(),
                isInGame: false // Aggiunto questo campo
            });

            socket.data.name = name;
            socket.data.isInGame = false; // Inizializza anche socket.data

            heartbeatInterval = setInterval(async () => {
                await onlinePlayersCollection.updateOne(
                    { socketId: socket.id },
                    { $set: { lastSeen: new Date() } }
                );
            }, 10000);
        } catch (err) {
            console.error("❌ Errore registrazione giocatore:", err);
            socket.emit("gameError", "Errore durante la registrazione del giocatore.");
        }
    });

    // --- NUOVE IMPLEMENTAZIONI PER GLI INVITI ---

    // 1. Invio di un invito
    socket.on("sendInvitation", async ({ invitedSocketId }) => {
        const inviterName = socket.data.name;
        const inviterSocketId = socket.id;

        if (!inviterName) {
            console.warn(`[SERVER] Invitante senza nome (socket: ${inviterSocketId}) ha tentato di inviare un invito.`);
            socket.emit("gameError", "Errore: nome invitante non disponibile.");
            return;
        }

        if (inviterSocketId === invitedSocketId) {
            socket.emit("gameError", "Non puoi invitare te stesso!");
            return;
        }

        const inviterData = await onlinePlayersCollection.findOne({ socketId: inviterSocketId });
        const invitedData = await onlinePlayersCollection.findOne({ socketId: invitedSocketId });

        if (!invitedData) {
            socket.emit("gameError", "Il giocatore che hai invitato non è più online.");
            return;
        }

        if (inviterData.isInGame || invitedData.isInGame) {
            socket.emit("gameError", "Uno dei giocatori è già in partita.");
            return;
        }

        // Pulisci un eventuale invito precedente da questo invitante
        if (pendingInvitations[inviterSocketId]) {
            clearTimeout(pendingInvitations[inviterSocketId].timeoutId);
            delete pendingInvitations[inviterSocketId];
        }

        const INVITE_TIMEOUT_MS = 60000; // 60 secondi

        const invitationTimeout = setTimeout(() => {
            io.to(inviterSocketId).emit("invitationExpired", {
                invitedName: invitedData.name
            });
            // Non inviamo all'invitato qui, la sua UI gestirà il countdown
            console.log(`⏳ Invito da ${inviterName} a ${invitedData.name} scaduto.`);
            delete pendingInvitations[inviterSocketId];
        }, INVITE_TIMEOUT_MS);

        pendingInvitations[inviterSocketId] = {
            invitedSocketId: invitedSocketId,
            timeoutId: invitationTimeout,
            invitedPlayerName: invitedData.name // Salva il nome per il feedback
        };

        console.log(`✉️ Invito inviato da ${inviterName} (${inviterSocketId}) a ${invitedData.name} (${invitedSocketId})`);

        io.to(invitedSocketId).emit("receiveInvitation", {
            inviterName: inviterName,
            inviterSocketId: inviterSocketId,
            timeout: INVITE_TIMEOUT_MS // Invia il timeout anche al client per il conto alla rovescia
        });
        socket.emit("invitationSent", { invitedName: invitedData.name });
    });

    // 2. Accettazione di un invito
    socket.on("acceptInvitation", async ({ inviterSocketId }) => {
        // Cancella il timeout dell'invito in sospeso
        if (pendingInvitations[inviterSocketId]) {
            clearTimeout(pendingInvitations[inviterSocketId].timeoutId);
            delete pendingInvitations[inviterSocketId];
            console.log(`✅ Invito da ${inviterSocketId} accettato, timeout cancellato.`);
        }

        const invitedPlayerName = socket.data.name;
        const invitedPlayerSocketId = socket.id;

        const inviter = await onlinePlayersCollection.findOne({ socketId: inviterSocketId });

        if (!inviter) {
            socket.emit("gameError", "Il giocatore che ti ha invitato non è più online o ha annullato l'invito.");
            return;
        }

        if (inviter.isInGame || socket.data.isInGame) {
            socket.emit("gameError", "Uno dei giocatori è già in una partita.");
            return;
        }

        const roomCode = Math.floor(1000 + Math.random() * 9000).toString();

        try {
            await matchesCollection.insertOne({
                roomCode,
                players: [
                    { socketId: inviter.socketId, name: inviter.name },
                    { socketId: invitedPlayerSocketId, name: invitedPlayerName }
                ],
                createdAt: new Date()
            });

            const inviterSocket = io.sockets.sockets.get(inviter.socketId);
            if (inviterSocket) {
                inviterSocket.join(roomCode);
                inviterSocket.data.roomCode = roomCode;
                inviterSocket.data.name = inviter.name;
                inviterSocket.data.isInGame = true; // Aggiorna la socket.data
                await onlinePlayersCollection.updateOne({ socketId: inviter.socketId }, { $set: { isInGame: true } });
                console.log(`🛠️ ${inviter.name} (invitante) unito a stanza ${roomCode}. isInGame: true.`);
            } else {
                console.error(`[SERVER ERROR] Socket invitante ${inviter.socketId} non trovata per unirsi alla stanza.`);
                socket.emit("gameError", "Errore nell'unione alla stanza (invitante non trovato).");
                return;
            }

            socket.join(roomCode);
            socket.data.roomCode = roomCode;
            socket.data.name = invitedPlayerName;
            socket.data.isInGame = true; // Aggiorna la socket.data
            await onlinePlayersCollection.updateOne({ socketId: invitedPlayerSocketId }, { $set: { isInGame: true } });
            console.log(`👥 ${invitedPlayerName} (invitato) unito a stanza ${roomCode}. isInGame: true.`);

            // Evento rinominato da "bothPlayersReady" a "gameReady"
            io.to(roomCode).emit("gameReady", {
                opponent1: inviter.name,
                opponent2: invitedPlayerName,
                creatorSocketId: inviter.socketId,
                roomCode: roomCode
            });

            console.log(`🎉 Stanza ${roomCode} creata e giocatori ${inviter.name} e ${invitedPlayerName} uniti.`);

        } catch (err) {
            console.error("❌ Errore creazione/unione stanza su accettazione invito:", err);
            socket.emit("gameError", "Errore durante l'accettazione dell'invito.");
        }
    });

    // 3. Rifiuto di un invito
    socket.on("declineInvitation", async ({ inviterSocketId }) => {
        // Cancella il timeout dell'invito in sospeso
        if (pendingInvitations[inviterSocketId]) {
            clearTimeout(pendingInvitations[inviterSocketId].timeoutId);
            const invitedPlayerName = pendingInvitations[inviterSocketId].invitedPlayerName; // Recupera il nome
            delete pendingInvitations[inviterSocketId];
            console.log(`🚫 Invito da ${inviterSocketId} rifiutato, timeout cancellato.`);

            // Notifica l'invitante che l'invito è stato rifiutato
            io.to(inviterSocketId).emit("invitationDeclined", {
                declinerName: invitedPlayerName
            });
            console.log(`🚫 Invito da ${inviterSocketId} rifiutato da ${invitedPlayerName}`);

        } else {
            console.log(`🚫 Invito rifiutato da ${socket.id}, ma invito originale non trovato (invitante ${inviterSocketId}).`);
            // Potrebbe essere stato un invito già scaduto o annullato dal mittente
        }
    });

    // --- FINE IMPLEMENTAZIONI INVITI ---


    // 🎮 Crea stanza multiplayer (MODIFICA: Aggiungi isInGame update)
    socket.on("createRoom", async ({ name }, callback) => {
        const roomCode = Math.floor(1000 + Math.random() * 9000).toString();
        try {
            await matchesCollection.insertOne({
                roomCode,
                players: [{ socketId: socket.id, name }],
                createdAt: new Date()
            });

            socket.join(roomCode);
            socket.data.name = name;
            socket.data.roomCode = roomCode;
            socket.data.isInGame = true; // Imposta isInGame a true
            await onlinePlayersCollection.updateOne({ socketId: socket.id }, { $set: { isInGame: true } });


            console.log(`🛠️ Stanza creata: ${roomCode} da ${name}. isInGame: true.`);
            callback({ success: true, roomCode });
        } catch (err) {
            console.error("❌ Errore creazione stanza:", err);
            socket.emit("gameError", "Errore durante la creazione della stanza.");
            callback({ success: false, error: "Errore creazione stanza" });
        }
    });

    // 🎮 Unisciti a una stanza esistente (MODIFICA: Aggiungi isInGame update e cambia evento)
    socket.on("joinRoom", async ({ name, roomCode }, callback) => {
        const match = await matchesCollection.findOne({ roomCode });

        if (!match) return callback({ success: false, error: "Stanza non trovata" });
        if (match.players.length >= 2) return callback({ success: false, error: "Stanza piena" });

        try {
            await matchesCollection.updateOne(
                { roomCode },
                { $push: { players: { socketId: socket.id, name } } }
            );

            socket.join(roomCode);
            socket.data.name = name;
            socket.data.roomCode = roomCode;
            socket.data.isInGame = true; // Imposta isInGame a true
            await onlinePlayersCollection.updateOne({ socketId: socket.id }, { $set: { isInGame: true } });

            const otherPlayer = match.players[0]; // Creatore stanza
            const opponentName = otherPlayer.name;

            // Aggiorna lo stato isInGame dell'altro giocatore se necessario (dovrebbe essere già true se ha creato)
            await onlinePlayersCollection.updateOne({ socketId: otherPlayer.socketId }, { $set: { isInGame: true } });

            // 🔔 Notifica entrambi i giocatori + invia socketId creatore (MODIFICA: usa "gameReady")
            io.to(roomCode).emit("gameReady", {
                opponent1: opponentName,
                opponent2: name,
                creatorSocketId: otherPlayer.socketId,
                roomCode: roomCode // Aggiungi roomCode anche qui
            });

            console.log(`👥 ${name} si è unito alla stanza ${roomCode} con ${opponentName}. isInGame: true.`);
            callback({ success: true });
        } catch (err) {
            console.error("❌ Errore unione stanza:", err);
            socket.emit("gameError", "Errore durante l'unione alla stanza.");
            callback({ success: false, error: "Errore unione stanza" });
        }
    });

  // --- START OF GAME LOGIC ---

  
// Backend: nel tuo file server.js
socket.on("startRoundRequest", async () => {
    const roomCode = socket.data?.roomCode;
    if (!roomCode) return;

    // Recupera lo stato del gioco per la stanza
    let game = gameStates[roomCode];

    // Se lo stato del gioco non esiste ancora (es. è il primissimo avvio del gioco, round 0)
    if (!game) {
        // Inizializza un nuovo stato del gioco. 'round' è 0 perché sarà incrementato a 1
        // 'nextRoundReadyCount' è 0, sarà incrementato a 1 con questa richiesta
        game = {
            round: 0, 
            players: {}, 
            nextRoundReadyCount: 0, 
            lastRoundWinner: null 
        };
        gameStates[roomCode] = game; 
    }

    // Incrementa il contatore di prontezza per il prossimo round per questo giocatore
    game.nextRoundReadyCount++;

    // Se entrambi i giocatori sono pronti (il contatore ha raggiunto 2)
    if (game.nextRoundReadyCount === 2) {
        // Resetta il contatore per il prossimo utilizzo (per il round successivo)
        game.nextRoundReadyCount = 0;

        // Recupera i dettagli dei giocatori dalla collezione 'matches'
        const room = await matchesCollection.findOne({ roomCode });
        if (!room || room.players.length < 2) {
            console.error(`[SERVER ERROR] Stanza ${roomCode} non valida o non ha 2 giocatori per avviare il round.`);
            return;
        }
        const [player1, player2] = room.players; // Ottieni i socketId e nomi dei giocatori

        // Il round attuale sarà il precedente + 1
        const round = game.round + 1; 

        const suits = ["Denari", "Spade", "Bastoni", "Coppe"];
        const values = [2, 3, 4, 5, 6, 7, "Fante", "Cavallo", "Re", "Asso"];
        let deck = [];
        for (let suit of suits) {
            for (let value of values) {
                deck.push({ suit, value });
            }
        }
        deck = deck.sort(() => Math.random() - 0.5);

        // La determinazione di firstPlayerForThisRound
        let firstPlayerForThisRound;
        if (game.lastRoundWinner) { 
            firstPlayerForThisRound = game.lastRoundWinner; 
        } else {
            firstPlayerForThisRound = Math.random() < 0.5 ? player1.socketId : player2.socketId;
        }
        
        const p1Cards = deck.splice(0, round);
        p1Cards.forEach(card => card.played = false); 
        const p2Cards = deck.splice(0, round);
        p2Cards.forEach(card => card.played = false);

        // Aggiornamento dello stato del gioco 'gameStates[roomCode]'
        game.round = round; 
        game.deck = deck;
        game.players = { 
            [player1.socketId]: {
                name: player1.name,
                hand: p1Cards,
                bet: "",
                playedCard: null,
                score: game.players[player1.socketId]?.score || 0, 
                currentRoundWins: 0,
                revealedCardsCount: 0
            },
            [player2.socketId]: {
                name: player2.name,
                hand: p2Cards,
                bet: "",
                playedCard: null,
                score: game.players[player2.socketId]?.score || 0, 
                currentRoundWins: 0,
                revealedCardsCount: 0
            }
        };
        game.firstToReveal = firstPlayerForThisRound;
        game.lastRoundWinner = null; // Resetta per il nuovo round

        // Emissione di 'startRoundData' a entrambi i giocatori
        io.to(player1.socketId).emit("startRoundData", {
            round,
            yourCards: p1Cards,
            opponent1Cards: round === 1 ? p2Cards : Array(round).fill(null),
            firstToReveal: firstPlayerForThisRound,
            opponentName: player2.name
        });

        io.to(player2.socketId).emit("startRoundData", {
            round,
            yourCards: p2Cards,
            opponent1Cards: round === 1 ? p1Cards : Array(round).fill(null),
            firstToReveal: firstPlayerForThisRound,
            opponentName: player1.name
        });

        console.log(`🎯 Round ${round} avviato nella stanza ${roomCode} per entrambi i giocatori.`);

    } else {
        // Un giocatore è pronto, ma l'altro no.
        // Emette l'evento 'waitingForOpponentReady' al giocatore che HA cliccato per fargli sapere che è in attesa.
        socket.emit("waitingForOpponentReady", { forPlayer: "self" }); 
        
        // Trova l'ID dell'altro giocatore nella stanza
        const room = await matchesCollection.findOne({ roomCode });
        const otherPlayer = room.players.find(p => p.socketId !== socket.id);

        if (otherPlayer) {
            // Emette l'evento 'waitingForOpponentReady' all'ALTRO giocatore,
            // con un flag diverso per indicare che è l'altro a essere in attesa.
            io.to(otherPlayer.socketId).emit("waitingForOpponentReady", { forPlayer: "opponent" });
        }
    }
    
    // Salva lo stato del gioco aggiornato nel DB (questo dovrebbe essere alla fine di ogni modifica allo stato)
    if (typeof matchesCollection !== 'undefined') {
        try {
            await matchesCollection.updateOne(
                { roomCode: roomCode },
                { $set: { gameState: game } }
            );
        } catch (error) {
            console.error(`[SERVER ERROR] Errore salvando lo stato del gioco per la stanza ${roomCode}:`, error);
        }
    } else {
        console.error("matchesCollection non inizializzata. Impossibile salvare lo stato.");
    }
});

socket.on("playerBet", ({ roomCode, bet }) => {
    const game = gameStates[roomCode];
    if (!game || !game.players[socket.id]) {
        return;
    }

    game.players[socket.id].bet = bet;

    const playerIds = Object.keys(game.players);
    const allBets = playerIds.map(id => game.players[id].bet);

    if (allBets.every(b => b !== "")) {
        playerIds.forEach(playerId => {
            const opponentId = playerIds.find(id => id !== playerId);
            io.to(playerId).emit("bothBetsPlaced", {
                yourBet: game.players[playerId].bet,
                opponentBet: game.players[opponentId].bet
            });
        });
        return;
    }

    const otherId = playerIds.find(id => id !== socket.id);
    const otherPlayer = game.players[otherId];
    
    // Questa condizione implica che "otherPlayer.bet !== """ non richiede alcuna azione.
    // L'else if è stato rimosso in quanto non necessario e non esegue alcuna azione.
    if (otherPlayer && otherPlayer.bet === "") {
        io.to(otherId).emit("opponentBetPlaced", {
            opponentBet: bet
        });
    }
});

const valuePoints = {  
  2: 2,
  3: 3,
  4: 4,
  5: 5,
  6: 6,
  7: 7,
  Fante: 8,
  Cavallo: 9,
  Re: 10,
  Asso: 11};
  
const suitStrength = { 
  Denari: 4,
  Spade: 3,
  Bastoni: 2,
  Coppe: 1
};

function compareCards(c1, c2) {
    const v1 = valuePoints[c1.value];
    const v2 = valuePoints[c2.value];
    if (v1 === v2) {
        return suitStrength[c1.suit] > suitStrength[c2.suit];
    }
    return v1 > v2;
}

  async function processPlayedCards(roomCode, io) {
    let game = gameStates[roomCode];
    if (!game) return;

    const playerIds = Object.keys(game.players);
    const player1Id = playerIds[0];
    const player2Id = playerIds[1];

    const player1 = game.players[player1Id];
    const player2 = game.players[player2Id];

    // Catturiamo le carte e gli indici giocati nell'ultima mano PRIMA del reset
    const card1 = player1.playedCard;
    const card2 = player2.playedCard;
    const card1Index = player1.playedCardIndex;
    const card2Index = player2.playedCardIndex;

    // 1. Determina il vincitore della mano
    const player1WinsHand = compareCards(card1, card2); // Assumi che compareCards sia definita altrove
    const handWinnerId = player1WinsHand ? player1Id : player2Id;

    // Aggiorna i conteggi delle mani vinte
    if (player1WinsHand) {
        player1.currentRoundWins++;
    } else {
        player2.currentRoundWins++;
    }

    // È questo che determina chi inizierà la PROSSIMA MANO all'interno dello stesso round.
    game.firstToReveal = handWinnerId;

    // 2. Notifica entrambi i giocatori del risultato della mano
    io.to(roomCode).emit("handResult", {
        winnerId: handWinnerId,
        player1Card: card1,
        player2Card: card2,
        player1Id: player1Id,
        player2Id: player2Id,
        player1Wins: player1.currentRoundWins,
        player2Wins: player2.currentRoundWins
    });

    // 3. Resetta le carte giocate per il prossimo turno/mano
    // Questo reset avviene DOPO che le carte e gli indici sono stati catturati
    player1.playedCard = null;
    player1.playedCardIndex = null;
    player2.playedCard = null;
    player2.playedCardIndex = null;

    // 4. Controlla se il round è finito (tutte le carte sono state giocate)
    if (player1.revealedCardsCount === game.round && player2.revealedCardsCount === game.round) {
        // IL ROUND È TERMINATO
        // Calcola e assegna i punteggi del round
        if (player1.currentRoundWins === player1.bet) {
            player1.score += (10 + player1.bet);
        } else {
            player1.score -= Math.abs(player1.currentRoundWins - player1.bet);
        }
        if (player2.currentRoundWins === player2.bet) {
            player2.score += (10 + player2.bet);
        } else {
            player2.score -= Math.abs(player2.currentRoundWins - player2.bet);
        }

        // ⚠️ Ora determina e salva il vincitore del ROUND per il prossimo round
        if (player1.currentRoundWins > player2.currentRoundWins) {
            game.lastRoundWinner = player1Id;
        } else if (player2.currentRoundWins > player1.currentRoundWins) {
            game.lastRoundWinner = player2Id;
        } else {
            game.lastRoundWinner = null; // O un default, se il round finisce in parità
        }

        // 5. Notifica entrambi i giocatori che il round è finito e i punteggi finali
        // *** Due emissioni separate per inviare la carta dell'avversario ***
        io.to(player1Id).emit("roundFinished", {
            player1Score: player1.score, // Punteggio finale del giocatore 1
            player2Score: player2.score, // Punteggio finale del giocatore 2
            player1Wins: player1.currentRoundWins,
            player2Wins: player2.currentRoundWins,
            player1Id: player1Id,
            player2Id: player2Id,
            player1Bet: player1.bet,
            player2Bet: player2.bet,
            currentRound: game.round,
            firstToReveal: game.lastRoundWinner || player1Id,
            opponentLastCardPlayed: card2,
            opponentLastCardPlayedIndex: card2Index
        });

        io.to(player2Id).emit("roundFinished", {
            player1Score: player1.score, // Punteggio finale del giocatore 1
            player2Score: player2.score, // Punteggio finale del giocatore 2
            player1Wins: player1.currentRoundWins,
            player2Wins: player2.currentRoundWins,
            player1Id: player1Id,
            player2Id: player2Id,
            player1Bet: player1.bet,
            player2Bet: player2.bet,
            currentRound: game.round,
            firstToReveal: game.lastRoundWinner || player1Id,
            opponentLastCardPlayed: card1,
            opponentLastCardPlayedIndex: card1Index
        });

        // Resetta le scommesse e le mani vinte per il prossimo round
        player1.bet = "";
        player2.bet = "";
        player1.currentRoundWins = 0;
        player2.currentRoundWins = 0;
        player1.revealedCardsCount = 0;
        player2.revealedCardsCount = 0;

        // Se il gioco è finito (round >= 10), gestisci la fine del gioco
        if (game.round >= 10) {
            io.to(roomCode).emit("gameOver", {
                finalScores: {
                    [player1Id]: player1.score,
                    [player2Id]: player2.score
                },
                playerNames: {
                    [player1Id]: player1.name,
                    [player2Id]: player2.name
                }
            });
            delete gameStates[roomCode];
        }

    } else {
        // Round NON terminato, si passa alla prossima mano
        // `game.firstToReveal` è già impostato correttamente sul vincitore della mano corrente

        // *** Due emissioni separate per inviare la carta dell'avversario ***
        io.to(player1Id).emit("nextHand", {
            firstToReveal: game.firstToReveal,
            player1Wins: player1.currentRoundWins,
            player2Wins: player2.currentRoundWins,
            opponentCard: card2,
            opponentCardIndex: card2Index
        });

        io.to(player2Id).emit("nextHand", {
            firstToReveal: game.firstToReveal,
            player1Wins: player1.currentRoundWins,
            player2Wins: player2.currentRoundWins,
            opponentCard: card1,
            opponentCardIndex: card1Index
        });
    }

    // 🚨 SALVA LO STATO AGGIORNATO NEL DB DOPO OGNI OPERAZIONE SIGNIFICATIVA 🚨
    if (typeof matchesCollection !== 'undefined') {
        try {
            await matchesCollection.updateOne(
                { roomCode: roomCode },
                { $set: { gameState: game } }
            );
        } catch (error) {
            console.error(`[SERVER ERROR] Errore salvando lo stato del gioco per la stanza ${roomCode}:`, error);
        }
    } else {
        console.error("matchesCollection non inizializzata. Impossibile salvare lo stato del gioco.");
    }
}

// Backend: Nel socket.on("playerCardPlayed", ...)
socket.on("playerCardPlayed", async ({ roomCode, card, cardIndex }) => {
    let game = gameStates[roomCode];
    if (!game || !game.players[socket.id]) {
        console.warn(`[SERVER] Tentativo di giocare in stanza non valida o giocatore non trovato. Stanza: ${roomCode}, ID: ${socket.id}`);
        return;
    }

    const currentPlayerId = socket.id;
    const player = game.players[currentPlayerId];

    const playerIds = Object.keys(game.players);
    const opponentId = playerIds.find(id => id !== currentPlayerId);
    const opponent = game.players[opponentId];
    if (!opponent) {
        console.warn(`[SERVER] Avversario non trovato per la stanza ${roomCode}.`);
        return;
    }

    const cardInPlayerHand = player.hand[cardIndex];
    if (!cardInPlayerHand || cardInPlayerHand.suit !== card.suit || cardInPlayerHand.value !== card.value) {
        socket.emit("gameError", "Carta non valida o non nella tua mano!");
        console.warn(`[SERVER] Giocatore ${currentPlayerId} ha tentato di giocare una carta non valida: ${JSON.stringify(card)} ad indice ${cardIndex}`);
        return;
    }

    if (cardInPlayerHand.played) {
        socket.emit("gameError", "Hai già giocato questa carta!");
        console.warn(`[SERVER] Giocatore ${currentPlayerId} ha tentato di rigiocare una carta già giocata: ${JSON.stringify(cardInPlayerHand)}`);
        return;
    }

    // QUESTO È IL CONTROLLO CHE GENERA L'ERRORE
    if (game.firstToReveal !== currentPlayerId) {
        socket.emit("gameError", "Non è il tuo turno di giocare!");
        console.warn(`[SERVER] Giocatore ${currentPlayerId} ha tentato di giocare fuori turno. Turno corrente: ${game.firstToReveal}`);
        return;
    }

    player.playedCard = card;
    player.playedCardIndex = cardIndex;
    player.revealedCardsCount++;
    cardInPlayerHand.played = true;

    const currentPlayerPlayed = player.playedCard !== null;
    const opponentPlayed = opponent.playedCard !== null;

    if (currentPlayerPlayed && opponentPlayed) {

        await processPlayedCards(roomCode, io);
    } else {
        // Trasferisce il turno all'altro giocatore per la sua giocata
        game.firstToReveal = opponentId; 

        io.to(opponentId).emit("opponentPlayedTheirCard", {
            opponentCard: card,
            opponentCardIndex: cardIndex,
        });

        io.to(currentPlayerId).emit("waitingForOpponentPlay");
    }

    if (typeof matchesCollection !== 'undefined') {
        try {
            await matchesCollection.updateOne(
                { roomCode: roomCode },
                { $set: { gameState: game } }
            );
        } catch (error) {
            console.error(`[SERVER ERROR] Errore salvando lo stato del gioco per la stanza ${roomCode}:`, error);
        }
    } else {
        console.error("matchesCollection non inizializzata. Impossibile salvare lo stato.");
    }
});

  
   // 🔌 Disconnessione (MODIFICA: Migliorata gestione isInGame e pendingInvitations)
    socket.on("disconnect", async () => {
        console.log("🔴 Disconnessione:", socket.id);
        try {
            clearInterval(heartbeatInterval);

            // Rimuovi il giocatore dalla lista dei pending invitations se era un invitante
            if (pendingInvitations[socket.id]) {
                clearTimeout(pendingInvitations[socket.id].timeoutId);
                console.log(`🗑️ Invito pendente da ${socket.id} cancellato a causa di disconnessione.`);
                delete pendingInvitations[socket.id];
            }
            // Se il giocatore disconnesso era l'invitato in un pending invitation
            for (const inviterId in pendingInvitations) {
                if (pendingInvitations[inviterId].invitedSocketId === socket.id) {
                    clearTimeout(pendingInvitations[inviterId].timeoutId);
                    io.to(inviterId).emit("invitationExpired", {
                        invitedName: pendingInvitations[inviterId].invitedPlayerName // Feedback all'invitante
                    });
                    console.log(`🗑️ Invito da ${inviterId} a ${socket.id} cancellato a causa di disconnessione invitato.`);
                    delete pendingInvitations[inviterId];
                }
            }


            // Imposta isInGame a false e poi rimuovi il giocatore
            const playerInDb = await onlinePlayersCollection.findOne({ socketId: socket.id });
            if (playerInDb) {
                // Se il giocatore esisteva, aggiorna isInGame e poi rimuovilo.
                await onlinePlayersCollection.updateOne(
                    { socketId: socket.id },
                    { $set: { isInGame: false } }
                );
                await onlinePlayersCollection.deleteOne({ socketId: socket.id });
            }


            const roomCode = socket.data?.roomCode;
            if (roomCode) {
                const room = await matchesCollection.findOne({ roomCode });
                if (room && room.players.length > 1) {
                    const otherPlayer = room.players.find(p => p.socketId !== socket.id);
                    if (otherPlayer) {
                        await onlinePlayersCollection.updateOne(
                            { socketId: otherPlayer.socketId },
                            { $set: { isInGame: false } } // Rilascia l'altro giocatore
                        );
                        io.to(otherPlayer.socketId).emit("opponentDisconnected", { roomCode: roomCode });
                        console.log(`📢 Avversario ${otherPlayer.name} notificato della disconnessione di ${socket.data?.name || socket.id}.`);
                    }
                }

                await matchesCollection.updateOne(
                    { roomCode },
                    { $pull: { players: { socketId: socket.id } } }
                );

                const updatedRoom = await matchesCollection.findOne({ roomCode });

                if (!updatedRoom || updatedRoom.players.length === 0) {
                    await matchesCollection.deleteOne({ roomCode });
                    console.log(`🗑️ Stanza ${roomCode} eliminata (vuota)`);
                    // Rimuovi anche lo stato del gioco se la stanza è stata eliminata
                    if (gameStates[roomCode]) {
                        delete gameStates[roomCode];
                        console.log(`🗑️ Stato del gioco per stanza ${roomCode} eliminato.`);
                    }
                }
            }
        } catch (err) {
            console.error("❌ Errore rimozione stanza/giocatore su disconnessione:", err);
        }
    });

}); // Fine di io.on("connection")

// 🚀 Avvio server
connectToDatabase().then(() => {
    const port = process.env.PORT || 3000;
    server.listen(port, () => {
        console.log(`🚀 Server attivo su http://localhost:${port}`);
    });
}).catch(err => {
    console.error("❌ Errore durante l'avvio del server o la connessione al DB:", err);
});






