// server.js
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

// 🎮 Socket.io - gestione giocatori online
io.on("connection", (socket) => {
  console.log("🟢 Connessione socket:", socket.id);
  let heartbeatInterval;

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


  const gameStates = {}; // Stato delle partite attive in memoria

 socket.on("startGame", async () => {
  const roomCode = socket.data?.roomCode;
  if (!roomCode) return;

  const room = await matchesCollection.findOne({ roomCode });
  if (!room || room.players.length < 2) return;

  // 🔁 Crea mazzo
  const suits = ["Cuori", "Quadri", "Fiori", "Picche"];
  const values = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  let deck = [];
  for (let suit of suits) {
    for (let value of values) {
      deck.push({ suit, value });
    }
  }

  // Mescola
  deck = deck.sort(() => Math.random() - 0.5);

  const round = 1;
  const [player1, player2] = room.players;
  const p1Cards = deck.splice(0, round);
  const p2Cards = deck.splice(0, round);

  // Scegli casualmente chi inizia
  const first = Math.random() < 0.5 ? player1.socketId : player2.socketId;

  // 🔐 Salva lo stato in memoria
  gameStates[roomCode] = {
    round,
    deck,
    players: {
      [player1.socketId]: {
        name: player1.name,
        hand: p1Cards,
        bet: null,
        playedCard: null,
        score: 0
      },
      [player2.socketId]: {
        name: player2.name,
        hand: p2Cards,
        bet: null,
        playedCard: null,
        score: 0
      }
    },
    firstToReveal: first
  };

  // 📤 Invia le mani ai giocatori
  io.to(player1.socketId).emit("dealCards", {
    yourCards: p1Cards,
    opponentName: player2.name,
    round,
    firstToReveal: first === player1.socketId ? "you" : "opponent"
  });

  io.to(player2.socketId).emit("dealCards", {
    yourCards: p2Cards,
    opponentName: player1.name,
    round,
    firstToReveal: first === player2.socketId ? "you" : "opponent"
  });

  console.log(`🃏 Partita avviata nella stanza ${roomCode}`);
});

  socket.on("playerBet", ({ roomCode, bet }) => {
  const game = gameStates[roomCode];
  if (!game || !game.players[socket.id]) return;

  game.players[socket.id].bet = bet;

  const bets = Object.values(game.players).map(p => p.bet);
  if (bets.every(b => b !== null)) {
    for (let playerSocketId in game.players) {
      const opponentId = Object.keys(game.players).find(id => id !== playerSocketId);
      io.to(playerSocketId).emit("bothBetsPlaced", {
        yourBet: game.players[playerSocketId].bet,
        opponentBet: game.players[opponentId].bet
      });
    }
  }
});

  socket.on("playCard", ({ roomCode, card }) => {
  const game = gameStates[roomCode];
  if (!game || !game.players[socket.id]) return;

  game.players[socket.id].playedCard = card;

  const playerIds = Object.keys(game.players);
  const [p1, p2] = playerIds;
  const card1 = game.players[p1].playedCard;
  const card2 = game.players[p2].playedCard;

  if (card1 && card2) {
    const winnerSocketId = determineWinner(card1, card2);
    if (winnerSocketId) {
      game.players[winnerSocketId].score += 1;
    }

    io.to(roomCode).emit("roundResult", {
      card1,
      card2,
      winner: winnerSocketId,
      scores: {
        [p1]: game.players[p1].score,
        [p2]: game.players[p2].score
      }
    });

    // 🧼 Pulisci per la prossima mano
    game.players[p1].playedCard = null;
    game.players[p2].playedCard = null;
  }
});

  function determineWinner(card1, card2) {
  const valueMap = {
    A: 14, K: 13, Q: 12, J: 11,
    10: 10, 9: 9, 8: 8, 7: 7,
    6: 6, 5: 5, 4: 4, 3: 3, 2: 2
  };
  const suitStrength = {
    Denari: 4,
    Spade: 3,
    Bastoni: 2,
    Coppe: 1
  };

  const value1 = valueMap[card1.value] || parseInt(card1.value);
  const value2 = valueMap[card2.value] || parseInt(card2.value);

  if (value1 > value2) return card1.owner;
  if (value2 > value1) return card2.owner;

  // In caso di parità, vince il seme più forte
  const suit1 = suitStrength[card1.suit] || 0;
  const suit2 = suitStrength[card2.suit] || 0;

  card.owner = socket.id; 
  return suit1 > suit2 ? card1.owner : card2.owner;
}




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
