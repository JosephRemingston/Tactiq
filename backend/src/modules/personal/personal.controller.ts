import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { type AuthUser, CurrentUser } from '../../common/auth.decorators';
import { pageQuery } from '../../common/pagination';
import { ApiZod, zp } from '../../common/zod';
import { COLLECTION_ITEM_TYPES, NOTE_SUBJECT_TYPES } from '../../db/schema';
import { type FollowKind, PersonalService } from './personal.service';

const id = zp(z.uuid());
const followKind = zp(z.enum(['teams', 'competitions', 'players']));
const noteBody = z.object({ subjectType: z.enum(NOTE_SUBJECT_TYPES), subjectId: z.uuid(), body: z.string().trim().min(1).max(4000) }).strict();
const notePatch = z.object({ body: z.string().trim().min(1).max(4000) }).strict();
const notesQuery = pageQuery(25).extend({ subjectType: z.enum(NOTE_SUBJECT_TYPES).optional(), subjectId: z.uuid().optional() });
const collectionBody = z.object({ name: z.string().trim().min(1).max(80), description: z.string().trim().max(500).optional() }).strict();
const collectionPatch = z.object({ name: z.string().trim().min(1).max(80).optional(), description: z.string().trim().max(500).nullable().optional() }).strict();
const itemBody = z.object({ itemType: z.enum(COLLECTION_ITEM_TYPES), itemId: z.uuid(), position: z.number().int().min(0).max(10_000).optional() }).strict();
const learningBody = z.object({ status: z.enum(['viewed', 'saved', 'completed']) }).strict();

/** Private user data. user_id always comes from the verified session; foreign or missing resources are 404. */
@ApiTags('me')
@ApiBearerAuth()
@Controller('me')
export class PersonalController {
  constructor(private readonly personal: PersonalService) {}

  @Get('feed')
  feed(@CurrentUser() u: AuthUser) {
    return this.personal.feed(u.id);
  }

  @Get('following')
  following(@CurrentUser() u: AuthUser) {
    return this.personal.following(u.id);
  }

  @Put('following/:kind/:id')
  follow(@CurrentUser() u: AuthUser, @Param('kind', followKind) kind: FollowKind, @Param('id', id) entityId: string) {
    return this.personal.follow(u.id, kind, entityId, true);
  }

  @Delete('following/:kind/:id')
  @HttpCode(200)
  unfollow(@CurrentUser() u: AuthUser, @Param('kind', followKind) kind: FollowKind, @Param('id', id) entityId: string) {
    return this.personal.follow(u.id, kind, entityId, false);
  }

  @Get('saved-matches')
  @ApiZod({ query: pageQuery(25) })
  savedMatches(@CurrentUser() u: AuthUser, @Query(zp(pageQuery(25))) q: z.infer<ReturnType<typeof pageQuery>>) {
    return this.personal.savedMatches(u.id, q.limit, q.cursor);
  }

  @Put('saved-matches/:matchId')
  saveMatch(@CurrentUser() u: AuthUser, @Param('matchId', id) matchId: string) {
    return this.personal.saveMatch(u.id, matchId);
  }

  @Delete('saved-matches/:matchId')
  @HttpCode(200)
  unsaveMatch(@CurrentUser() u: AuthUser, @Param('matchId', id) matchId: string) {
    return this.personal.unsaveMatch(u.id, matchId);
  }

  @Get('saved-insights')
  @ApiZod({ query: pageQuery(25) })
  savedInsights(@CurrentUser() u: AuthUser, @Query(zp(pageQuery(25))) q: z.infer<ReturnType<typeof pageQuery>>) {
    return this.personal.savedInsights(u.id, q.limit, q.cursor);
  }

  @Put('saved-insights/:insightId')
  saveInsight(@CurrentUser() u: AuthUser, @Param('insightId', id) insightId: string) {
    return this.personal.saveInsight(u.id, insightId);
  }

