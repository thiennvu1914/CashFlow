import { Prisma } from '@prisma/client'
import { ZodError } from 'zod'

/**
 * The tail every action module's private `mapError` ended with, byte-identical
 * eight times (pre-flight A-5).
 *
 * The DOMAIN branches above it are genuinely per-module and stay where they
 * are — this is only the shared last three decisions, and the reason to have
 * one copy is that they encode an invariant, not a convenience:
 *
 *   1. a `ZodError` is the server re-validating input the client already
 *      validated, so it is a refusal the form can render, not a defect;
 *   2. a Prisma `P2025` ("record not found") is what a foreign or deleted id
 *      resolves to, because every service read goes through the composite
 *      `(userId, id)` key — so another user's id can only ever be a NOT_FOUND,
 *      never a usable reference;
 *   3. `throw e` — the load-bearing line. Anything NOT mapped above must reach
 *      Next's error boundary as a thrown error. Eight copies were eight
 *      chances for someone to "helpfully" add a
 *      `return { ok: false, error: 'UNKNOWN' }` fallback and silently convert
 *      every unexpected bug into a friendly sentence.
 *
 * The return type names the two codes literally rather than being generic over
 * each module's error union: every one of the eight unions contains both
 * `INVALID_INPUT` and `NOT_FOUND`, so the narrow literal type is assignable to
 * all eight `…ActionResult`s with no cast and no type parameter.
 */
export function mapCommonActionError(e: unknown): {
  ok: false
  error: 'INVALID_INPUT' | 'NOT_FOUND'
} {
  if (e instanceof ZodError) return { ok: false, error: 'INVALID_INPUT' }
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
    return { ok: false, error: 'NOT_FOUND' }
  }
  throw e
}
