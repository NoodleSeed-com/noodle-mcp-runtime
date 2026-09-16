import type { AssistantSessionResponse } from './client-contract.js';
import { clientError, isRecord } from './client-errors.js';
import { authorizedHeaders } from './client-request-helpers.js';

type Request = (url: string, init: RequestInit, failureCode: string) => Promise<Response>;
type Turn = Readonly<Record<string, unknown>> & { readonly message: string };
interface PendingTurn {
  readonly token: string;
  readonly requestKey: string;
  readonly turn: Turn;
  operationId?: string;
  executionSent: boolean;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATUSES = new Set(['prepared', 'executing', 'completed', 'denied', 'unknown']);

/** A logical turn survives transport failure. Only an explicit reset discards unresolved authority. */
export class AssistantTurnTransport {
  #pending: PendingTurn | undefined;
  constructor(private readonly request: Request) {}

  reset(): void {
    this.#pending = undefined;
  }
  complete(): void {
    this.#pending = undefined;
  }

  async send(
    session: AssistantSessionResponse,
    turn: Turn,
    signal: AbortSignal,
  ): Promise<Response> {
    if (session.executionAdmission !== 'required')
      return this.post(session.endpoints.turns, session.token, turn, signal, 'text/event-stream');
    const { operations, operationStatus } = session.endpoints;
    if (!operations || !operationStatus)
      throw clientError('invalid_response', 'Assistant operation endpoints are missing', false);
    let pending = this.#pending;
    if (pending && (pending.token !== session.token || pending.turn.message !== turn.message))
      throw clientError(
        'assistant_operation_pending',
        'Resolve the previous turn or start a new conversation.',
        false,
      );
    pending ??= {
      token: session.token,
      requestKey: crypto.randomUUID(),
      turn: structuredClone(turn),
      executionSent: false,
    };
    this.#pending = pending;
    if (pending.executionSent) {
      const response = await this.post(
        operationStatus,
        session.token,
        { operationId: pending.operationId },
        signal,
      );
      const state = await this.readOperation(response);
      if (state.operationId !== pending.operationId)
        throw clientError('invalid_response', 'Assistant returned a different operation', false);
      if (state.status !== 'prepared') {
        if (state.status === 'completed' || state.status === 'denied') this.#pending = undefined;
        throw clientError(
          `assistant_operation_${state.status}`,
          `The previous turn was ${state.status}. It has not been replayed.`,
          false,
        );
      }
      // An explicit retry may deliver the same unclaimed operation, never allocate a replacement.
    } else if (!pending.operationId) {
      const response = await this.post(
        operations,
        session.token,
        { requestKey: pending.requestKey, turn: pending.turn },
        signal,
      );
      if (
        !response.ok &&
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 409
      )
        this.#pending = undefined;
      const operation = await this.readOperation(response);
      pending.operationId = operation.operationId;
      if (operation.status !== 'prepared') {
        pending.executionSent = true;
        throw clientError(
          `assistant_operation_${operation.status}`,
          `Assistant operation is already ${operation.status}`,
          false,
        );
      }
    }
    // Set before I/O: a missing response cannot establish whether execution happened.
    pending.executionSent = true;
    return this.post(
      session.endpoints.turns,
      session.token,
      { ...pending.turn, operationId: pending.operationId },
      signal,
      'text/event-stream',
    );
  }

  private post(
    url: string,
    token: string,
    body: unknown,
    signal: AbortSignal,
    accept = 'application/json',
  ) {
    return this.request(
      url,
      {
        method: 'POST',
        headers: authorizedHeaders(token, accept),
        body: JSON.stringify(body),
        signal,
      },
      'turn_failed',
    );
  }

  private async readOperation(
    response: Response,
  ): Promise<{ operationId: string; status: string }> {
    if (!response.ok)
      throw clientError(
        'assistant_operation_failed',
        `Assistant operation failed (${response.status})`,
        false,
        response.status,
      );
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw clientError('invalid_response', 'Assistant operation response is invalid', false);
    }
    if (
      !isRecord(value) ||
      typeof value.operationId !== 'string' ||
      !UUID.test(value.operationId) ||
      typeof value.status !== 'string' ||
      !STATUSES.has(value.status)
    )
      throw clientError('invalid_response', 'Assistant operation response is invalid', false);
    return { operationId: value.operationId, status: value.status };
  }
}
