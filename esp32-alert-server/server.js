import express from "express";
import multer from "multer";
import twilio from "twilio";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const required = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_FROM",
  "ALERT_TO",
  "DEVICE_TOKEN",
  "PUBLIC_BASE_URL"
];

for (const name of required) {
  if (!process.env[name]) {
    console.error(`Missing environment variable: ${name}`);
    process.exit(1);
  }
}

const app = express();
const port = Number(process.env.PORT || 3000);
const imageDir = path.resolve("images");
const linkLifetimeMs = 24 * 60 * 60 * 1000;

fs.mkdirSync(imageDir, { recursive: true });

const links = new Map();
const sms = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const storage = multer.diskStorage({
  destination: (_req, _file, done) => done(null, imageDir),
  filename: (_req, _file, done) => {
    const id = crypto.randomBytes(24).toString("hex");
    done(null, `${id}.jpg`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, done) => {
    if (file.mimetype !== "image/jpeg") {
      return done(new Error("JPEG images only"));
    }
    done(null, true);
  }
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/capture", (req, res) => {
  upload.single("image")(req, res, async (error) => {
    if (error) {
      return res.status(400).json({ error: error.message });
    }

    if (req.get("X-Device-Token") !== process.env.DEVICE_TOKEN) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(401).json({ error: "Invalid device token" });
    }

    if (!req.file) {
      return res.status(400).json({ error: "Image missing" });
    }

    const imageId = path.basename(req.file.filename, ".jpg");
    const accessToken = crypto.randomBytes(32).toString("hex");
    const expiresAt = Date.now() + linkLifetimeMs;

    links.set(accessToken, { imageId, expiresAt });

    const baseUrl = process.env.PUBLIC_BASE_URL.replace(/\/+$/, "");
    const imageLink = `${baseUrl}/image/${accessToken}`;

    try {
      const message = await sms.messages.create({
        from: process.env.TWILIO_FROM,
        to: process.env.ALERT_TO,
        body: `ESP32-CAM alert: an image was captured. View the private image (link expires in 24 hours): ${imageLink}`
      });

      console.log(`SMS accepted by provider: ${message.sid}`);
      res.json({ ok: true, expiresInHours: 24 });
    } catch (sendError) {
      console.error("SMS provider error:", sendError.message);
      links.delete(accessToken);
      fs.unlink(req.file.path, () => {});
      res.status(502).json({ error: "SMS send failed" });
    }
  });
});

app.get("/image/:token", (req, res) => {
  const entry = links.get(req.params.token);

  if (!entry || Date.now() > entry.expiresAt) {
    links.delete(req.params.token);
    return res.status(404).send("This private image link has expired or is invalid.");
  }

  const filePath = path.join(imageDir, `${entry.imageId}.jpg`);

  if (!fs.existsSync(filePath)) {
    links.delete(req.params.token);
    return res.status(404).send("Image is no longer available.");
  }

  res.setHeader("Cache-Control", "no-store");
  res.type("jpg").sendFile(filePath);
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Server listening on port ${port}`);
});
