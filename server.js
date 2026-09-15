require("dotenv").config();
const connectDB = require("./config/db");

const redisConnection = require("./config/redis");

const express = require("express");

const healthRoutes = require("./routes/health");

const app = express();

app.use(express.json());

app.use("/", healthRoutes);

const PORT = 5000;

connectDB();

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});