import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  MAX_HISTORY_EVENTS,
  SNAPSHOT_SCHEMA_VERSION,
  WIRE_SCHEMA_VERSION,
  type AdmissionEvent,
  type AdmissionLease,
  type AdmissionLimits,
  type AdmissionMode,
  type AdmissionOperation,
  type AdmissionSnapshot,
  type AdmissionUsage,
  type SnapshotGetRequest,
  type SnapshotWatchRequest,
} from '../src/types.js';

import {
  DEFAULT_CONFIG,
  resolveConfig,
  type Config,
  type ConfigInput,
} from '../src/host/config.js';

import {
  ADMISSION_ERROR_CODES,
  createAdmissionDenied,
  type AdmissionDenied,
  type AdmissionErrorCode,
} from '../src/host/errors.js';

import type {
  SubagentAdmissionPermitV1,
  SubagentAdmissionPolicyV1,
  SubagentAdmissionRequestV1,
} from '../src/host/seam-v1.js';

const ERROR_CODE_NAMES = [
  'ADMISSION_UNAVAILABLE',
  'ADMISSION_CLOSED',
  'ADMISSION_STATE_IO',
  'ADMISSION_BINDING_CONFLICT',
  'ROOT_TOTAL_LIMIT',
  'PARENT_CHILD_LIMIT',
  'ROOT_ACTIVE_LIMIT',
  'GLOBAL_ACTIVE_LIMIT',
] as const;

