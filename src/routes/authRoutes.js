import express from "express";
import { authenticate, validateSession } from "../services/authService.js";

const router = express.Router();

/**
 * User Login Endpoint
 * POST /api/auth/login
 * Body: { username, password }
 */
router.post("/login", (req, res) => {
  const { username, password } = req.body;
  const result = authenticate(username, password);
  if (!result.success) {
    return res.status(401).json(result);
  }
  res.json(result);
});

/**
 * Verify Active Session Token
 * GET /api/auth/verify
 */
router.get("/verify", (req, res) => {
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
  const user = validateSession(token);
  if (!user) {
    return res.status(401).json({ success: false, error: "Session expired or invalid" });
  }
  res.json({ success: true, user });
});

export default router;
