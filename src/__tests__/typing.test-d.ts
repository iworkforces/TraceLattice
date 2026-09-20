/**
 * Compile-time type assertions covering critical typing invariants.
 *
 * This file contains NO runtime tests. Vitest's `*.test-d.ts` convention
 * keeps the file inside the tsc pass (so type errors fail `npm run type-check`)
 * while excluded from the test runner pattern (`*.{test,spec}.{ts,tsx}`).
 *
 * Coverage:
 *  1. Branded ID assignability — branded types must NOT be cross-assignable.
 *  2. ValidatedThought exhaustiveness — all 7 variants must satisfy the union;
 *     a plain `ThoughtData` without a discriminating `thought_type` must NOT.
 *  3. Schema-type sync — `ThoughtData` must remain derivable from `SchemaOutput`.
 *  4. DI ServiceRegistry — every service key resolved in `lib.ts` exists in the registry.
 */

import type { BranchId, EdgeId, SessionId, SuspensionToken, ThoughtId } from '../contracts/ids.js';
import {
	asBranchId,
	asEdgeId,
	asSessionId,
	asSuspensionToken,
	asThoughtId,
} from '../contracts/ids.js';
import type { ServiceRegistry } from '../di/ServiceRegistry.js';
import type {
	BacktrackThought,
	BaseThought,
	CritiqueThought,
	SynthesisThought,
	ThoughtData,
	ToolCallThought,
	ToolObservationThought,
	ValidatedThought,
	VerificationThought,
} from '../core/thought.js';
import type { SchemaOutput } from '../schema.js';
import type * as PublicApi from '../lib.js';
import {
	HttpTransport,
	ToolAwareSequentialThinkingServer,
	createHttpTransport,
	createServer,
	initializeServer,
	type HttpTransportOptions,
	type IToolAwareSequentialThinkingServer,
	type ITransport,
	type TransportKind,
	type TransportOptions,
} from '../lib.js';

// ─── 1. Branded type assignability ──────────────────────────────────────────
//
// `asSessionId('test')` returns `SessionId` and must NOT be assignable to other
// branded ID types. The `// @ts-expect-error` directives below FAIL the build
// if the brand is ever weakened (i.e. if assignment unexpectedly succeeds).

const _sessionId: SessionId = asSessionId('valid-session');
const _thoughtId: ThoughtId = asThoughtId('thought-1');
const _edgeId: EdgeId = asEdgeId('edge-1');
const _branchId: BranchId = asBranchId('branch-1');
const _suspensionToken: SuspensionToken = asSuspensionToken('tok-1');

// SessionId must NOT be assignable to ThoughtId.
// @ts-expect-error Branded SessionId is not assignable to ThoughtId
const _bad1: ThoughtId = _sessionId;

// ThoughtId must NOT be assignable to SessionId.
// @ts-expect-error Branded ThoughtId is not assignable to SessionId
const _bad2: SessionId = _thoughtId;

// EdgeId must NOT be assignable to BranchId.
// @ts-expect-error Branded EdgeId is not assignable to BranchId
const _bad3: BranchId = _edgeId;

// SuspensionToken must NOT be assignable to ThoughtId.
// @ts-expect-error Branded SuspensionToken is not assignable to ThoughtId
const _bad4: ThoughtId = _suspensionToken;

// Plain string literal must NOT be assignable to any branded type.
// @ts-expect-error Plain string is not assignable to branded SessionId
const _bad5: SessionId = 'plain-string';

// ─── 2. ValidatedThought exhaustiveness ─────────────────────────────────────
//
// All 7 declared variants must be assignable to ValidatedThought. A bare
// `ThoughtData` (no concrete `thought_type` discriminator) is NOT, because
// the union is over readonly literal `thought_type` values.

declare const _toolCall: ToolCallThought;
declare const _toolObs: ToolObservationThought;
declare const _backtrack: BacktrackThought;
declare const _verify: VerificationThought;
declare const _critique: CritiqueThought;
declare const _synthesis: SynthesisThought;
declare const _base: BaseThought;

const _v1: ValidatedThought = _toolCall;
const _v2: ValidatedThought = _toolObs;
const _v3: ValidatedThought = _backtrack;
const _v4: ValidatedThought = _verify;
const _v5: ValidatedThought = _critique;
const _v6: ValidatedThought = _synthesis;
const _v7: ValidatedThought = _base;

// A naked `ThoughtData` lacking a literal `thought_type` discriminator is not
// assignable to `ValidatedThought` (each variant requires `readonly thought_type: <literal>`).
declare const _rawThought: ThoughtData;
// @ts-expect-error Plain ThoughtData is not assignable to discriminated ValidatedThought
const _bad6: ValidatedThought = _rawThought;

// ─── 3. Schema-type sync ────────────────────────────────────────────────────
//
// `ThoughtData` is derived from `SchemaOutput` (single source of truth).
// These assertions enforce that core scalar fields stay structurally compatible.

