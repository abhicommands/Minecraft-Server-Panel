const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const ROOT_PASSWORD_HASH = process.env.ROOT_PASSWORD_HASH;
const JWT_SECRET = process.env.JWT_SECRET;

const router = express.Router();

const user = {
  admin: {
    username: "admin",
    password: ROOT_PASSWORD_HASH,
  },
};
const authenticateSocket = (token, callback) => {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    callback(null, { username: decoded.username });
  } catch (error) {
    callback(new Error("Authentication error"));
  }
};

const authenticate = (req, res, next) => {
  try {
    const token = req.cookies.token;
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = { username: decoded.username };
    next();
  } catch (error) {
    if (req.cookies.token) {
      res.clearCookie("token", {
        httpOnly: true,
        secure: true,
        sameSite: "strict",
      });
    }
    res.status(401).json({ error: "Invalid session." });
  }
};

router.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (
    username === user.admin.username &&
    bcrypt.compareSync(password, user.admin.password)
  ) {
    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: "7d" });

    res.cookie("token", token, {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      maxAge: 604800000,
    });
    res.json({ message: "Login successful" });
  } else {
    res.status(401).json({ error: "Invalid username or password" });
  }
});

router.post("/logout", (req, res) => {
  res.clearCookie("token", {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
  });
  res.json({ message: "Logout successful" });
});

router.get("/validate-session", authenticate, (req, res) => {
  res.json({ message: "Valid session" });
});

module.exports = { router, authenticate, authenticateSocket };
