// =========================================================
//  1. SETUP E VARIABILI GLOBALI
// =========================================================
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const { MongoClient } = require("mongodb");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// Stato del gioco in memoria
const gameStates = {};              // { [roomCode]: { round, players: { [socketId]: {...} }, ... } }
const pendingInvitations = {};      // se ti serve realmente in altre parti
const disconnectionTimers = {};     // { [playerId]: timeoutId }
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
/** 2. FUNZIONI DI UTILITÀ */
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

// Trova stanza dal **socketId** (coerente con gameStates/matches)
function findRoomBySocketId(socketId) {
  for (const roomCode in gameStates) {
    const game = gameStates[roomCode];
    if (game?.players && Object.prototype.hasOwnProperty.call(game.players, socketId)) {
      return roomCode;
    }
  }
  return null;
}

// Migra le chiavi nel gameState quando cambia il socketId
function migrateGameStateSocketId(roomCode, oldSocketId, newSocketId) {
  const game = gameStates[roomCode];
  if (!game || !game.players || !game.players[oldSocketId]) return;

  // Sposta i dati del giocatore
  game.players[newSocketId] = { ...game.players[oldSocketId] };
  delete game.players[oldSocketId];

  // Aggiorna riferimenti di turno/vincitore round
  if (game.firstToReveal === oldSocketId) game.firstToReveal = newSocketId;
  if (game.lastRoundWinner === oldSocketId) game.lastRoundWinner = newSocketId;
}

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
  if (v1 === v2) return suitStrength[c1.suit] > suitStrength[c2.suit];
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
  const card1Index = player1.playedCardIndex;
  const card2Index = player2.playedCardIndex;

  const player1WinsHand = compareCards(card1, card2);
  const handWinnerId = player1WinsHand ? player1Id : player2Id;

  if (player1WinsHand) player1.currentRoundWins++;
  else player2.currentRoundWins++;

  game.firstToReveal = handWinnerId;

  io.to(roomCode).emit("handResult", {
    winnerId: handWinnerId,
    player1Card: card1,
    player2Card: card2,
    player1Id: player1Id,
    player2Id: player2Id,
    player1Wins: player1.currentRoundWins,
    player2Wins: player2.currentRoundWins
  });

  player1.playedCard = null; player1.playedCardIndex = null;
  player2.playedCard = null; player2.playedCardIndex = null;

  const bothRevealedAll = (player1.revealedCardsCount === game.round && player2.revealedCardsCount === game.round);

  if (bothRevealedAll) {
    if (player1.currentRoundWins === player1.bet) {
      player1.score += (10 + player1.bet);
    } else {
      const penalty = Math.abs(player1.currentRoundWins - player1.bet);
      player1.score -= penalty;
    }
    if (player2.currentRoundWins === player2.bet) {
      player2.score += (10 + player2.bet);
    } else {
      const penalty = Math.abs(player2.currentRoundWins - player2.bet);
      player2.score -= penalty;
    }

    game.lastRoundWinner = handWinnerId;

    io.to(player1Id).emit("roundFinished", {
      player1Score: player1.score,
      player2Score: player2.score,
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
      player1Score: player1.score,
      player2Score: player2.score,
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

    // reset per round successivo
    player1.bet = ""; player2.bet = "";
    player1.currentRoundWins = 0; player2.currentRoundWins = 0;
    player1.revealedCardsCount = 0; player2.revealedCardsCount = 0;

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
    game.firstToReveal = handWinnerId;
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

  // Persisti stato su DB
  try {
    await matchesCollection.updateOne(
      { roomCode },
      { $set: { gameState: game } }
    );
  } catch (error) {
    console.error(`[SERVER ERROR] Errore salvando lo stato del gioco per ${roomCode}:`, error);
  }
}

// =========================================================
/** 3. API REST */
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
    const onlinePlayers = await onlinePlayersCollection
      .find({}, { projection: { name: 1, socketId: 1, isInGame: 1, _id: 0 } })
      .toArray();
    res.json({ online: onlinePlayers.length, players: onlinePlayers });
  } catch (err) {
    console.error("❌ Errore nel conteggio/recupero giocatori online:", err);
    res.status(500).send("Errore nel recupero dei giocatori online");
  }
});