  @Delete('saved-insights/:insightId')
  @HttpCode(200)
  unsaveInsight(@CurrentUser() u: AuthUser, @Param('insightId', id) insightId: string) {
    return this.personal.unsaveInsight(u.id, insightId);
  }

  @Get('notes')
  @ApiZod({ query: notesQuery })
  notes(@CurrentUser() u: AuthUser, @Query(zp(notesQuery)) q: z.infer<typeof notesQuery>) {
    return this.personal.listNotes(u.id, q);
  }

  @Post('notes')
  @ApiZod({ body: noteBody })
  createNote(@CurrentUser() u: AuthUser, @Body(zp(noteBody)) body: z.infer<typeof noteBody>) {
    return this.personal.createNote(u.id, body);
  }

  @Get('notes/:id')
  note(@CurrentUser() u: AuthUser, @Param('id', id) noteId: string) {
    return this.personal.getNote(u.id, noteId);
  }

  @Patch('notes/:id')
  @ApiZod({ body: notePatch })
  updateNote(@CurrentUser() u: AuthUser, @Param('id', id) noteId: string, @Body(zp(notePatch)) body: z.infer<typeof notePatch>) {
    return this.personal.updateNote(u.id, noteId, body.body);
  }

  @Delete('notes/:id')
  @HttpCode(200)
  deleteNote(@CurrentUser() u: AuthUser, @Param('id', id) noteId: string) {
    return this.personal.deleteNote(u.id, noteId);
  }

  @Get('collections')
  collections(@CurrentUser() u: AuthUser) {
    return this.personal.listCollections(u.id);
  }

  @Post('collections')
  @ApiZod({ body: collectionBody })
  createCollection(@CurrentUser() u: AuthUser, @Body(zp(collectionBody)) body: z.infer<typeof collectionBody>) {
    return this.personal.createCollection(u.id, body);
  }

  @Get('collections/:id')
  collection(@CurrentUser() u: AuthUser, @Param('id', id) collectionId: string) {
    return this.personal.getCollection(u.id, collectionId);
  }

  @Patch('collections/:id')
  @ApiZod({ body: collectionPatch })
  updateCollection(@CurrentUser() u: AuthUser, @Param('id', id) collectionId: string, @Body(zp(collectionPatch)) body: z.infer<typeof collectionPatch>) {
    return this.personal.updateCollection(u.id, collectionId, body);
  }

  @Delete('collections/:id')
  @HttpCode(200)
  deleteCollection(@CurrentUser() u: AuthUser, @Param('id', id) collectionId: string) {
    return this.personal.deleteCollection(u.id, collectionId);
  }

  @Put('collections/:id/items')
  @ApiZod({ body: itemBody })
  addItem(@CurrentUser() u: AuthUser, @Param('id', id) collectionId: string, @Body(zp(itemBody)) body: z.infer<typeof itemBody>) {
    return this.personal.addCollectionItem(u.id, collectionId, body);
  }

  @Delete('collections/:id/items/:itemType/:itemId')
  @HttpCode(200)
  removeItem(@CurrentUser() u: AuthUser, @Param('id', id) collectionId: string, @Param('itemType', zp(z.enum(COLLECTION_ITEM_TYPES))) itemType: (typeof COLLECTION_ITEM_TYPES)[number], @Param('itemId', id) itemId: string) {
    return this.personal.removeCollectionItem(u.id, collectionId, itemType, itemId);
  }

  @Get('learning')
  learning(@CurrentUser() u: AuthUser) {
    return this.personal.learning(u.id);
  }

  @Put('learning/:conceptKey')
  @ApiZod({ body: learningBody })
  setLearning(@CurrentUser() u: AuthUser, @Param('conceptKey', zp(z.string().regex(/^[a-z0-9-]{2,60}$/))) key: string, @Body(zp(learningBody)) body: z.infer<typeof learningBody>) {
    return this.personal.setLearning(u.id, key, body.status);
  }
}