describe('Task 2A admission contracts', () => {
  describe('wire vocabulary', () => {
    it('declares the operation and mode unions', () => {
      expectTypeOf<AdmissionOperation>().toEqualTypeOf<
        'new-one-shot' | 'new-continuable' | 'cold-resume'
      >();
      expectTypeOf<AdmissionMode>().toEqualTypeOf<
        'strict' | 'audit' | 'unavailable' | 'draining'
      >();
    });

    it('declares readonly plain limits', () => {
      expectTypeOf<AdmissionLimits>().toEqualTypeOf<{
        readonly globalActive: number;
        readonly perRootActive: number;
        readonly perRootAdmittedTotal: number;
        readonly perParentChildren: number;
      }>();
    });

    it('declares the snapshot request shapes', () => {
      expectTypeOf<SnapshotGetRequest>().toEqualTypeOf<{
        readonly sessionId: string;
      }>();
      expectTypeOf<SnapshotWatchRequest>().toEqualTypeOf<{
        readonly sessionId: string;
        readonly epoch: string | null;
        readonly revision: number;
        readonly timeoutMs: number;
      }>();
    });

    it('declares a schema-1 snapshot with no arbitrary metadata', () => {
      expect(SNAPSHOT_SCHEMA_VERSION).toBe(1);
      expect(WIRE_SCHEMA_VERSION).toBe(1);
      expect(MAX_HISTORY_EVENTS).toBe(200);

      expectTypeOf<AdmissionSnapshot['schemaVersion']>().toEqualTypeOf<
        typeof SNAPSHOT_SCHEMA_VERSION
      >();
      expectTypeOf<AdmissionSnapshot>().toMatchTypeOf<{
        readonly schemaVersion: 1;
        readonly time: string;
        readonly epoch: string;
        readonly revision: number;
        readonly requestedSessionId: string;
        readonly requestedRootId: string | null;
        readonly mode: AdmissionMode;
        readonly reason: string | null;
        readonly limits: AdmissionLimits;
        readonly usage: AdmissionUsage;
        readonly leases: ReadonlyArray<AdmissionLease>;
        readonly history: ReadonlyArray<AdmissionEvent>;
        readonly droppedHistory: number;
      }>();
      expectTypeOf<AdmissionUsage>().toEqualTypeOf<{
        readonly globalActive: number;
        readonly rootActive: number;
        readonly rootAdmittedTotal: number;
        readonly parentChildren: number;
      }>();
      expectTypeOf<AdmissionLease>().toEqualTypeOf<{
        readonly childSessionId: string;
        readonly parentSessionId: string;
        readonly rootId: string;
        readonly operation: AdmissionOperation;
        readonly mode: AdmissionMode;
        readonly admittedAt: string;
        readonly phase: 'active' | 'draining';
      }>();
      expectTypeOf<AdmissionEvent>().toEqualTypeOf<{
        readonly kind:
          | 'accepted'
          | 'denied'
          | 'released'
          | 'failed-start'
          | 'protocol'
          | 'bootstrap';
        readonly time: string;
        readonly requestId: string | null;
        readonly operation: AdmissionOperation | null;
        readonly rootId: string | null;
        readonly parentSessionId: string | null;
        readonly code: string | null;
      }>();
    });
  });

  describe('protocol-v1 seam', () => {
    it('declares the exact structural request', () => {
      expectTypeOf<SubagentAdmissionRequestV1>().toEqualTypeOf<{
        readonly requestId: string;
        readonly operation: AdmissionOperation;
        readonly provider: string;
        readonly parentSessionId: string;
        readonly childSessionId?: string;
      }>();
    });

    it('declares the exact permit binding and release vocabulary', () => {
      expectTypeOf<
        Parameters<SubagentAdmissionPermitV1['bindChild']>[0]
      >().toEqualTypeOf<{
        readonly childSessionId: string;
        readonly localParentSessionId?: string;
      }>();
      expectTypeOf<
        Parameters<SubagentAdmissionPermitV1['release']>[0]
      >().toEqualTypeOf<
        'completed' | 'aborted' | 'error' | 'startup-failed' | 'disposed'
      >();
      expectTypeOf<
        ReturnType<SubagentAdmissionPermitV1['release']>
      >().toEqualTypeOf<Promise<void>>();
    });

    it('declares the exact policy protocol contract', () => {
      expectTypeOf<
        SubagentAdmissionPolicyV1['protocolVersion']
      >().toEqualTypeOf<1>();
      expectTypeOf<
        ReturnType<SubagentAdmissionPolicyV1['prepare']>
      >().toEqualTypeOf<Promise<SubagentAdmissionPermitV1>>();
    });
  });

  describe('limits', () => {
    const valid: ConfigInput = {
      mode: 'strict',
      globalActive: 8,
      perRootActive: 4,
      perRootAdmittedTotal: 6,
      perParentChildren: 3,
      ownershipPath: '/tmp/admission-owner',
    };

    it('accepts positive safe integer limits', () => {
      expect(() => resolveConfig(valid)).not.toThrow();
      expect(() =>
        resolveConfig({
          globalActive: Number.MAX_SAFE_INTEGER,
          perRootActive: Number.MAX_SAFE_INTEGER,
          perRootAdmittedTotal: Number.MAX_SAFE_INTEGER,
          perParentChildren: Number.MAX_SAFE_INTEGER,
        }),
      ).not.toThrow();
    });

    it('rejects zero, negative, fractional, and unsafe values', () => {
      expect(() =>
        resolveConfig({ ...valid, globalActive: 0 }),
      ).toThrow('globalActive must be a positive safe integer');
      expect(() =>
        resolveConfig({ ...valid, perRootActive: -1 }),
      ).toThrow('perRootActive must be a positive safe integer');
      expect(() =>
        resolveConfig({ ...valid, perRootAdmittedTotal: 1.5 }),
      ).toThrow('perRootAdmittedTotal must be a positive safe integer');
      expect(() =>
        resolveConfig({
          ...valid,
          perParentChildren: Number.MAX_SAFE_INTEGER + 1,
        }),
      ).toThrow('perParentChildren must be a positive safe integer');
    });

    it('rejects perRootActive above globalActive', () => {
      expect(() =>
        resolveConfig({
          mode: 'strict',
          globalActive: 3,
          perRootActive: 4,
          perRootAdmittedTotal: 24,
          perParentChildren: 8,
          ownershipPath: '/tmp/admission-owner',
        }),
      ).toThrow('perRootActive must not exceed globalActive');
    });

    it('rejects perRootActive above perRootAdmittedTotal', () => {
      expect(() =>
        resolveConfig({ ...valid, perRootActive: 7, perRootAdmittedTotal: 6 }),
      ).toThrow('perRootActive must not exceed perRootAdmittedTotal');
    });

    it('rejects perParentChildren above perRootAdmittedTotal', () => {
      expect(() =>
        resolveConfig({ ...valid, perParentChildren: 7 }),
      ).toThrow('perParentChildren must not exceed perRootAdmittedTotal');
    });
  });

  describe('default config', () => {
    it('resolves empty input to the exact defaults', () => {
      expect(DEFAULT_CONFIG).toEqual({
        mode: 'audit',
        globalActive: 6,
        perRootActive: 4,
        perRootAdmittedTotal: 24,
        perParentChildren: 8,
        ownershipPath: 'sessions/.dsh-subagent-admission-owner',
      });
      expect(resolveConfig()).toEqual(DEFAULT_CONFIG);
    });

    it('merges partial input over the defaults', () => {
      const resolved: Config = resolveConfig({
        mode: 'strict',
        perRootActive: 2,
      });
      expect(resolved).toEqual({
        mode: 'strict',
        globalActive: 6,
        perRootActive: 2,
        perRootAdmittedTotal: 24,
        perParentChildren: 8,
        ownershipPath: 'sessions/.dsh-subagent-admission-owner',
      });
    });
  });

  describe('error codes', () => {
    it('exposes exactly eight stable codes', () => {
      expect(Object.keys(ADMISSION_ERROR_CODES).sort()).toEqual(
        [...ERROR_CODE_NAMES].sort(),
      );
      for (const name of ERROR_CODE_NAMES) {
        expect(ADMISSION_ERROR_CODES[name]).toBe(name);
      }
      expect(new Set(Object.values(ADMISSION_ERROR_CODES)).size).toBe(8);
      expectTypeOf<AdmissionErrorCode>().toEqualTypeOf<
        | 'ADMISSION_UNAVAILABLE'
        | 'ADMISSION_CLOSED'
        | 'ADMISSION_STATE_IO'
        | 'ADMISSION_BINDING_CONFLICT'
        | 'ROOT_TOTAL_LIMIT'
        | 'PARENT_CHILD_LIMIT'
        | 'ROOT_ACTIVE_LIMIT'
        | 'GLOBAL_ACTIVE_LIMIT'
      >();
    });
  });

  describe('AdmissionDenied', () => {
    it('is detached, frozen, and exposes only privacy-safe fields', () => {
      const denied = createAdmissionDenied({
        code: 'GLOBAL_ACTIVE_LIMIT',
        operation: 'new-continuable',
        rootId: 'root-1',
        parentId: 'parent-1',
        observedValue: 9,
        limit: 8,
        policyEpoch: 'epoch-1',
        requestId: 'req-1',
      });

      expect(Object.getPrototypeOf(denied)).toBeNull();
      expect(Object.isFrozen(denied)).toBe(true);
      expect(denied).toEqual({
        code: 'GLOBAL_ACTIVE_LIMIT',
        operation: 'new-continuable',
        rootId: 'root-1',
        parentId: 'parent-1',
        observedValue: 9,
        limit: 8,
        policyEpoch: 'epoch-1',
        requestId: 'req-1',
      });
      expect(Object.keys(denied).sort()).toEqual([
        'code',
        'limit',
        'observedValue',
        'operation',
        'parentId',
        'policyEpoch',
        'requestId',
        'rootId',
      ]);

      for (const key of [
        'provider',
        'prompt',
        'message',
        'tool',
        'model',
        'secret',
      ]) {
        expect(key in denied).toBe(false);
        expect(
          (denied as unknown as Record<string, unknown>)[key],
        ).toBeUndefined();
      }
      expect(() => {
        (denied as unknown as { code: string }).code = 'OTHER';
      }).toThrow();
    });

    it('copies only the allowed scalar fields', () => {
      const input = {
        code: 'ADMISSION_CLOSED' as const,
        operation: 'cold-resume' as const,
        rootId: 'root-2',
        parentId: null,
        observedValue: 0,
        limit: 1,
        policyEpoch: 'epoch-2',
        requestId: 'req-2',
        provider: 'sensitive-provider',
        prompt: 'sensitive-prompt',
      };

      const denied: AdmissionDenied = createAdmissionDenied(
        input as unknown as Parameters<typeof createAdmissionDenied>[0],
      );
      input.rootId = 'mutated';

      expect(denied.rootId).toBe('root-2');
      expect(denied.parentId).toBeNull();
      expect(Object.keys(denied).sort()).toEqual([
        'code',
        'limit',
        'observedValue',
        'operation',
        'parentId',
        'policyEpoch',
        'requestId',
        'rootId',
      ]);
    });
  });
});
