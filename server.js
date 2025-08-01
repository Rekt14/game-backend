// server.js
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const { MongoClient, ObjectId } = require("mongodb");

const gameStates = {};

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
    // Rimuove i giocatori inattivi da oltre 30 secondi
    const cutoff = new Date(Date.now() - 30 * 1000);
    await onlinePlayersCollection.deleteMany({ lastSeen: { $lt: cutoff } });

    const count = await onlinePlayersCollection.countDocuments();
    res.json({ online: count });
  } catch (err) {
    res.status(500).send("Errore nel conteggio giocatori online");
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
        lastSeen: new Date()
      });

      socket.data.name = name;

      heartbeatInterval = setInterval(async () => {
        await onlinePlayersCollection.updateOne(
          { socketId: socket.id },
          { $set: { lastSeen: new Date() } }
        );
      }, 10000);
    } catch (err) {
      console.error("❌ Errore registrazione giocatore:", err);
    }
  });

  // 🎮 Crea stanza multiplayer
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

      console.log(`🛠️  Stanza creata: ${roomCode} da ${name}`);
      callback({ success: true, roomCode });
    } catch (err) {
      console.error("❌ Errore creazione stanza:", err);
      callback({ success: false, error: "Errore creazione stanza" });
    }
  });

  // 🎮 Unisciti a una stanza esistente
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

      const otherPlayer = match.players[0]; // Creatore stanza
      const opponentName = otherPlayer.name;

      // 🔔 Notifica entrambi i giocatori + invia socketId creatore
      io.to(roomCode).emit("bothPlayersReady", {
        opponent1: opponentName,
        opponent2: name,
        creatorSocketId: otherPlayer.socketId
      });

      console.log(`👥 ${name} si è unito alla stanza ${roomCode} con ${opponentName}`);
      callback({ success: true });
    } catch (err) {
      console.error("❌ Errore unione stanza:", err);
      callback({ success: false, error: "Errore unione stanza" });
    }
  });

  // --- START OF GAME LOGIC ---

  
