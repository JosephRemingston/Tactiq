import express from "express";
import { getAdsConfig } from "../controllers/ads.controller.js";
import { optionalAuth } from "../middlewares/auth.middleware.js";

var router = express.Router();

router.get("/config", optionalAuth, getAdsConfig);

export default router;
