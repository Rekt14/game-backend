// server.js
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

// MongoDB connection
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

// Schema
const Record = mongoose.model("Record", {
  name: String,
  score: Number,
  date: { type: Date, default: Date.now },
});

// Get top 10 records
app.get("/records", async (req, res) => {
  const records = await Record.find().sort({ score: -1 }).limit(10);
  res.json(records);
});

// Add a record
app.post("/records", async (req, res) => {
  const { name, score } = req.body;
  const newRecord = new Record({ name, score });
  await newRecord.save();
  res.status(201).json({ message: "Record salvato!" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server attivo su porta", PORT));
