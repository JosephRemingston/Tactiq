import { timestamp, uuid } from "drizzle-orm/pg-core";
import { uuidv7 } from "../utils/ids.js";
export const pk = () =>
  uuid()
    .primaryKey()
    .$defaultFn(() => uuidv7());
export const tz = () => timestamp({ withTimezone: true, mode: "date" });
export const timestamps = {
  createdAt: tz().notNull().defaultNow(),
  updatedAt: tz()
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};
