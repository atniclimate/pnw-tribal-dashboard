import type {
  AlertEventIdentity,
  AlertLifecycleRejection,
  AlertLifecycleResolution,
  AlertLifecycleState,
  AlertTombstone,
  NormalizedAlert,
} from './model.js';

interface MutableEvent {
  eventId: string;
  current: NormalizedAlert | null;
  tombstones: AlertTombstone[];
  memberAlertIds: string[];
  lifecycleState: AlertLifecycleState;
}

function parseSent(alert: NormalizedAlert): number {
  const parsed = Date.parse(alert.sent);
  if (Number.isNaN(parsed)) throw new Error(`Alert sent is not a parseable timestamp: "${alert.sent}"`);
  return parsed;
}

function freezeEvent(event: MutableEvent): AlertEventIdentity {
  return Object.freeze({
    eventId: event.eventId,
    lifecycleState: event.lifecycleState,
    current: event.current,
    tombstones: Object.freeze(event.tombstones.map((item) => Object.freeze({ ...item }))),
    memberAlertIds: Object.freeze([...event.memberAlertIds]),
  });
}

/**
 * Resolves messages in arrival order. CAP references alias every update/cancel to
 * one stable event identity. Older arrivals cannot roll an event backward.
 */
export function resolveAlertLifecycle(
  messages: readonly NormalizedAlert[],
  asOf?: string,
): AlertLifecycleResolution {
  const events = new Map<string, MutableEvent>();
  const aliases = new Map<string, string>();
  const seenIds = new Set<string>();
  const rejected: AlertLifecycleRejection[] = [];

  for (const message of messages) {
    if (seenIds.has(message.alertId)) {
      rejected.push({ alertId: message.alertId, eventId: message.eventId, reason: 'duplicate-id' });
      continue;
    }

    const referencedEventIds = message.references
      .map((reference) => aliases.get(reference))
      .filter((eventId): eventId is string => eventId !== undefined);
    const requestedEventId = referencedEventIds[0] ?? message.references[0] ?? message.eventId;

    const existing = events.get(requestedEventId);
    if (existing?.current !== null && existing?.current !== undefined) {
      if (parseSent(message) < parseSent(existing.current)) {
        rejected.push({ alertId: message.alertId, eventId: requestedEventId, reason: 'older-sent' });
        continue;
      }
      if (parseSent(message) === parseSent(existing.current)) {
        rejected.push({ alertId: message.alertId, eventId: requestedEventId, reason: 'older-sent' });
        continue;
      }
    }

    const event = existing ?? {
      eventId: requestedEventId,
      current: null,
      tombstones: [],
      memberAlertIds: [],
      lifecycleState: 'active' as const,
    };

    if (event.current !== null) {
      event.tombstones.push({
        alertId: event.current.alertId,
        eventId: event.eventId,
        sent: event.current.sent,
        state: message.messageType === 'cancel' ? 'cancelled' : 'superseded',
        replacedByAlertId: message.alertId,
      });
    }

    const lifecycleState: AlertLifecycleState = message.messageType === 'cancel' ? 'cancelled' : 'active';
    const current = Object.freeze({ ...message, eventId: event.eventId, lifecycleState });
    event.current = current;
    event.lifecycleState = lifecycleState;
    event.memberAlertIds.push(message.alertId);
    events.set(event.eventId, event);
    aliases.set(message.alertId, event.eventId);
    for (const reference of message.references) aliases.set(reference, event.eventId);
    seenIds.add(message.alertId);
  }

  if (asOf !== undefined) {
    const asOfTime = Date.parse(asOf);
    if (Number.isNaN(asOfTime)) throw new Error(`Lifecycle asOf is not a parseable timestamp: "${asOf}"`);
    for (const event of events.values()) {
      if (
        event.lifecycleState === 'active' &&
        event.current?.expires !== null &&
        event.current?.expires !== undefined &&
        Date.parse(event.current.expires) <= asOfTime
      ) {
        event.current = Object.freeze({ ...event.current, lifecycleState: 'expired' });
        event.lifecycleState = 'expired';
      }
    }
  }

  return Object.freeze({
    events: Object.freeze([...events.values()].map(freezeEvent)),
    rejected: Object.freeze(rejected.map((item) => Object.freeze({ ...item }))),
  });
}
