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

// STARTROUND
const gameStates = {}; // Se non l'hai già fatto, all'inizio del file

socket.on("startRoundRequest", async () => {
  const roomCode = socket.data?.roomCode;
  if (!roomCode) return;

  const room = await matchesCollection.findOne({ roomCode });
  if (!room || room.players.length < 2) return;

  // Prepara nuovo round
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
  const p1Cards = deck.splice(0, round);
  const p2Cards = deck.splice(0, round);

  const first = Math.random() < 0.5 ? player1.socketId : player2.socketId;

  // Salva stato
  gameStates[roomCode] = {
    round,
    deck,
    players: {
      [player1.socketId]: {
        name: player1.name,
        hand: p1Cards,
        bet: null,
        playedCard: null,
        score: gameStates[roomCode]?.players[player1.socketId]?.score || 0
      },
      [player2.socketId]: {
        name: player2.name,
        hand: p2Cards,
        bet: null,
        playedCard: null,
        score: gameStates[roomCode]?.players[player2.socketId]?.score || 0
      }
    },
    firstToReveal: first
  };

  // Invia dati round a entrambi
  io.to(player1.socketId).emit("startRoundData", {
    round,
    yourCards: p1Cards,
    opponentCardCount: p2Cards.length,
    firstToReveal: first === player1.socketId ? "you" : "opponent"
  });

  io.to(player2.socketId).emit("startRoundData", {
    round,
    yourCards: p2Cards,
    opponentCardCount: p1Cards.length,
    firstToReveal: first === player2.socketId ? "you" : "opponent"
  });

  console.log(`🎯 Round ${round} avviato nella stanza ${roomCode}`);
});

// Gestione Scommesse
  socket.on("playerBet", ({ roomCode, bet }) => {
  const game = gameStates[roomCode];
  if (!game || !game.players[socket.id]) return;

  // 🔐 Salva la scommessa di questo giocatore
  game.players[socket.id].bet = bet;
  console.log(`🎯 ${socket.id} ha scommesso ${bet} nella stanza ${roomCode}`);

  // 🔎 Verifica se anche l'altro ha scommesso
  const playerIds = Object.keys(game.players);
  const allBets = playerIds.map(id => game.players[id].bet);

  // 👥 Se entrambi hanno scommesso, invia a entrambi
  if (allBets.every(b => b !== null)) {
    playerIds.forEach(playerId => {
      const opponentId = playerIds.find(id => id !== playerId);
      io.to(playerId).emit("bothBetsPlaced", {
        yourBet: game.players[playerId].bet,
        opponentBet: game.players[opponentId].bet
      });
    });
    return;
  }

  // ⏳ Se solo uno ha scommesso, avvisa l’altro che tocca a lui
  const otherId = playerIds.find(id => id !== socket.id);
  const otherPlayer = game.players[otherId];
  if (otherPlayer && otherPlayer.bet === null) {
    io.to(otherId).emit("opponentBetPlaced", {
      opponentBet: bet
    });
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
