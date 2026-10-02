const jwt = require("jsonwebtoken");
const User = require("../models/User");

/**
 * Authentication middleware.
 * Reads Bearer token from Authorization header, verifies it,
 * and attaches the authenticated user document to req.user.
 *
 * Never trusts a userId supplied by the client body/query —
 * identity always comes from the verified JWT payload.
 */
const auth = async (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({
            error: { code: "MISSING_TOKEN", message: "Authentication required. Provide a Bearer token." }
        });
    }

    const token = authHeader.slice(7); // Remove "Bearer " prefix

    if (!token) {
        return res.status(401).json({
            error: { code: "MISSING_TOKEN", message: "Authentication required. Token is empty." }
        });
    }

    try {
        const payload = jwt.verify(token, process.env.JWT_SECRET);

        // payload.userId is the only source of identity — never from req.body
        const user = await User.findById(payload.userId).select("-password");

        if (!user) {
            return res.status(401).json({
                error: { code: "USER_NOT_FOUND", message: "Token refers to a user that no longer exists." }
            });
        }

        req.user = user;
        next();
    } catch (err) {
        if (err.name === "TokenExpiredError") {
            return res.status(401).json({
                error: { code: "TOKEN_EXPIRED", message: "Token has expired. Please log in again." }
            });
        }
        // JsonWebTokenError, NotBeforeError, or any other JWT error
        return res.status(401).json({
            error: { code: "INVALID_TOKEN", message: "Token is invalid or malformed." }
        });
    }
};

module.exports = auth;
