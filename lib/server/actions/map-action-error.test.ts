import { describe, expect, it } from 'vitest'
import { Prisma } from '@prisma/client'
import { ZodError } from 'zod'
import { mapCommonActionError } from './map-action-error'

function knownRequestError(code: string) {
  return new Prisma.PrismaClientKnownRequestError('nope', { code, clientVersion: 'test' })
}

describe('mapCommonActionError', () => {
  it('maps a ZodError to INVALID_INPUT', () => {
    expect(mapCommonActionError(new ZodError([]))).toEqual({ ok: false, error: 'INVALID_INPUT' })
  })

  it('maps Prisma P2025 to NOT_FOUND', () => {
    expect(mapCommonActionError(knownRequestError('P2025'))).toEqual({
      ok: false,
      error: 'NOT_FOUND',
    })
  })

  /**
   * The load-bearing assertions. An unmapped failure MUST surface as a thrown
   * error — turning one into a friendly `{ ok: false }` would hide every real
   * bug behind "something went wrong" and is the drift this helper exists to
   * make impossible in eight places at once.
   */
  it('rethrows any other Prisma known-request error, including a unique-constraint violation', () => {
    const conflict = knownRequestError('P2002')
    expect(() => mapCommonActionError(conflict)).toThrow(conflict)
  })

  it('rethrows a plain Error', () => {
    const boom = new Error('boom')
    expect(() => mapCommonActionError(boom)).toThrow(boom)
  })

  it('rethrows a non-Error value unchanged, rather than swallowing it', () => {
    expect(() => mapCommonActionError('a string')).toThrow('a string')

    // `undefined` cannot be asserted through `toThrow`, so the throw itself is
    // what is observed: `threw` stays false if the helper ever decided to
    // return a friendly result for a value it does not recognise.
    let threw = false
    let caught: unknown = 'untouched'
    try {
      mapCommonActionError(undefined)
    } catch (e) {
      threw = true
      caught = e
    }
    expect(threw).toBe(true)
    expect(caught).toBeUndefined()
  })
})
