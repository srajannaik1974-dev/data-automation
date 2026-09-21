require("dotenv").config();
const connectDB = require("./config/db");

const redisConnection = require("./config/redis");

const pipelineRoutes = require("./routes/pipeline");

const express = require("express");

const healthRoutes = require("./routes/health");

const app = express();

app.use(express.json());

app.use("/", healthRoutes);

app.use("/api/pipeline", pipelineRoutes);

const PORT = 5000;

connectDB();

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});