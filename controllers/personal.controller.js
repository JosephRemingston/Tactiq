import { z } from "zod";
import asyncHandler from "../utils/asyncHandler.js";
import ApiResponse from "../utils/ApiResponse.js";
import { pageQuery } from "../utils/pagination.js";
import { named } from "../utils/respond.js";
import { COLLECTION_ITEM_TYPES, NOTE_SUBJECT_TYPES } from "../models/index.js";
import { services } from "../services/index.js";

export const schemas = {
  idParam: z.object({ id: z.uuid() }),
  followParams: z.object({ kind: z.enum(["teams", "competitions", "players"]), id: z.uuid() }),
  matchIdParam: z.object({ matchId: z.uuid() }),
  insightIdParam: z.object({ insightId: z.uuid() }),
  conceptKeyParam: z.object({ conceptKey: z.string().regex(/^[a-z0-9-]{2,60}$/) }),
  collectionItemParams: z.object({ id: z.uuid(), itemType: z.enum(COLLECTION_ITEM_TYPES), itemId: z.uuid() }),
  pageQuery: pageQuery(25),
  notesQuery: pageQuery(25).extend({ subjectType: z.enum(NOTE_SUBJECT_TYPES).optional(), subjectId: z.uuid().optional() }),
  noteBody: z.object({ subjectType: z.enum(NOTE_SUBJECT_TYPES), subjectId: z.uuid(), body: z.string().trim().min(1).max(4000) }).strict(),
  notePatch: z.object({ body: z.string().trim().min(1).max(4000) }).strict(),
  collectionBody: z.object({ name: z.string().trim().min(1).max(80), description: z.string().trim().max(500).optional() }).strict(),
  collectionPatch: z
    .object({ name: z.string().trim().min(1).max(80).optional(), description: z.string().trim().max(500).nullable().optional() })
    .strict(),
  itemBody: z.object({ itemType: z.enum(COLLECTION_ITEM_TYPES), itemId: z.uuid(), position: z.number().int().min(0).max(10_000).optional() }).strict(),
  learningBody: z.object({ status: z.enum(["viewed", "saved", "completed"]) }).strict(),
};

// Private user data. The user id always comes from the verified session; foreign or missing resources are 404.

const getFeed = asyncHandler(async (req, res) => {
  const { personal, ads } = services();
  const feed = await personal.feed(req.user.id);
  // Native ad markers between recent matches, only for users whose plan shows ads.
  const adSlots = await ads.slotsFor(req.user.id, "home", feed.recent?.length ?? 0);
  return ApiResponse.success(res, "Feed retrieved successfully", { feed, adSlots });
});

const getFollowing = asyncHandler(async (req, res) => {
  const following = await services().personal.following(req.user.id);
  return ApiResponse.success(res, "Following retrieved successfully", { following });
});

const follow = asyncHandler(async (req, res) => {
  const { kind, id } = req.valid.params;
  const result = await services().personal.follow(req.user.id, kind, id, true);
  return ApiResponse.success(res, "Followed successfully", result);
});

const unfollow = asyncHandler(async (req, res) => {
  const { kind, id } = req.valid.params;
  const result = await services().personal.follow(req.user.id, kind, id, false);
  return ApiResponse.success(res, "Unfollowed successfully", result);
});

const listSavedMatches = asyncHandler(async (req, res) => {
  const q = req.valid.query;
  const result = await services().personal.savedMatches(req.user.id, q.limit, q.cursor);
  return ApiResponse.success(res, "Saved matches retrieved successfully", named("savedMatches", result));
});

const saveMatch = asyncHandler(async (req, res) => {
  const result = await services().personal.saveMatch(req.user.id, req.valid.params.matchId);
  return ApiResponse.success(res, "Match saved successfully", result);
});

const unsaveMatch = asyncHandler(async (req, res) => {
  const result = await services().personal.unsaveMatch(req.user.id, req.valid.params.matchId);
  return ApiResponse.success(res, "Match removed from saved successfully", result);
});

