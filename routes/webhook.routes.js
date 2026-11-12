import express from "express";
import { receiveClerkWebhook, receiveGooglePlayNotification } from "../controllers/webhook.controller.js";

var router = express.Router();

// Signatures are computed over the exact request bytes, so these routes use a raw body parser
// and are mounted before express.json() in app.js.
const raw = express.raw({ type: "*/*", limit: "1mb" });

router.post("/clerk", raw, receiveClerkWebhook);
router.post("/google-play-rtdn", raw, receiveGooglePlayNotification);

export default router;
