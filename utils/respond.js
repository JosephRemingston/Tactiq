/**
 * Shapes a service result for the response envelope: lists go under a named key, never as a bare array
 * and never as `data.data`.
 *   named("teams", [ ... ])                  -> { teams: [ ... ] }
 *   named("teams", { data: [ ... ], page })  -> { teams: [ ... ], page }
 */
export function named(key, result) {
  if (Array.isArray(result)) return { [key]: result };
  if (result && typeof result === "object" && Array.isArray(result.data)) {
    const { data, ...rest } = result;
    return { [key]: data, ...rest };
  }
  return result;
}