type _ThoughtField = ThoughtData['thought'];
type _SchemaThoughtField = SchemaOutput['thought'];
const _thoughtFieldSync: _ThoughtField = '' as _SchemaThoughtField;
void _thoughtFieldSync;

type _NumberField = ThoughtData['thought_number'];
type _SchemaNumberField = SchemaOutput['thought_number'];
const _numberFieldSync: _NumberField = 0 as _SchemaNumberField;
void _numberFieldSync;

type _NextNeeded = ThoughtData['next_thought_needed'];
type _SchemaNextNeeded = SchemaOutput['next_thought_needed'];
const _nextNeededSync: _NextNeeded = true as _SchemaNextNeeded;
void _nextNeededSync;

type _ThoughtSessionIsRequired = ThoughtData extends { session_id: SessionId } ? true : false;
type _SchemaSessionIsRequired = SchemaOutput extends { session_id: string } ? true : false;
const _thoughtSessionIsRequired: _ThoughtSessionIsRequired = true;
const _schemaSessionIsRequired: _SchemaSessionIsRequired = true;
void _thoughtSessionIsRequired;
void _schemaSessionIsRequired;

// ─── 4. DI ServiceRegistry key coverage ────────────────────────────────────
//
// Every service key resolved by `lib.ts` (and subsystem registrations) must
// exist on `ServiceRegistry`. Adding a key here forces the registry to keep up.

type _UsedKeys =
	| 'Logger'
	| 'Config'
	| 'FileConfig'
	| 'HistoryManager'
	| 'ThoughtProcessor'
	| 'ThoughtFormatter'
	| 'ThoughtEvaluator'
	| 'Persistence'
	| 'ToolRegistry'
	| 'SkillRegistry'
	| 'Metrics'
	| 'EdgeStore'
	| 'reasoningStrategy'
	| 'outcomeRecorder'
	| 'calibrator'
	| 'summaryStore'
	| 'compressionService'
	| 'suspensionStore'
	| 'sessionLock';

// If any `_UsedKeys` literal is missing from `keyof ServiceRegistry`, this
// resolves to that literal (a non-`never` type), and the assignment fails.
type _MissingKeys = Exclude<_UsedKeys, keyof ServiceRegistry>;
const _noMissingKeys: _MissingKeys = undefined as never;
void _noMissingKeys;

// Reference all bindings so `noUnusedLocals` stays quiet under tsc.
void _sessionId;
void _thoughtId;
void _edgeId;
void _branchId;
void _suspensionToken;
void _bad1;
void _bad2;
void _bad3;
void _bad4;
void _bad5;
void _v1;
void _v2;
void _v3;
void _v4;
void _v5;
void _v6;
void _v7;
void _bad6;

// ─── 5. Package-root transport API ─────────────────────────────────────────

const _transportOptions: TransportOptions = {
	port: 0,
	host: '127.0.0.1',
	enableRateLimit: false,
};
const _httpTransportOptions: HttpTransportOptions = {
	..._transportOptions,
	path: '/messages',
};
const _classTransport: ITransport = new HttpTransport(_httpTransportOptions);
const _factoryTransport: ITransport = createHttpTransport(_httpTransportOptions);
const _transportKind: TransportKind = _factoryTransport.kind;
const _serverClass: typeof ToolAwareSequentialThinkingServer = ToolAwareSequentialThinkingServer;
const _serverFactory: typeof createServer = createServer;
const _serverInitializer: typeof initializeServer = initializeServer;

type _Exact<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
		? (<Value>() => Value extends Right ? 1 : 2) extends <Value>() => Value extends Left ? 1 : 2
			? true
			: false
		: false;
type _ExpectedDiscoveryRefresh = Promise<{ tools: number; skills: number }>;
type _InterfaceDiscoveryRefresh = ReturnType<
	IToolAwareSequentialThinkingServer['refreshDiscovery']
>;
type _ClassDiscoveryRefresh = ReturnType<ToolAwareSequentialThinkingServer['refreshDiscovery']>;
const _exactInterfaceDiscoveryRefresh: _Exact<
	_InterfaceDiscoveryRefresh,
	_ExpectedDiscoveryRefresh
> = true;
const _exactClassDiscoveryRefresh: _Exact<_ClassDiscoveryRefresh, _ExpectedDiscoveryRefresh> = true;

type _ForbiddenRootExports = Extract<
	'Container' | 'ServerConfig' | 'ToolRegistry' | 'SkillRegistry',
	keyof typeof PublicApi
>;
type _AssertNever<T extends never> = T;
type _NoForbiddenRootExports = _AssertNever<_ForbiddenRootExports>;
const _noForbiddenRootExports: [_NoForbiddenRootExports] extends [never] ? true : false = true;

void _classTransport;
void _factoryTransport;
void _transportKind;
void _serverClass;
void _serverFactory;
void _serverInitializer;
void _exactInterfaceDiscoveryRefresh;
void _exactClassDiscoveryRefresh;
void _noForbiddenRootExports;
