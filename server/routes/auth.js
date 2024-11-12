const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const JWT_SECRET = process.env.JWT_SECRET;
const Joi = require("joi");
const { db } = require("../db/db.js");

const loginSchema = Joi.object({
  username: Joi.string().alphanum().min(3).max(30).required(),
  password: Joi.string()
    .pattern(new RegExp("^[a-zA-Z0-9!@#$%^&*()_+-=\\[\\]{};:'\",.<>?\\/]*$"))
    .min(6)
    .max(50)
    .required(),
});

const router = express.Router();
const secureStatus = process.env.SECURE_STATUS === "true" ? true : false;

const authenticateSocket = (token, callback) => {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    callback(null, { username: decoded.username, role: decoded.role });
  } catch (error) {
    callback(new Error("Authentication error"));
  }
};

const authenticate = (req, res, next) => {
  try {
    const token = req.cookies.token;
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = { username: decoded.username, role: decoded.role };
    next();
  } catch (error) {
    if (req.cookies.token) {
      res.clearCookie("token", {
        httpOnly: true,
        secure: secureStatus,
        sameSite: "strict",
      });
    }
    res.status(401).json({ error: "Invalid session." });
  }
};

router.post("/login", async (req, res) => {
  const { error, value } = loginSchema.validate(req.body);
  if (error) {
    return res.status(400).json({ error: error.details[0].message });
  }
  const { username, password } = value; // Using sanitized and validated inputs
  db.get("SELECT * FROM users WHERE username = ?", [username], (err, user) => {
    if (err) {
      return res.status(500).json({ error: "Database error" });
    }
    if (user && bcrypt.compareSync(password, user.password)) {
      const token = jwt.sign(
        { username: user.username, role: user.role },
        JWT_SECRET,
        { expiresIn: "7d" }
      );
      res.cookie("token", token, {
        httpOnly: true,
        secure: secureStatus,
        sameSite: "strict",
        maxAge: 604800000,
      });
      res.json({ message: "Login successful" });
    } else {
      res.status(401).json({ error: "Invalid username or password" });
    }
  });
});

router.post("/logout", (req, res) => {
  res.clearCookie("token", {
    httpOnly: true,
    secure: secureStatus,
    sameSite: "strict",
  });
  res.json({ message: "Logout successful" });
});

router.get("/validate-session", authenticate, (req, res) => {
  res.json({ message: "Valid session" });
});

module.exports = { router, authenticate, authenticateSocket };
