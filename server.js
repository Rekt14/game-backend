// server.js
const express = require("express");
const cors = require("cors");
const { MongoClient } = require("mongodb");

const app = express();
const port = process.env.PORT || 3000;
const uri = process.env.MONGO_URI;
const dbName = "gameDB";
let collection;

// Middleware
app.use(cors());
app.use(express.json());

// Connessione al database una sola volta
async function connectToDatabase() {
  try {
    const client = new MongoClient(uri);
    await client.connect();
    const db = client.db(dbName);
    collection = db.collection("records");
    console.log("✅ Connesso a MongoDB");
  } catch (err) {
    console.error("❌ Errore di connessione a MongoDB:", err);
  }
}

// POST /records → salva un nuovo record
app.post("/records", async (req, res) => {
  const { name, score } = req.body;

  if (!name || typeof score !== "number") {
    return res.status(400).send("Dati non validi");
  }

  try {
    const result = await collection.insertOne({
      name,
      score,
      date: new Date(),
    });
    res.status(200).json({ message: "Record salvato!", id: result.insertedId });
  } catch (err) {
    console.error("❌ Errore nel salvataggio:", err);
    res.status(500).send("Errore nel salvataggio");
  }
});

// GET /records → ottiene i record ordinati
app.get("/records", async (req, res) => {
  try {
    const records = await collection
      .find()
      .sort({ score: -1, date: 1 })
      .limit(5)
      .toArray();
    res.status(200).json(records);
  } catch (err) {
    console.error("❌ Errore nel recupero:", err);
    res.status(500).send("Errore nel recupero");
  }
});

// Avvia il server dopo la connessione
connectToDatabase().then(() => {
  app.listen(port, () => {
    console.log(`🚀 Server avviato su http://localhost:${port}`);
  });
});
