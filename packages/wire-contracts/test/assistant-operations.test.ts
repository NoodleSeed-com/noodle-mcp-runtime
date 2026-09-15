import { describe, expect, it } from 'vitest';
import {
  assistantMessageTurnRequestSchema,
  assistantOperationPrepareSchema,
  assistantOperationStatusSchema,
} from '../src/index.js';

const UUID = '019c6e27-e55b-43d1-87d8-4e01f1f75043';
describe('strict assistant operation wire contracts', () => {
  it('prepares only ordinary strict message turns and canonicalizes correlation keys', () => {
    expect(
      assistantOperationPrepareSchema.parse({
        requestKey: UUID.toUpperCase(),
        turn: { message: 'hello' },
      }),
    ).toEqual({ requestKey: UUID, turn: { message: 'hello' } });
    for (const turn of [
      { resume: true },
      { message: 'hello', operationId: UUID },
      { message: 'hello', policy: {} },
      { message: '  ' },
    ])
      expect(assistantOperationPrepareSchema.safeParse({ requestKey: UUID, turn }).success).toBe(
        false,
      );
    expect(
      assistantOperationPrepareSchema.safeParse({
        requestKey: 'forged',
        turn: { message: 'hello' },
      }).success,
    ).toBe(false);
  });
  it('allows only the server operation identity in status and message execution', () => {
    expect(
      assistantOperationStatusSchema.safeParse({ operationId: UUID, sessionId: 'forged' }).success,
    ).toBe(false);
    expect(
      assistantMessageTurnRequestSchema.parse({ message: 'hello', operationId: UUID.toUpperCase() })
        .operationId,
    ).toBe(UUID);
    expect(
      assistantMessageTurnRequestSchema.safeParse({ message: 'hello', operationId: 'invalid' })
        .success,
    ).toBe(false);
  });
});
