const express = require("express");
const cors = require("cors");
const { MongoClient } = require("mongodb");

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Puoi usare la variabile d'ambiente MONGO_URI o scrivere direttamente l'URI qui:
const uri = process.env.MONGO_URI; 

const client = new MongoClient(uri);
let collection;

async function connectToDB() {
  try {
    await client.connect();
    const db = client.db("test"); // nome del tuo DB
    collection = db.collection("records"); // nome della collection
    console.log("Connesso a MongoDB");
  } catch (err) {
    console.error("Errore di connessione a MongoDB:", err);
  }
}

connectToDB();

// Rotta GET /records
app.get("/records", async (req, res) => {
  try {
    const records = await collection.find({}).toArray();
    res.json(records);
  } catch (err) {
    res.status(500).json({ error: "Errore nel recupero dei dati" });
  }
});

// Avvia il server
app.listen(port, () => {
  console.log(`Server avviato su http://localhost:${port}`);
});
