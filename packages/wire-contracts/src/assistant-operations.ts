import { z } from 'zod';
import { assistantMessageTurnRequestSchema } from './assistant.js';

export const assistantOperationPrepareSchema = z
  .object({
    requestKey: z.uuid().toLowerCase(),
    turn: assistantMessageTurnRequestSchema.omit({ operationId: true }),
  })
  .strict();
export const assistantOperationStatusSchema = z
  .object({ operationId: z.uuid().toLowerCase() })
  .strict();
export const assistantOperationSchema = z
  .object({
    operationId: z.uuid().toLowerCase(),
    status: z.enum(['prepared', 'executing', 'completed', 'denied', 'unknown']),
  })
  .strict();
