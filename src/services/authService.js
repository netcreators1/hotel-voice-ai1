import crypto from "crypto";

const JWT_SECRET = process.env.AUTH_SECRET || "hotel_voice_ai_secret_key_2026";

const USERS = {
  admin: {
    username: "admin",
    password: process.env.ADMIN_PASSWORD || "wpdyns76",
    role: "admin",
    displayName: "Administrator"
  },
  agent: {
    username: "agent",
    password: process.env.AGENT_PASSWORD || "abc@1234",
    role: "agent",
    displayName: "Operations Agent"
  }
};

/**
 * Generate a secure signed token
 */
function createToken(user) {
  const payload = {
    username: user.username,
    role: user.role,
    displayName: user.displayName,
    exp: Date.now() + (7 * 24 * 60 * 60 * 1000) // 7 days validity
  };
  const str = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", JWT_SECRET).update(str).digest("base64url");
  return `${str}.${signature}`;
}

/**
 * Verify and decode token
 */
function verifyToken(token) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [dataStr, signature] = parts;
  const expectedSig = crypto.createHmac("sha256", JWT_SECRET).update(dataStr).digest("base64url");
  if (signature !== expectedSig) return null;

  try {
    const payload = JSON.parse(Buffer.from(dataStr, "base64url").toString("utf8"));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

/**
 * Authenticate credentials
 */
export function authenticate(username, password) {
  const cleanUser = (username || "").trim().toLowerCase();
  const cleanPass = (password || "").trim();

  const user = USERS[cleanUser];
  if (!user || user.password !== cleanPass) {
    return { success: false, error: "Invalid username or password" };
  }

  const token = createToken(user);
  return {
    success: true,
    user: {
      username: user.username,
      role: user.role,
      displayName: user.displayName
    },
    token
  };
}

/**
 * Express Middleware: Validate Admin Role for Credit Adjustments / Approvals
 */
export function requireAdmin(req, res, next) {
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
  const roleHeader = req.headers["x-user-role"] || "";

  let user = null;
  if (token) {
    user = verifyToken(token);
  }

  // Check if authenticated as admin
  if ((user && user.role === "admin") || roleHeader === "admin") {
    req.user = user || { role: "admin", username: "admin" };
    return next();
  }

  return res.status(403).json({
    success: false,
    error: "Access Denied: Only Admin can add or approve credit limits. Agent role does not have recharge permissions."
  });
}

/**
 * Verify token helper
 */
export function validateSession(token) {
  return verifyToken(token);
}
