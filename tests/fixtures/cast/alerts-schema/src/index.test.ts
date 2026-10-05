import { describe, expect, it } from 'vitest';
import {
  compareSeverityBands,
  createAlertEventGroup,
  mapEcccAlert,
  mapNwsAlert,
  normalizeCapAlert,
  normalizeCertainty,
  normalizeSeverity,
  normalizeUrgency,
  resolveAlertLifecycle,
  type NormalizedAlert,
} from './index.js';

function alert(
  alertId: string,
  sent: string,
  messageType: NormalizedAlert['messageType'] = 'alert',
  references: readonly string[] = [],
): NormalizedAlert {
  return {
    alertId,
    eventId: alertId,
    sourceId: 'nws',
    sent,
    messageType,
    references,
    lifecycleState: 'active',
    event: 'Flood Warning',
    originalDesignation: 'Flood Warning',
    band: 'severe',
    posture: 'act-now',
    confidence: 'likely',
    effective: sent,
    expires: '2026-07-18T00:00:00Z',
    geometry: null,
    sourceLanguage: {
      'en-US': { headline: 'Flood Warning', description: 'River flooding is expected.' },
    },
    translationAuthority: 'National Weather Service',
    provenance: {
      agency: 'nws',
      originalId: alertId.replace('nws:', ''),
      fetchedAt: '2026-07-17T12:00:00Z',
      mappingApplied: { name: 'atni-cast-nws-cap', version: '1.0.0' },
      coverage: { geometryBasis: 'zone', geocodes: ['WAZ001'] },
    },
  };
}

describe('ratified severity and mapping semantics', () => {
  it('never ranks unstated against a ranked band', () => {
    expect(compareSeverityBands('unstated', 'minor')).toBeNull();
    expect(compareSeverityBands('extreme', 'unstated')).toBeNull();
    expect(compareSeverityBands('severe', 'moderate')).toBeGreaterThan(0);
  });

  it('uses ECCC precedence MSC_Impact, then Colour, then base CAP severity', () => {
    expect(mapEcccAlert({ mscImpact: 'High', colour: 'Yellow', severity: 'Minor' }).band).toBe(
      'severe',
    );
    expect(mapEcccAlert({ colour: 'Orange', severity: 'Minor' }).band).toBe('severe');
    expect(mapEcccAlert({ severity: 'Moderate' }).band).toBe('moderate');
    expect(mapEcccAlert({ mscImpact: 'modéré', colour: 'jaune' }).band).toBe('moderate');
  });

  it('does not infer impact band from an agency product title', () => {
    const mapped = mapNwsAlert({ event: 'Catastrophic Flood Warning' });
    expect(mapped.band).toBe('unstated');
    expect(mapped.posture).toBe('act-now');
  });

  it('groups without merging and labels the highest member band', () => {
    const group = createAlertEventGroup('columbia-1', [
      { alertId: 'nws:1', band: 'moderate' },
      { alertId: 'eccc:1', band: 'severe' },
    ]);
    expect(group.memberAlertIds).toEqual(['nws:1', 'eccc:1']);
    expect(group.highest).toEqual({ band: 'severe', memberCount: 2 });
  });
});

describe('alert lifecycle resolution', () => {
  it('rejects an older sent message for the same event identity', () => {
    const original = alert('nws:original', '2026-07-17T10:00:00Z');
    const newest = alert('nws:newest', '2026-07-17T12:00:00Z', 'update', [original.alertId]);
    const delayed = alert('nws:delayed', '2026-07-17T11:00:00Z', 'update', [original.alertId]);

    const resolution = resolveAlertLifecycle([original, newest, delayed]);

    expect(resolution.events).toHaveLength(1);
    expect(resolution.events[0]?.current?.alertId).toBe(newest.alertId);
    expect(resolution.rejected).toEqual([
      { alertId: delayed.alertId, eventId: original.alertId, reason: 'older-sent' },
    ]);
  });

  it('resolves update and cancel references to one identity with tombstones', () => {
    const original = alert('nws:original', '2026-07-17T10:00:00Z');
    const update = alert('nws:update', '2026-07-17T11:00:00Z', 'update', [original.alertId]);
    const cancel = alert('nws:cancel', '2026-07-17T12:00:00Z', 'cancel', [update.alertId]);

    const resolution = resolveAlertLifecycle([original, update, cancel]);

    expect(resolution.events).toHaveLength(1);
    expect(resolution.events[0]).toMatchObject({
      eventId: original.alertId,
      lifecycleState: 'cancelled',
      memberAlertIds: [original.alertId, update.alertId, cancel.alertId],
    });
    expect(resolution.events[0]?.current).toMatchObject({
      alertId: cancel.alertId,
      eventId: original.alertId,
      lifecycleState: 'cancelled',
    });
    expect(resolution.events[0]?.tombstones).toEqual([
      {
        alertId: original.alertId,
        eventId: original.alertId,
        sent: original.sent,
        state: 'superseded',
        replacedByAlertId: update.alertId,
      },
      {
        alertId: update.alertId,
        eventId: original.alertId,
        sent: update.sent,
        state: 'cancelled',
        replacedByAlertId: cancel.alertId,
      },
    ]);
  });

  it('derives identity from a CAP reference when the original is outside the replay window', () => {
    const update = alert('nws:update', '2026-07-17T11:00:00Z', 'update', ['nws:original']);
    const resolution = resolveAlertLifecycle([update]);

    expect(resolution.rejected).toEqual([]);
    expect(resolution.events[0]).toMatchObject({
      eventId: 'nws:original',
      memberAlertIds: ['nws:update'],
    });
  });
});

describe('deprecated compatibility normalizers', () => {
  const shaped = {
    id: 'urn:oid:2.49.0.1.840.0.demo',
    sender: 'w-nws.webmaster@noaa.gov',
    sent: '2026-07-14T10:00:00-07:00',
    event: 'Flood Warning',
    severity: 'Severe',
    urgency: 'Expected',
    certainty: 'Likely',
    geometry: null,
  };

  it('keeps the old symbols behaviorally available during migration', () => {
    expect(normalizeSeverity('Severe')).toBe('severe');
    expect(normalizeUrgency('Immediate')).toBe('immediate');
    expect(normalizeCertainty('Likely')).toBe('likely');
    expect(normalizeCapAlert(shaped, 'us')).toMatchObject({
      id: 'us:urn:oid:2.49.0.1.840.0.demo',
      sourceRegion: 'us',
      effective: shaped.sent,
    });
  });
});
