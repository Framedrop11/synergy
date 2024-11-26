const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const bcrypt = require("bcrypt");

const app = express();
const PORT = 5001;

const User = require("./UserDetails");
const Medication = require("./MedicationDetails"); 

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'PUT'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

const mongoUrl = "mongodb+srv://Mriganka:Mriganka%401110@synergybase.bkh2z.mongodb.net/?retryWrites=true&w=majority&appName=synergyBase";

mongoose
  .connect(mongoUrl, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => {
    console.log("Database connected");
  })
  .catch((err) => {
    console.log("Error connecting to database:", err);
  });

app.get("/", (req, res) => {
  res.send({ status: "Started" });
});

app.post("/register", async (req, res) => {
  const { name, email, phone, password } = req.body;

  try {
    const oldUser = await User.findOne({ email });
    if (oldUser) return res.status(400).json({ error: "User already exists!" });

    const hashedPassword = await bcrypt.hash(password, 10);
    await User.create({ name, email, phone, password: hashedPassword });
    res.status(201).json({ message: "User created successfully" });
  } catch (error) {
    console.error("Error during registration:", error);
    res.status(500).json({ error: "Failed to register user" });
  }
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  console.log("Login request received:", { email, password });

  try {
    const user = await User.findOne({ email });
    console.log("User found:", user);

    if (!user) return res.status(400).json({ message: 'User not found' });

    const isPasswordValid = await bcrypt.compare(password, user.password);
    console.log("Password valid:", isPasswordValid);

    if (!isPasswordValid) return res.status(400).json({ message: 'Invalid credentials' });

    res.status(200).json({ userId: user._id, message: 'Login successful' });
  } catch (error) {
    console.error("Error during login:", error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post("/addMedication", async (req, res) => {
  const { medicationName, time, repeating } = req.body;
  console.log("Received medication data:", { medicationName, time, repeating });

  try {
    if (!medicationName || !time) {
      return res.status(400).json({
        success: false,
        error: "Medication name and time are required",
      });
    }

    const newMedication = new Medication({
      medicationName,
      time: new Date(time),
      repeating
    });

    await newMedication.save();
    console.log("Medication saved successfully:", newMedication);
    console.log(newMedication._id.toHexString());

    res.status(201).json({
      success: true,
      message: "Medication added successfully",
      medication: newMedication,
      medicationId: newMedication._id.toHexString(),
    });
  } catch (error) {
    console.error("Error adding medication:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to add medication",
    });
  }
});

// app.get('/getReminders', async (req, res) => {
//   try {
//     const reminders = await Medication.find({ userId: req.user.id }); // Replace with actual user identification logic
//     res.status(200).json({ reminders });
//   } catch (error) {
//     console.error('Error fetching reminders:', error);
//     res.status(500).json({ error: 'Failed to fetch reminders.' });
//   }
// });



app.delete("/deleteMedication/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const deletedMedication = await Medication.findByIdAndDelete(id);
    if (!deletedMedication) {
      return res.status(404).json({ success: false, error: "Medication not found" });
    }
    res.status(200).json({ success: true, message: "Medication deleted successfully" });
  } catch (error) {
    console.error("Error deleting medication:", error);
    res.status(500).json({ success: false, error: "Failed to delete medication" });
  }
});


app.listen(PORT, "0.0.0.0", () => {
  console.log("Node server is running on port 5001");
});