socket.on("startRoundRequest", async () => {
    const roomCode = socket.data?.roomCode;
    if (!roomCode) return;

    const room = await matchesCollection.findOne({ roomCode });
    if (!room || room.players.length < 2) return;

    const round = gameStates[roomCode]?.round + 1 || 1;

    const suits = ["Denari", "Spade", "Bastoni", "Coppe"];
    const values = [2, 3, 4, 5, 6, 7, "Fante", "Cavallo", "Re", "Asso"];
    let deck = [];
    for (let suit of suits) {
        for (let value of values) {
            deck.push({ suit, value });
        }
    }
    deck = deck.sort(() => Math.random() - 0.5);

    const [player1, player2] = room.players;

   let firstPlayerForThisRound;
// Se esiste un vincitore dal round precedente, quello inizia il nuovo round
if (gameStates[roomCode] && gameStates[roomCode].lastRoundWinner) {
    firstPlayerForThisRound = gameStates[roomCode].lastRoundWinner;
} else {
    // Altrimenti (ad esempio, è il primo round del gioco o nessun vincitore chiaro), scegli casualmente
    firstPlayerForThisRound = Math.random() < 0.5 ? player1.socketId : player2.socketId;
}
  
    const p1Cards = deck.splice(0, round);
    p1Cards.forEach(card => card.played = false); // Resetta 'played' per le carte del giocatore 1
    const p2Cards = deck.splice(0, round);
    p2Cards.forEach(card => card.played = false);

    gameStates[roomCode] = {
        round,
        deck,
        players: {
            [player1.socketId]: {
                name: player1.name,
                hand: p1Cards,
                bet: "",
                playedCard: null,
                score: gameStates[roomCode]?.players[player1.socketId]?.score || 0,
                currentRoundWins: 0,
                revealedCardsCount: 0
            },
            [player2.socketId]: {
                name: player2.name,
                hand: p2Cards,
                bet: "",
                playedCard: null,
                score: gameStates[roomCode]?.players[player2.socketId]?.score || 0,
                currentRoundWins: 0,
                revealedCardsCount: 0
            }
        },
        firstToReveal: firstPlayerForThisRound,

      lastRoundWinner: null
    };


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

    console.log(`🎯 Round ${round} avviato nella stanza ${roomCode}`);
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

    const card1 = player1.playedCard;
    const card2 = player2.playedCard;

     // INIZIO CONSOLE LOGS
    console.log(`[SERVER-PROCESSCARDS] INIZIO PROCESSPLAYEDCARDS PER STANZA ${roomCode}.`);
    console.log(`[SERVER-PROCESSCARDS] CARTE GIOCATE - P1: ${card1 ? card1.value + ' di ' + card1.suit : 'N/A'}, P2: ${card2 ? card2.value + ' di ' + card2.suit : 'N/A'}`);
    // FINE CONSOLE LOGS

    // 1. Determina il vincitore della mano
    const player1WinsHand = compareCards(card1, card2);
    const handWinnerId = player1WinsHand ? player1Id : player2Id;

    // Aggiorna i conteggi delle mani vinte
    if (player1WinsHand) {
        player1.currentRoundWins++;
    } else {
        player2.currentRoundWins++;
    }

    // ⚠️ Importante: `game.firstToReveal` qui deve essere il vincitore della MANO CORRENTE!
    // È questo che determina chi inizierà la PROSSIMA MANO all'interno dello stesso round.
    game.firstToReveal = handWinnerId;

     // INIZIO CONSOLE LOGS
    console.log(`[SERVER-PROCESSCARDS] VINCITORE MANO: ${handWinnerId}. P1 VITTORIE ROUND: ${player1.currentRoundWins}, P2 VITTORIE ROUND: ${player2.currentRoundWins}`);
    console.log("[SERVER-PROCESSCARDS] EMETTENDO HANDRESULT...");
    // FINE CONSOLE LOGS

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
    player1.playedCard = null;
    player1.playedCardIndex = null;
    player2.playedCard = null;
    player2.playedCardIndex = null;

     // INIZIO CONSOLE LOGS
    console.log(`[SERVER-PROCESSCARDS] CONTEGGI CARTE RIVELATE: P1: ${player1.revealedCardsCount}, P2: ${player2.revealedCardsCount}. ROUND CORRENTE: ${game.round}`);
    // FINE CONSOLE LOGS

    // 4. Controlla se il round è finito (tutte le carte sono state giocate)
    if (player1.revealedCardsCount === game.round && player2.revealedCardsCount === game.round) {
       // INIZIO CONSOLE LOGS
        console.log("[SERVER-PROCESSCARDS] CONDIZIONE ROUND FINITO VERIFICATA.");
        // FINE CONSOLE LOGS
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
        // Questo è il momento in cui `game.lastRoundWinner` deve essere impostato.
        if (player1.currentRoundWins > player2.currentRoundWins) { // Semplice confronto, adatta la tua logica di vittoria round
            game.lastRoundWinner = player1Id;
        } else if (player2.currentRoundWins > player1.currentRoundWins) {
            game.lastRoundWinner = player2Id;
        } else {
            game.lastRoundWinner = null; // O un default, se il round finisce in parità
        }

 // INIZIO CONSOLE LOGS
        console.log("[SERVER-PROCESSCARDS] EMETTENDO ROUNDFINISHED...");
        // FINE CONSOLE LOGS
        // 5. Notifica entrambi i giocatori che il round è finito e i punteggi finali
        io.to(roomCode).emit("roundFinished", {
            player1Score: player1.score,
            player2Score: player2.score,
            player1Wins: player1.currentRoundWins,
            player2Wins: player2.currentRoundWins,
            player1Id: player1Id,
            player2Id: player2Id,
            player1Bet: player1.bet,
            player2Bet: player2.bet,
            currentRound: game.round,
            // ⚠️ Importante: Qui `firstToReveal` deve essere chi inizierà il PROSSIMO ROUND.
            // Usiamo `game.lastRoundWinner` che abbiamo appena impostato.
            firstToReveal: game.lastRoundWinner || player1Id // Fallback se non c'è un vincitore chiaro
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
           // INIZIO CONSOLE LOGS
            console.log("[SERVER-PROCESSCARDS] GIOCO FINITO, EMETTENDO GAMEOVER...");
            // FINE CONSOLE LOGS
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
       // INIZIO CONSOLE LOGS
        console.log("[SERVER-PROCESSCARDS] CONDIZIONE ROUND FINITO NON VERIFICATA. EMETTENDO NEXTHAND...");
        // FINE CONSOLE LOGS
        // Round NON terminato, si passa alla prossima mano
        // `game.firstToReveal` è già impostato correttamente sul vincitore della mano corrente
        io.to(roomCode).emit("nextHand", {
            firstToReveal: game.firstToReveal,
            player1Wins: player1.currentRoundWins,
            player2Wins: player2.currentRoundWins
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

    // INIZIO CONSOLE LOGS
    console.log(`[SERVER-PLAYERCARDPLAYED] GIOCATORE ${currentPlayerId} HA GIOCATO CARTA. CARTE RIVELATE: ${player.revealedCardsCount}`);

    const currentPlayerPlayed = player.playedCard !== null;
    const opponentPlayed = opponent.playedCard !== null;

    console.log(`[SERVER-PLAYERCARDPLAYED] STATO CARTE: TU GIOCATO: ${currentPlayerPlayed}, AVVERSARIO GIOCATO: ${opponentPlayed}`);
    // FINE CONSOLE LOGS

    if (currentPlayerPlayed && opponentPlayed) {
        // INIZIO CONSOLE LOGS
        console.log("[SERVER-PLAYERCARDPLAYED] ENTRAMBI HANNO GIOCATO. CHIAMANDO PROCESSPLAYEDCARDS...");
        // FINE CONSOLE LOGS
        await processPlayedCards(roomCode, io);
    } else {
        // INIZIO CONSOLE LOGS
        console.log(`[SERVER-PLAYERCARDPLAYED] SOLO UN GIOCATORE HA GIOCATO. AVVISANDO AVVERSARIO (${opponentId}).`);
        // FINE CONSOLE LOGS

        // *** AGGIUNGI QUESTA RIGA ***
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

  
  // 🔌 Disconnessione
  socket.on("disconnect", async () => {
    console.log("🔴 Disconnessione:", socket.id);
    try {
      clearInterval(heartbeatInterval);
      await onlinePlayersCollection.deleteOne({ socketId: socket.id });

      const roomCode = socket.data?.roomCode;
      if (roomCode) {
        await matchesCollection.updateOne(
          { roomCode },
          { $pull: { players: { socketId: socket.id } } }
        );

        const room = await matchesCollection.findOne({ roomCode });

        if (!room || room.players.length === 0) {
          await matchesCollection.deleteOne({ roomCode });
          console.log(`🗑️ Stanza ${roomCode} eliminata (vuota)`);
        }
      }
    } catch (err) {
      console.error("❌ Errore rimozione stanza/giocatore:", err);
    }
  });
}); 

// 🚀 Avvio server
connectToDatabase().then(() => {
  const port = process.env.PORT || 3000;
  server.listen(port, () => {
    console.log(`🚀 Server attivo su http://localhost:${port}`);
  });
});