const listSavedInsights = asyncHandler(async (req, res) => {
  const q = req.valid.query;
  const result = await services().personal.savedInsights(req.user.id, q.limit, q.cursor);
  return ApiResponse.success(res, "Saved insights retrieved successfully", named("savedInsights", result));
});

const saveInsight = asyncHandler(async (req, res) => {
  const result = await services().personal.saveInsight(req.user.id, req.valid.params.insightId);
  return ApiResponse.success(res, "Insight saved successfully", result);
});

const unsaveInsight = asyncHandler(async (req, res) => {
  const result = await services().personal.unsaveInsight(req.user.id, req.valid.params.insightId);
  return ApiResponse.success(res, "Insight removed from saved successfully", result);
});

const listNotes = asyncHandler(async (req, res) => {
  const result = await services().personal.listNotes(req.user.id, req.valid.query);
  return ApiResponse.success(res, "Notes retrieved successfully", named("notes", result));
});

const createNote = asyncHandler(async (req, res) => {
  const note = await services().personal.createNote(req.user.id, req.valid.body);
  return ApiResponse.created(res, "Note created successfully", { note });
});

const getNote = asyncHandler(async (req, res) => {
  const note = await services().personal.getNote(req.user.id, req.valid.params.id);
  return ApiResponse.success(res, "Note retrieved successfully", { note });
});

const updateNote = asyncHandler(async (req, res) => {
  const note = await services().personal.updateNote(req.user.id, req.valid.params.id, req.valid.body.body);
  return ApiResponse.success(res, "Note updated successfully", { note });
});

const deleteNote = asyncHandler(async (req, res) => {
  const result = await services().personal.deleteNote(req.user.id, req.valid.params.id);
  return ApiResponse.success(res, "Note deleted successfully", result);
});

const listCollections = asyncHandler(async (req, res) => {
  const result = await services().personal.listCollections(req.user.id);
  return ApiResponse.success(res, "Collections retrieved successfully", named("collections", result));
});

const createCollection = asyncHandler(async (req, res) => {
  const collection = await services().personal.createCollection(req.user.id, req.valid.body);
  return ApiResponse.created(res, "Collection created successfully", { collection });
});

const getCollection = asyncHandler(async (req, res) => {
  const collection = await services().personal.getCollection(req.user.id, req.valid.params.id);
  return ApiResponse.success(res, "Collection retrieved successfully", { collection });
});

const updateCollection = asyncHandler(async (req, res) => {
  const collection = await services().personal.updateCollection(req.user.id, req.valid.params.id, req.valid.body);
  return ApiResponse.success(res, "Collection updated successfully", { collection });
});

const deleteCollection = asyncHandler(async (req, res) => {
  const result = await services().personal.deleteCollection(req.user.id, req.valid.params.id);
  return ApiResponse.success(res, "Collection deleted successfully", result);
});

const addCollectionItem = asyncHandler(async (req, res) => {
  const result = await services().personal.addCollectionItem(req.user.id, req.valid.params.id, req.valid.body);
  return ApiResponse.success(res, "Item added to collection successfully", { collection: result });
});

const removeCollectionItem = asyncHandler(async (req, res) => {
  const { id, itemType, itemId } = req.valid.params;
  const result = await services().personal.removeCollectionItem(req.user.id, id, itemType, itemId);
  return ApiResponse.success(res, "Item removed from collection successfully", { collection: result });
});

const getLearning = asyncHandler(async (req, res) => {
  const result = await services().personal.learning(req.user.id);
  return ApiResponse.success(res, "Learning progress retrieved successfully", named("learning", result));
});

const setLearning = asyncHandler(async (req, res) => {
  const result = await services().personal.setLearning(req.user.id, req.valid.params.conceptKey, req.valid.body.status);
  return ApiResponse.success(res, "Learning progress updated successfully", result);
});

export {
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
};
