import express from "express";
import { schemas as meSchemas, getMe, updateMe, deleteMe, listSessions, revokeSession } from "../controllers/me.controller.js";
import {
  schemas,
  getFeed,
  getFollowing,
  follow,
  unfollow,
  listSavedMatches,
  saveMatch,
  unsaveMatch,
  listSavedInsights,
  saveInsight,
  unsaveInsight,
  listNotes,
  createNote,
  getNote,
  updateNote,
  deleteNote,
  listCollections,
  createCollection,
  getCollection,
  updateCollection,
  deleteCollection,
  addCollectionItem,
  removeCollectionItem,
  getLearning,
  setLearning,
} from "../controllers/personal.controller.js";
import { authenticate } from "../middlewares/auth.middleware.js";
import { validate } from "../middlewares/validate.middleware.js";

var router = express.Router();

// Everything under /me is private to the signed-in user.
router.use(authenticate);

router.get("/", getMe);
router.patch("/", validate({ body: meSchemas.patchMe }), updateMe);
router.delete("/", deleteMe);
router.get("/sessions", listSessions);
router.delete("/sessions/:sessionId", validate({ params: meSchemas.sessionIdParam }), revokeSession);

router.get("/feed", getFeed);

router.get("/following", getFollowing);
router.put("/following/:kind/:id", validate({ params: schemas.followParams }), follow);
router.delete("/following/:kind/:id", validate({ params: schemas.followParams }), unfollow);

router.get("/saved-matches", validate({ query: schemas.pageQuery }), listSavedMatches);
router.put("/saved-matches/:matchId", validate({ params: schemas.matchIdParam }), saveMatch);
router.delete("/saved-matches/:matchId", validate({ params: schemas.matchIdParam }), unsaveMatch);

router.get("/saved-insights", validate({ query: schemas.pageQuery }), listSavedInsights);
router.put("/saved-insights/:insightId", validate({ params: schemas.insightIdParam }), saveInsight);
router.delete("/saved-insights/:insightId", validate({ params: schemas.insightIdParam }), unsaveInsight);

router.get("/notes", validate({ query: schemas.notesQuery }), listNotes);
router.post("/notes", validate({ body: schemas.noteBody }), createNote);
router.get("/notes/:id", validate({ params: schemas.idParam }), getNote);
router.patch("/notes/:id", validate({ params: schemas.idParam, body: schemas.notePatch }), updateNote);
router.delete("/notes/:id", validate({ params: schemas.idParam }), deleteNote);

router.get("/collections", listCollections);
router.post("/collections", validate({ body: schemas.collectionBody }), createCollection);
router.get("/collections/:id", validate({ params: schemas.idParam }), getCollection);
router.patch("/collections/:id", validate({ params: schemas.idParam, body: schemas.collectionPatch }), updateCollection);
router.delete("/collections/:id", validate({ params: schemas.idParam }), deleteCollection);
router.put("/collections/:id/items", validate({ params: schemas.idParam, body: schemas.itemBody }), addCollectionItem);
router.delete("/collections/:id/items/:itemType/:itemId", validate({ params: schemas.collectionItemParams }), removeCollectionItem);

router.get("/learning", getLearning);
router.put("/learning/:conceptKey", validate({ params: schemas.conceptKeyParam, body: schemas.learningBody }), setLearning);

export default router;
