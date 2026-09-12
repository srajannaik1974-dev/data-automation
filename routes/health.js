const express = require("express");

const router = express.Router();

router.get("/", (req, res) => {
    res.send("AI Data Automation API is running");
});

module.exports = router;