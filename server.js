// =========================================================
//  1. SETUP E VARIABILI GLOBALI
// =========================================================
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const { MongoClient, ObjectId } = require("mongodb");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// Stato del gioco in memoria
const gameStates = {};
const pendingInvitations = {};
const disconnectionTimers = {};
const DISCONNECTION_TIMEOUT = 60000; // 60 secondi per la riconnessione

// Setup del database
const uri = process.env.MONGO_URI;
const dbName = "gameDB";
let recordsCollection;
let matchesCollection;
let onlinePlayersCollection;

app.use(cors());
app.use(express.json());

// =========================================================
//  2. FUNZIONI DI UTILITÀ
// =========================================================
async function connectToDatabase() {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);
  recordsCollection = db.collection("records");
  matchesCollection = db.collection("matches");
  onlinePlayersCollection = db.collection("onlinePlayers");
  console.log("✅ Connesso a MongoDB");
}

function findRoomBySocketId(socketId) {
  for (const roomCode in gameStates) {
    if (gameStates[roomCode].players.hasOwnProperty(socketId)) {
      return roomCode;
    }
  }
  return null;
}

// =========================================================
//  3. API RECORDS E PLAYER ONLINE
// =========================================================
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

app.get("/online-players", async (req, res) => {
  try {
    const cutoff = new Date(Date.now() - 30 * 1000);
    await onlinePlayersCollection.deleteMany({ lastSeen: { $lt: cutoff } });
    const onlinePlayers = await onlinePlayersCollection.find({}, { projection: { name: 1, socketId: 1, isInGame: 1, _id: 0 } }).toArray();
    res.json({ online: onlinePlayers.length, players: onlinePlayers });
  } catch (err) {
    console.error("❌ Errore nel conteggio/recupero giocatori online:", err);
    res.status(500).send("Errore nel recupero dei giocatori online");
  }
});

