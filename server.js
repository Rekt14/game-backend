// server.js
const express = require("express");
const cors = require("cors");
const { MongoClient } = require("mongodb");

const app = express();
const port = process.env.PORT || 3000;
const uri = process.env.MONGO_URI;

const client = new MongoClient(uri);
const dbName = "gameDB";

app.use(cors());
app.use(express.json());

// Aggiungi un nuovo record
app.post("/add-record", async (req, res) => {
  const { name, score } = req.body;
  try {
    await client.connect();
    const db = client.db(dbName);
    const collection = db.collection("records");
    await collection.insertOne({ name, score, date: new Date() });
    res.status(200).send("Record salvato!");
  } catch (err) {
    console.error(err);
    res.status(500).send("Errore nel salvataggio");
  }
});

// Ottieni tutti i record
app.get("/records", async (req, res) => {
  try {
    await client.connect();
    const db = client.db(dbName);
    const records = await db.collection("records").find().sort({ score: -1 }).limit(5).toArray();
    res.status(200).json(records);
  } catch (err) {
    res.status(500).send("Errore nel recupero");
  }
});

app.listen(port, () => {
  console.log(`Server in ascolto sulla porta ${port}`);
});
