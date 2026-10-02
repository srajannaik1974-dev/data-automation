const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const auth = require("../middleware/auth");

const router = express.Router();

// ---------------------------------------------------------------------------
// Input validation helpers
// ---------------------------------------------------------------------------

/**
 * Returns an error message string if the name is invalid, otherwise null.
 */
function validateName(name) {
    if (!name || typeof name !== "string") return "Name is required.";
    const trimmed = name.trim();
    if (trimmed.length < 1) return "Name cannot be empty.";
    if (trimmed.length > 100) return "Name must not exceed 100 characters.";
    return null;
}

/**
 * Returns an error message string if the email is invalid, otherwise null.
 */
function validateEmail(email) {
    if (!email || typeof email !== "string") return "Email is required.";
    const trimmed = email.trim().toLowerCase();
    // Simple RFC-friendly pattern
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(trimmed)) return "Email address is not valid.";
    return null;
}

/**
 * Returns an error message string if the password is invalid, otherwise null.
 * Requirements: at least 8 characters.
 */
function validatePassword(password) {
    if (!password || typeof password !== "string") return "Password is required.";
    if (password.length < 8) return "Password must be at least 8 characters.";
    if (password.length > 128) return "Password must not exceed 128 characters.";
    return null;
}

// ---------------------------------------------------------------------------
// POST /api/auth/register
// ---------------------------------------------------------------------------
router.post("/register", async (req, res) => {
    try {
        const { name, email, password } = req.body;

        // Validate inputs
        const nameError = validateName(name);
        if (nameError) {
            return res.status(400).json({ error: { code: "INVALID_INPUT", message: nameError } });
        }

        const emailError = validateEmail(email);
        if (emailError) {
            return res.status(400).json({ error: { code: "INVALID_INPUT", message: emailError } });
        }

        const passwordError = validatePassword(password);
        if (passwordError) {
            return res.status(400).json({ error: { code: "INVALID_INPUT", message: passwordError } });
        }

        const normalizedEmail = email.trim().toLowerCase();

        // Reject duplicate email
        const existing = await User.findOne({ email: normalizedEmail });
        if (existing) {
            return res.status(409).json({
                error: { code: "EMAIL_IN_USE", message: "An account with this email already exists." }
            });
        }

        // Hash the password — never store plaintext
        const saltRounds = 12;
        const hashedPassword = await bcrypt.hash(password, saltRounds);

        const user = await User.create({
            name: name.trim(),
            email: normalizedEmail,
            password: hashedPassword
        });

        // Never return the password hash
        return res.status(201).json({
            message: "Account created successfully.",
            user: {
                id: user._id,
                name: user.name,
                email: user.email
            }
        });
    } catch (err) {
        // Catch duplicate key race condition (MongoDB unique index)
        if (err.code === 11000) {
            return res.status(409).json({
                error: { code: "EMAIL_IN_USE", message: "An account with this email already exists." }
            });
        }
        console.error("Register error:", err.message);
        return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Registration failed." } });
    }
});

// ---------------------------------------------------------------------------
// POST /api/auth/login
// ---------------------------------------------------------------------------
router.post("/login", async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || typeof email !== "string") {
            return res.status(400).json({ error: { code: "INVALID_INPUT", message: "Email is required." } });
        }
        if (!password || typeof password !== "string") {
            return res.status(400).json({ error: { code: "INVALID_INPUT", message: "Password is required." } });
        }

        const normalizedEmail = email.trim().toLowerCase();

        // Fetch user with password field (select explicitly — User.findOne excludes nothing by default)
        const user = await User.findOne({ email: normalizedEmail });

        // Use a generic error to avoid user enumeration
        const invalidCredentialsResponse = {
            error: { code: "INVALID_CREDENTIALS", message: "Email or password is incorrect." }
        };

        if (!user) {
            return res.status(401).json(invalidCredentialsResponse);
        }

        // Compare against stored hash — never compare plaintext
        const passwordMatch = await bcrypt.compare(password, user.password);
        if (!passwordMatch) {
            return res.status(401).json(invalidCredentialsResponse);
        }

        // Generate JWT — userId is the only identity claim, never from client body
        const payload = { userId: user._id.toString() };
        const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "7d" });

        // Never return the password hash
        return res.status(200).json({
            message: "Login successful.",
            token,
            user: {
                id: user._id,
                name: user.name,
                email: user.email
            }
        });
    } catch (err) {
        console.error("Login error:", err.message);
        return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Login failed." } });
    }
});

// ---------------------------------------------------------------------------
// GET /api/auth/me  (requires authentication)
// ---------------------------------------------------------------------------
router.get("/me", auth, (req, res) => {
    // req.user is set by auth middleware (password field excluded)
    return res.status(200).json({
        user: {
            id: req.user._id,
            name: req.user.name,
            email: req.user.email
        }
    });
});

module.exports = router;