// =========================================================
//  4. GESTIONE CONNESSIONI
// =========================================================
io.on("connection", (socket) => {
  console.log("🟢 Connessione socket:", socket.id);
  let heartbeatInterval;

  // --- Gestione della Riconnessione ---
  if (disconnectionTimers[socket.id]) {
    clearTimeout(disconnectionTimers[socket.id]);
    delete disconnectionTimers[socket.id];
    console.log(`[RECONNECT] Giocatore ${socket.id} riconnesso. Timer di disconnessione cancellato.`);
    socket.emit("reconnected");
  }

  // --- Registrazione Giocatore ---
  socket.on("registerPlayer", async (name) => {
    const existingPlayer = await onlinePlayersCollection.findOne({ socketId: socket.id });
    if (existingPlayer) {
      console.log(`🧍 Giocatore ${name} (${socket.id}) già registrato. Aggiorno lo stato.`);
      socket.data.name = name;
      socket.data.isInGame = existingPlayer.isInGame;
      return;
    }
    console.log(`🧍 Registrazione giocatore: ${name} (${socket.id})`);
    try {
      await onlinePlayersCollection.insertOne({
        socketId: socket.id,
        name,
        lastSeen: new Date(),
        isInGame: false
      });
      socket.data.name = name;
      socket.data.isInGame = false;
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

  // --- Inviti ---
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

    if (pendingInvitations[inviterSocketId]) {
      clearTimeout(pendingInvitations[inviterSocketId].timeoutId);
      delete pendingInvitations[inviterSocketId];
    }
    const INVITE_TIMEOUT_MS = 60000;
    const invitationTimeout = setTimeout(() => {
      io.to(inviterSocketId).emit("invitationExpired", {
        invitedName: invitedData.name
      });
      console.log(`⏳ Invito da ${inviterName} a ${invitedData.name} scaduto.`);
      delete pendingInvitations[inviterSocketId];
    }, INVITE_TIMEOUT_MS);

    pendingInvitations[inviterSocketId] = {
      invitedSocketId: invitedSocketId,
      timeoutId: invitationTimeout,
      invitedPlayerName: invitedData.name
    };
    console.log(`✉️ Invito inviato da ${inviterName} (${inviterSocketId}) a ${invitedData.name} (${invitedSocketId})`);
    io.to(invitedSocketId).emit("receiveInvitation", {
      inviterName: inviterName,
      inviterSocketId: inviterSocketId,
      timeout: INVITE_TIMEOUT_MS
    });
    socket.emit("invitationSent", { invitedName: invitedData.name });
  });

  // Accettazione invito
socket.on("acceptInvitation", async ({ inviterSocketId }) => {
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
        roomSize: 2, // 👈🏼 Qui specifichi che è una partita a 2 giocatori
        createdAt: new Date()
      });
      
      const inviterSocket = io.sockets.sockets.get(inviter.socketId);
      if (inviterSocket) {
        inviterSocket.join(roomCode);
        inviterSocket.data.roomCode = roomCode;
        inviterSocket.data.name = inviter.name;
        inviterSocket.data.isInGame = true;
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
      socket.data.isInGame = true;
      await onlinePlayersCollection.updateOne({ socketId: invitedPlayerSocketId }, { $set: { isInGame: true } });
      console.log(`👥 ${invitedPlayerName} (invitato) unito a stanza ${roomCode}. isInGame: true.`);
      
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

  socket.on("declineInvitation", async ({ inviterSocketId }) => {
    if (pendingInvitations[inviterSocketId]) {
      clearTimeout(pendingInvitations[inviterSocketId].timeoutId);
      const invitedPlayerName = pendingInvitations[inviterSocketId].invitedPlayerName;
      delete pendingInvitations[inviterSocketId];
      console.log(`🚫 Invito da ${inviterSocketId} rifiutato, timeout cancellato.`);
      io.to(inviterSocketId).emit("invitationDeclined", {
        declinerName: invitedPlayerName
      });
      console.log(`🚫 Invito da ${inviterSocketId} rifiutato da ${invitedPlayerName}`);
    } else {
      console.log(`🚫 Invito rifiutato da ${socket.id}, ma invito originale non trovato (invitante ${inviterSocketId}).`);
    }
  });

  // --- Creazione/Unione Stanza ---

// --- Creazione Stanza ---
socket.on("createRoom", async ({ name, roomSize }, callback) => {
  const roomCode = Math.floor(1000 + Math.random() * 9000).toString();
  try {
    await matchesCollection.insertOne({
      roomCode,
      players: [{ socketId: socket.id, name }],
      roomSize, // Salva la dimensione della stanza
      createdAt: new Date()
    });
    socket.join(roomCode);
    socket.data.name = name;
    socket.data.roomCode = roomCode;
    socket.data.isInGame = true;
    await onlinePlayersCollection.updateOne({ socketId: socket.id }, { $set: { isInGame: true } });
    console.log(`🛠️ Stanza creata: ${roomCode} da ${name}. Richiesti ${roomSize} giocatori. isInGame: true.`);
    callback({ success: true, roomCode });
  } catch (err) {
    console.error("❌ Errore creazione stanza:", err);
    socket.emit("gameError", "Errore durante la creazione della stanza.");
    callback({ success: false, error: "Errore creazione stanza" });
  }
});

// --- Unione Stanza ---
socket.on("joinRoom", async ({ name, roomCode }, callback) => {
  const match = await matchesCollection.findOne({ roomCode });
  if (!match) return callback({ success: false, error: "Stanza non trovata" });
  if (match.players.length >= match.roomSize) return callback({ success: false, error: "Stanza piena" });
  try {
    await matchesCollection.updateOne(
      { roomCode },
      { $push: { players: { socketId: socket.id, name } } }
    );
    socket.join(roomCode);
    socket.data.name = name;
    socket.data.roomCode = roomCode;
    socket.data.isInGame = true;
    await onlinePlayersCollection.updateOne({ socketId: socket.id }, { $set: { isInGame: true } });
    console.log(`👥 ${name} si è unito alla stanza ${roomCode}. isInGame: true.`);

    const updatedMatch = await matchesCollection.findOne({ roomCode });

    // Emette l'evento per aggiornare tutti i giocatori nella stanza
    io.to(roomCode).emit("playerJoined", {
      playersInRoom: updatedMatch.players.length,
      roomSize: updatedMatch.roomSize,
      playerName: name
    });
    
    // Controlla se la stanza ha raggiunto la dimensione richiesta
    if (updatedMatch.players.length === updatedMatch.roomSize) {
      // Aggiorna lo stato di tutti i giocatori come in-game
      await onlinePlayersCollection.updateMany(
        { socketId: { $in: updatedMatch.players.map(p => p.socketId) } },
        { $set: { isInGame: true } }
      );
      // Avvia il gioco inviando il comando a tutti
      io.to(roomCode).emit("allPlayersReady", {
        players: updatedMatch.players,
        roomCode: roomCode
      });
      console.log(`🎉 Stanza ${roomCode} piena con ${updatedMatch.roomSize} giocatori. Partita avviata!`);
    }
    
    // Invia la risposta al solo giocatore che si è unito
    callback({ success: true, playersInRoom: updatedMatch.players.length, roomSize: updatedMatch.roomSize });
  } catch (err) {
    console.error("❌ Errore unione stanza:", err);
    socket.emit("gameError", "Errore durante l'unione alla stanza.");
    callback({ success: false, error: "Errore unione stanza" });
  }
});

    // --- Gestione Disconnessione (con timeout) ---
  socket.on("disconnect", async () => {
    console.log("🔴 Disconnessione:", socket.id);
    clearInterval(heartbeatInterval);

    // Gestione degli inviti in sospeso
    if (pendingInvitations[socket.id]) {
      clearTimeout(pendingInvitations[socket.id].timeoutId);
      delete pendingInvitations[socket.id];
    }
    for (const inviterId in pendingInvitations) {
      if (pendingInvitations[inviterId].invitedSocketId === socket.id) {
        clearTimeout(pendingInvitations[inviterId].timeoutId);
        io.to(inviterId).emit("invitationExpired", {
          invitedName: pendingInvitations[inviterId].invitedPlayerName
        });
        delete pendingInvitations[inviterId];
      }
    }

    const roomCode = findRoomBySocketId(socket.id);
    if (roomCode) {
      console.log(`[DISCONNECT] Avviato timer di disconnessione per il giocatore ${socket.id} nella stanza ${roomCode}.`);
      disconnectionTimers[socket.id] = setTimeout(async () => {
        try {
          console.log(`[DISCONNECT] Timeout scaduto per ${socket.id}. Procedo con la rimozione.`);
          const playerInDb = await onlinePlayersCollection.findOne({ socketId: socket.id });
          if (playerInDb) {
            await onlinePlayersCollection.updateOne({ socketId: socket.id }, { $set: { isInGame: false } });
            await onlinePlayersCollection.deleteOne({ socketId: socket.id });
          }

          const room = await matchesCollection.findOne({ roomCode });
          if (room && room.players.length > 1) {
            const otherPlayer = room.players.find(p => p.socketId !== socket.id);
            if (otherPlayer) {
              await onlinePlayersCollection.updateOne({ socketId: otherPlayer.socketId }, { $set: { isInGame: false } });
              io.to(otherPlayer.socketId).emit("opponentDisconnected", { roomCode });
              console.log(`📢 Avversario ${otherPlayer.name} notificato della disconnessione di ${socket.data?.name || socket.id}.`);
            }
          }
          await matchesCollection.updateOne({ roomCode }, { $pull: { players: { socketId: socket.id } } });
          const updatedRoom = await matchesCollection.findOne({ roomCode });
          if (!updatedRoom || updatedRoom.players.length === 0) {
            await matchesCollection.deleteOne({ roomCode });
            console.log(`🗑️ Stanza ${roomCode} eliminata (vuota)`);
            if (gameStates[roomCode]) {
              delete gameStates[roomCode];
              console.log(`🗑️ Stato del gioco per stanza ${roomCode} eliminato.`);
            }
          }
        } catch (err) {
          console.error("❌ Errore rimozione stanza/giocatore su disconnessione:", err);
        } finally {
          delete disconnectionTimers[socket.id];
        }
      }, DISCONNECTION_TIMEOUT);
    } else {
      // Se non era in una stanza, esegui la rimozione immediata
      try {
        const playerInDb = await onlinePlayersCollection.findOne({ socketId: socket.id });
        if (playerInDb) {
          await onlinePlayersCollection.updateOne({ socketId: socket.id }, { $set: { isInGame: false } });
          await onlinePlayersCollection.deleteOne({ socketId: socket.id });
        }
      } catch (err) {
        console.error("❌ Errore rimozione giocatore offline:", err);
      }
    }
  });
});

// =========================================================
//  5. LOGICA DI GIOCO
// =========================================================
socket.on("startRoundRequest", async () => {
    const roomCode = socket.data?.roomCode;
    if (!roomCode) return;

    let game = gameStates[roomCode];
    if (!game) {
        game = {
            round: 0,
            players: {},
            nextRoundReadyCount: 0,
            lastRoundWinner: null,
        };
        gameStates[roomCode] = game;
    }

    game.nextRoundReadyCount++;

    const room = await matchesCollection.findOne({ roomCode });
    if (!room) {
        console.error(`[SERVER ERROR] Stanza ${roomCode} non trovata per avviare il round.`);
        return;
    }

    if (game.nextRoundReadyCount === room.roomSize) {
        game.nextRoundReadyCount = 0;
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

        let firstPlayerForThisRound;
        if (game.lastRoundWinner) {
            firstPlayerForThisRound = game.lastRoundWinner;
        } else {
            const randomIndex = Math.floor(Math.random() * room.players.length);
            firstPlayerForThisRound = room.players[randomIndex].socketId;
        }

        game.round = round;
        game.firstToReveal = firstPlayerForThisRound;
        game.lastRoundWinner = null;

        const playersInRoom = room.players;
        const allHands = {};
        for (const player of playersInRoom) {
            const pCards = deck.splice(0, round);
            pCards.forEach(card => card.played = false);

            if (!game.players[player.socketId]) {
                game.players[player.socketId] = { name: player.name, score: 0 };
            }
            game.players[player.socketId].hand = pCards;
            game.players[player.socketId].bet = "";
            game.players[player.socketId].playedCard = null;
            game.players[player.socketId].currentRoundWins = 0;
            game.players[player.socketId].revealedCardsCount = 0;
            allHands[player.socketId] = pCards;
        }

        const firstPlayerIndex = playersInRoom.findIndex(p => p.socketId === firstPlayerForThisRound);
        let playOrder = [];
        for (let i = 0; i < playersInRoom.length; i++) {
            playOrder.push(playersInRoom[(firstPlayerIndex + i) % playersInRoom.length].socketId);
        }

        // Inizializza l'indice del turno
        game.currentTurnIndex = 0;
        game.playOrder = playOrder;

        for (const player of playersInRoom) {
            let dataToSend = {
                round,
                firstToReveal: firstPlayerForThisRound,
                players: playersInRoom,
                playOrder: playOrder,
                yourCards: allHands[player.socketId] // Invia sempre le carte del giocatore locale
            };

            // Invia le carte degli avversari solo al round 1
            if (round === 1) {
                const opponentsCards = {};
                playersInRoom.filter(p => p.socketId !== player.socketId).forEach(opponent => {
                    opponentsCards[opponent.socketId] = allHands[opponent.socketId];
                });
                dataToSend.opponentsCards = opponentsCards;
            }

            io.to(player.socketId).emit("startRoundData", dataToSend);
        }
        console.log(`🎯 Round ${round} avviato nella stanza ${roomCode}. Inizia: ${firstPlayerForThisRound}`);
    } else {
        io.to(roomCode).emit("waitingForPlayersReady", {
            playersReady: game.nextRoundReadyCount,
            playersNeeded: room.roomSize
        });
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

// Funzione helper per creare e mescolare un mazzo 
// (non usata per ora ma integrabile per semplificare startRoundData)
function createAndShuffleDeck() {
  const suits = ["Denari", "Spade", "Bastoni", "Coppe"];
  const values = [2, 3, 4, 5, 6, 7, "Fante", "Cavallo", "Re", "Asso"];
  let deck = [];
  for (const suit of suits) {
    for (const value of values) {
      deck.push({ suit, value });
    }
  }
  return deck.sort(() => Math.random() - 0.5);
}

// Gestione scommessa giocatore
socket.on("playerBet", async ({ roomCode, bet }) => {
  const game = gameStates[roomCode];
  if (!game || !game.players[socket.id]) {
    return;
  }
  
  game.players[socket.id].bet = bet;
  
  // Trova la stanza dal database
  const match = await matchesCollection.findOne({ roomCode });
  if (!match) {
    return;
  }
  
  // Aggiorna il frontend di tutti i giocatori con la scommessa piazzata
  io.to(roomCode).emit("playerBetPlaced", {
    playerId: socket.id,
    bet: bet
  });
  
  // Controlla se tutti hanno scommesso
  const playersWithBets = match.players.filter(p => game.players[p.socketId]?.bet !== "");
  if (playersWithBets.length === match.roomSize) {
    // Se tutti hanno scommesso, avvia la fase di gioco delle carte
    io.to(roomCode).emit("allBetsPlaced", {
      players: match.players.map(p => ({
        id: p.socketId,
        name: p.name,
        bet: game.players[p.socketId].bet
      }))
    });
    console.log(`✅ Tutte le scommesse piazzate nella stanza ${roomCode}. Inizio gioco carte.`);
  }
});

// =========================================================
//  6. LOGICA GESTIONE CARTE AVVERSARI
// =========================================================

 // Sostituisci il listener esistente
socket.on("playerCardPlayed", async ({ roomCode, card, cardIndex }) => {
    let game = gameStates[roomCode];
    if (!game || !game.players[socket.id]) {
      console.warn(`[SERVER] Tentativo di giocare in stanza non valida o giocatore non trovato. Stanza: ${roomCode}, ID: ${socket.id}`);
      return;
    }
    
    const currentPlayerId = socket.id;
    const player = game.players[currentPlayerId];
    const playersInRoom = Object.keys(game.players);
  
    // 1. Validazione di base
    const cardInPlayerHand = player.hand[cardIndex];
    if (!cardInPlayerHand || cardInPlayerHand.played) {
      socket.emit("gameError", "Carta non valida o già giocata.");
      return;
    }
    
    // 2. Controllo del turno basato su `playOrder`
    // Assicurati che `playOrder` e `currentTurnIndex` siano presenti in `gameStates`
    if (!game.playOrder || game.currentTurnIndex === undefined) {
      socket.emit("gameError", "Errore di sincronizzazione del turno.");
      return;
    }
    
    const currentTurnPlayerId = game.playOrder[game.currentTurnIndex];
    if (currentTurnPlayerId !== currentPlayerId) {
      socket.emit("gameError", "Non è il tuo turno di giocare!");
      return;
    }
  
    // 3. Registra la giocata
    player.playedCard = card;
    player.playedCardIndex = cardIndex;
    cardInPlayerHand.played = true;
  
    // 4. Notifica tutti i giocatori della giocata
    io.to(roomCode).emit("playerPlayedCard", {
      playerId: currentPlayerId,
      card: card,
      cardIndex: cardIndex
    });
  
    // 5. Avanza il turno nel backend
    game.currentTurnIndex++;
    
    // 6. Controlla se il round è finito (tutti hanno giocato)
    if (game.currentTurnIndex === playersInRoom.length) {
      console.log("Tutti i giocatori hanno giocato. Fine mano.");
      await processPlayedCards(roomCode, io);
    } else {
      // 7. Notifica il prossimo giocatore che è il suo turno
      const nextPlayerId = game.playOrder[game.currentTurnIndex];
      io.to(nextPlayerId).emit("yourTurnToPlay");
    }
  
    // 8. Salva lo stato del gioco
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

const valuePoints = {
  2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7,
  "Fante": 8, "Cavallo": 9, "Re": 10, "Asso": 11
};

const suitStrength = {
  "Denari": 4, "Spade": 3, "Bastoni": 2, "Coppe": 1
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

  const playOrder = game.playOrder;
  const playersPlayedThisHand = playOrder.map(id => game.players[id]);
  
  // Trova la carta vincente della mano
  let winningCard = playersPlayedThisHand[0].playedCard;
  let handWinnerId = playersPlayedThisHand[0].socketId;
  
  for (let i = 1; i < playersPlayedThisHand.length; i++) {
    const currentCard = playersPlayedThisHand[i].playedCard;
    if (compareCards(currentCard, winningCard)) {
      winningCard = currentCard;
      handWinnerId = playersPlayedThisHand[i].socketId;
    }
  }

  // Aggiorna le vittorie
  game.players[handWinnerId].currentRoundWins++;
  game.firstToReveal = handWinnerId;

  // Invia i risultati a tutti
  const playedCards = playersPlayedThisHand.map(p => ({
    playerId: p.socketId,
    card: p.playedCard,
    cardIndex: p.playedCardIndex
  }));

  io.to(roomCode).emit("handResult", {
    winnerId: handWinnerId,
    playedCards: playedCards
  });

  // Ripulisce le carte giocate per la prossima mano
  playersPlayedThisHand.forEach(p => {
    p.playedCard = null;
    p.playedCardIndex = null;
  });

  // Resetta l'indice del turno per la prossima mano
  game.currentTurnIndex = 0;

  // Controlla se il round è terminato
  const firstPlayerInRoom = game.players[Object.keys(game.players)[0]];
  if (firstPlayerInRoom.hand.every(card => card.played)) {
    // Il round è finito, calcola i punteggi
    const scores = {};
    const wins = {};
    const bets = {};
    
    Object.values(game.players).forEach(p => {
      if (p.currentRoundWins === p.bet) {
        p.score += (10 + p.bet);
      } else {
        const penalty = Math.abs(p.currentRoundWins - p.bet);
        p.score -= penalty;
      }
      scores[p.socketId] = p.score;
      wins[p.socketId] = p.currentRoundWins;
      bets[p.socketId] = p.bet;
    });

    game.lastRoundWinner = handWinnerId;
    game.firstToReveal = game.lastRoundWinner;

    io.to(roomCode).emit("roundFinished", {
      scores,
      wins,
      bets,
      currentRound: game.round,
      firstToReveal: game.firstToReveal,
      playedCards: playedCards
    });

    // Reset per il prossimo round
    Object.values(game.players).forEach(p => {
      p.bet = "";
      p.currentRoundWins = 0;
      p.revealedCardsCount = 0;
    });

    if (game.round >= 10) {
      io.to(roomCode).emit("gameOver", { finalScores: scores });
      delete gameStates[roomCode];
    }
  } else {
    // Si passa alla prossima mano
    io.to(roomCode).emit("nextHand", {
      firstToReveal: game.firstToReveal,
      wins: Object.values(game.players).reduce((acc, p) => {
        acc[p.socketId] = p.currentRoundWins;
        return acc;
      }, {}),
      playedCards: playedCards
    });
  }
}


// =========================================================
//  6. AVVIO SERVER
// =========================================================
connectToDatabase().then(() => {
  const port = process.env.PORT || 3000;
  server.listen(port, () => {
    console.log(`🚀 Server attivo su http://localhost:${port}`);
  });
}).catch(err => {
  console.error("❌ Errore durante l'avvio del server o la connessione al DB:", err);
});
