// server.js
const express = require("express");
const http = require("http"); // <--- per usare http con socket
const cors = require("cors");
const { Server } = require("socket.io");
const { MongoClient, ObjectId } = require("mongodb");

const app = express();
const server = http.createServer(app); // <--- wrap express
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// DB setup
const uri = process.env.MONGO_URI;
const dbName = "gameDB";
let recordsCollection;
let matchesCollection;

app.use(cors());
app.use(express.json());

async function connectToDatabase() {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);
  recordsCollection = db.collection("records");
  matchesCollection = db.collection("matches");
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

// 🎮 Socket.io - eventi realtime
let waitingPlayer = null;

io.on("connection", (socket) => {
  console.log("🟢 Nuovo giocatore:", socket.id);

  if (waitingPlayer) {
    const room = `${waitingPlayer.id}#${socket.id}`;
    socket.join(room);
    waitingPlayer.join(room);
    io.to(room).emit("startGame", { room });
    waitingPlayer = null;
  } else {
    waitingPlayer = socket;
  }

  socket.on("playCard", async (data) => {
    const { room, matchId, player, card } = data;
    try {
      await matchesCollection.updateOne(
        { _id: new ObjectId(matchId) },
        { $push: { moves: { player, card, time: new Date() } } }
      );
    } catch (err) {
      console.error("Errore salvataggio mossa:", err);
    }
    socket.to(room).emit("opponentPlayed", { player, card });
  });

  socket.on("disconnect", () => {
    console.log("🔴 Giocatore disconnesso:", socket.id);
    if (waitingPlayer?.id === socket.id) waitingPlayer = null;
  });
});

// 🚀 Avvia il server
connectToDatabase().then(() => {
  const port = process.env.PORT || 3000;
  server.listen(port, () => {
    console.log(`🚀 Backend + Socket server su http://localhost:${port}`);
  });
});