// =========================================================
/** 4. SOCKET.IO - CONNESSIONI E LOGICA */
// =========================================================
io.on("connection", (socket) => {
  console.log("🟢 Connessione socket:", socket.id);
  let heartbeatInterval;

  // --- Registrazione Giocatore (playerId stabile) ---
  socket.on("registerPlayer", async ({ name, playerId }) => {
    try {
      if (!playerId) playerId = uuidv4();

      const existing = await onlinePlayersCollection.findOne({ playerId });

      if (existing) {
        console.log(`🧍 Rebind player ${name} (${playerId}) -> nuovo socketId ${socket.id}`);
        await onlinePlayersCollection.updateOne(
          { playerId },
          { $set: { socketId: socket.id, name, lastSeen: new Date(), isInGame: existing.isInGame } }
        );
        socket.data = { name, playerId, isInGame: existing.isInGame };
      } else {
        console.log(`🧍 Nuovo player: ${name} (${playerId})`);
        await onlinePlayersCollection.insertOne({
          playerId, socketId: socket.id, name, lastSeen: new Date(), isInGame: false
        });
        socket.data = { name, playerId, isInGame: false };
      }

      // Heartbeat lastSeen
      heartbeatInterval = setInterval(async () => {
        await onlinePlayersCollection.updateOne(
          { playerId },
          { $set: { lastSeen: new Date() } }
        );
      }, 10000);

      socket.emit("playerRegistered", { playerId });
    } catch (err) {
      console.error("❌ Errore registerPlayer:", err);
      socket.emit("gameError", "Errore durante la registrazione del giocatore.");
    }
  });

  // --- Riconnessione esplicita ---
  socket.on("reconnectPlayer", async ({ playerId }) => {
    try {
      const player = await onlinePlayersCollection.findOne({ playerId });
      if (!player) {
        socket.emit("gameError", "Player non trovato, registrati di nuovo.");
        return;
      }

      const oldSocketId = player.socketId;

      // Aggiorna socketId nel profilo online
      await onlinePlayersCollection.updateOne(
        { playerId },
        { $set: { socketId: socket.id, lastSeen: new Date() } }
      );

      socket.data = { playerId, name: player.name, isInGame: player.isInGame };

      // Aggiorna socketId nella/e stanza/e su DB
      await matchesCollection.updateMany(
        { "players.socketId": oldSocketId },
        { $set: { "players.$.socketId": socket.id } }
      );

      // Se era in partita, migra stato in RAM e rientra nella stanza
      const roomCode = findRoomBySocketId(oldSocketId) || findRoomBySocketId(socket.id);
      if (roomCode) {
        migrateGameStateSocketId(roomCode, oldSocketId, socket.id);

        if (disconnectionTimers[playerId]) {
          clearTimeout(disconnectionTimers[playerId]);
          delete disconnectionTimers[playerId];
        }

        socket.join(roomCode);
        socket.emit("reconnected", { state: gameStates[roomCode], roomCode });
        console.log(`🔄 Player ${playerId} riconnesso in stanza ${roomCode} (old ${oldSocketId} -> new ${socket.id})`);
      }
    } catch (err) {
      console.error("❌ Errore reconnectPlayer:", err);
      socket.emit("gameError", "Errore durante la riconnessione.");
    }
  });

  // --- Creazione Stanza ---
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
      socket.data.isInGame = true;

      await onlinePlayersCollection.updateOne(
        { playerId: socket.data.playerId },
        { $set: { isInGame: true } }
      );

      console.log(`🛠️ Stanza creata: ${roomCode} da ${name}. isInGame: true.`);
      callback?.({ success: true, roomCode });
    } catch (err) {
      console.error("❌ Errore creazione stanza:", err);
      socket.emit("gameError", "Errore durante la creazione della stanza.");
      callback?.({ success: false, error: "Errore creazione stanza" });
    }
  });

  // --- Join Stanza ---
  socket.on("joinRoom", async ({ name, roomCode }, callback) => {
    try {
      const match = await matchesCollection.findOne({ roomCode });
      if (!match) return callback?.({ success: false, error: "Stanza non trovata" });
      if (match.players.length >= 2) return callback?.({ success: false, error: "Stanza piena" });

      await matchesCollection.updateOne(
        { roomCode },
        { $push: { players: { socketId: socket.id, name } } }
      );

      socket.join(roomCode);
      socket.data.name = name;
      socket.data.roomCode = roomCode;
      socket.data.isInGame = true;

      await onlinePlayersCollection.updateOne(
        { playerId: socket.data.playerId },
        { $set: { isInGame: true } }
      );

      const otherPlayer = match.players[0];
      const opponentName = otherPlayer.name;

      // Segna anche l’altro come inGame (per sicurezza)
      await onlinePlayersCollection.updateOne(
        { socketId: otherPlayer.socketId },
        { $set: { isInGame: true } }
      );

      io.to(roomCode).emit("allPlayersReady", {
        opponent1: opponentName,
        opponent2: name,
        creatorSocketId: otherPlayer.socketId,
        roomCode
      });

      console.log(`👥 ${name} si è unito alla stanza ${roomCode} con ${opponentName}. isInGame: true.`);
      callback?.({ success: true });
    } catch (err) {
      console.error("❌ Errore unione stanza:", err);
      socket.emit("gameError", "Errore durante l'unione alla stanza.");
      callback?.({ success: false, error: "Errore unione stanza" });
    }
  });

  // --- Logica: start round ---
  socket.on("startRoundRequest", async () => {
    const roomCode = socket.data?.roomCode;
    if (!roomCode) return;

    let game = gameStates[roomCode];
    if (!game) {
      game = { round: 0, players: {}, nextRoundReadyCount: 0, lastRoundWinner: null };
      gameStates[roomCode] = game;
    }

    game.nextRoundReadyCount++;
    if (game.nextRoundReadyCount === 2) {
      game.nextRoundReadyCount = 0;

      const room = await matchesCollection.findOne({ roomCode });
      if (!room || room.players.length < 2) {
        console.error(`[SERVER ERROR] Stanza ${roomCode} non valida o senza 2 giocatori.`);
        return;
      }

      const [player1, player2] = room.players;
      const round = game.round + 1;

      const suits = ["Denari", "Spade", "Bastoni", "Coppe"];
      const values = [2, 3, 4, 5, 6, 7, "Fante", "Cavallo", "Re", "Asso"];
      let deck = [];
      for (let suit of suits) for (let value of values) deck.push({ suit, value });
      deck = deck.sort(() => Math.random() - 0.5);

      let firstPlayerForThisRound = game.lastRoundWinner
        ? game.lastRoundWinner
        : (Math.random() < 0.5 ? player1.socketId : player2.socketId);

      const p1Cards = deck.splice(0, round).map(c => ({ ...c, played: false }));
      const p2Cards = deck.splice(0, round).map(c => ({ ...c, played: false }));

      game.round = round;
      game.deck = deck;
      game.players = {
        [player1.socketId]: {
          name: player1.name, hand: p1Cards, bet: "", playedCard: null,
          score: game.players[player1.socketId]?.score || 0,
          currentRoundWins: 0, revealedCardsCount: 0
        },
        [player2.socketId]: {
          name: player2.name, hand: p2Cards, bet: "", playedCard: null,
          score: game.players[player2.socketId]?.score || 0,
          currentRoundWins: 0, revealedCardsCount: 0
        }
      };
      game.firstToReveal = firstPlayerForThisRound;
      game.lastRoundWinner = null;

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
      try {
        await matchesCollection.updateOne({ roomCode }, { $set: { gameState: game } });
      } catch (error) {
        console.error(`[SERVER ERROR] Persistenza stato round ${roomCode}:`, error);
      }

    } else {
      socket.emit("waitingForOpponentReady", { forPlayer: "self" });
      const room = await matchesCollection.findOne({ roomCode });
      const otherPlayer = room.players.find(p => p.socketId !== socket.id);
      if (otherPlayer) io.to(otherPlayer.socketId).emit("waitingForOpponentReady", { forPlayer: "opponent" });
    }
  });

  // --- Logica: puntata ---
  socket.on("playerBet", ({ roomCode, bet }) => {
    const game = gameStates[roomCode];
    if (!game || !game.players[socket.id]) return;

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
    if (otherId && game.players[otherId]?.bet === "") {
      io.to(otherId).emit("opponentBetPlaced", { opponentBet: bet });
    }
  });

  // --- Logica: giocata carta ---
  socket.on("playerCardPlayed", async ({ roomCode, card, cardIndex }) => {
    let game = gameStates[roomCode];
    if (!game || !game.players[socket.id]) {
      console.warn(`[SERVER] Giocata in stanza non valida o player non trovato. roomCode=${roomCode}, socketId=${socket.id}`);
      return;
    }

    const currentPlayerId = socket.id;
    const player = game.players[currentPlayerId];
    const playerIds = Object.keys(game.players);
    const opponentId = playerIds.find(id => id !== currentPlayerId);
    const opponent = game.players[opponentId];
    if (!opponent) return;

    const cardInHand = player.hand[cardIndex];
    if (!cardInHand || cardInHand.suit !== card.suit || cardInHand.value !== card.value) {
      socket.emit("gameError", "Carta non valida o non nella tua mano!");
      return;
    }
    if (cardInHand.played) {
      socket.emit("gameError", "Hai già giocato questa carta!");
      return;
    }
    if (game.firstToReveal !== currentPlayerId) {
      socket.emit("gameError", "Non è il tuo turno di giocare!");
      return;
    }

    player.playedCard = card;
    player.playedCardIndex = cardIndex;
    player.revealedCardsCount++;
    cardInHand.played = true;

    const bothPlayed = (player.playedCard !== null) && (opponent.playedCard !== null);

    if (bothPlayed) {
      await processPlayedCards(roomCode, io);
    } else {
      game.firstToReveal = opponentId;
      io.to(opponentId).emit("opponentPlayedTheirCard", {
        opponentCard: card, opponentCardIndex: cardIndex
      });
      io.to(currentPlayerId).emit("waitingForOpponentPlay");
    }

    try {
      await matchesCollection.updateOne({ roomCode }, { $set: { gameState: game } });
    } catch (error) {
      console.error(`[SERVER ERROR] Persistenza stato giocata ${roomCode}:`, error);
    }
  });

  // --- Disconnessione con timeout ---
  socket.on("disconnect", async () => {
    console.log("🔴 Disconnessione:", socket.id);
    clearInterval(heartbeatInterval);

    const playerId = socket.data?.playerId;
    if (!playerId) return;

    const roomCode = findRoomBySocketId(socket.id);

    if (roomCode) {
      console.log(`[DISCONNECT] Avviato timer per playerId ${playerId} in stanza ${roomCode}`);
      disconnectionTimers[playerId] = setTimeout(async () => {
        try {
          console.log(`[DISCONNECT] Timeout scaduto per ${playerId}. Rimozione definitiva.`);
          await onlinePlayersCollection.deleteOne({ playerId });

          const room = await matchesCollection.findOne({ roomCode });
          if (room && room.players.length > 1) {
            const others = room.players.filter(p => p.socketId !== socket.id);
            for (const other of others) {
              io.to(other.socketId).emit("opponentDisconnected", { roomCode });
            }
          }

          await matchesCollection.updateOne(
            { roomCode },
            { $pull: { players: { socketId: socket.id } } }
          );

          const updatedRoom = await matchesCollection.findOne({ roomCode });
          if (!updatedRoom || updatedRoom.players.length === 0) {
            await matchesCollection.deleteOne({ roomCode });
            if (gameStates[roomCode]) delete gameStates[roomCode];
            console.log(`🗑️ Stanza ${roomCode} eliminata (vuota)`);
          }
        } catch (err) {
          console.error("❌ Errore cleanup su disconnessione:", err);
        } finally {
          delete disconnectionTimers[playerId];
        }
      }, DISCONNECTION_TIMEOUT);
    } else {
      try {
        await onlinePlayersCollection.deleteOne({ playerId });
      } catch (err) {
        console.error("❌ Errore rimozione giocatore offline:", err);
      }
    }
  });
});

// =========================================================
/** 5. AVVIO SERVER */
// =========================================================
connectToDatabase()
  .then(() => {
    const port = process.env.PORT || 3000;
    server.listen(port, () => {
      console.log(`🚀 Server attivo su http://localhost:${port}`);
    });
  })
  .catch(err => {
    console.error("❌ Errore durante l'avvio del server o la connessione al DB:", err);
  });
